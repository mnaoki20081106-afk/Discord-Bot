/**
 * VPS の中継プログラム（apps/gateway-relay/relay.mjs）から Discord Gateway のイベントを受け取る。
 *
 * Main Bot は Cloudflare の Durable Objects で Gateway に常時接続していたが、
 * 無料枠（1日 13,000 GB秒）は Security Bot の常時接続1本でほぼ埋まるため、
 * Main Bot の常時接続は VPS 上の中継プログラムに任せる。
 *
 * 認証: 中継側と Worker 側の両方が持っている BOT トークンから鍵を作り、
 *       「時刻.本文」の HMAC-SHA256 で署名する（新しい共有シークレットを配らずに済む）。
 */
import type { Env } from "./types";
import { handleMemberActivityGatewayEvent, memberActivitySweep } from "./member-activity";
import {
  deleteBotGuildCache,
  forgetBotGuildMembership,
  rememberBotGuildMembership,
  replaceBotGuildMembership,
  upsertBotGuildCache
} from "./db";
import { checkChannelIdsForRelay, deleteCheckChannelMessage } from "./mediation";

const MAX_SKEW_MS = 5 * 60_000;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
}

async function relayKey(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("gateway-relay:" + env.DISCORD_BOT_TOKEN.trim())
  );
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function setFlag(env: Env, key: string, value: string) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS worker_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO worker_flags(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
  ).bind(key, value, Date.now()).run();
}

export async function gatewayRelayLastSeen(env: Env): Promise<number | null> {
  try {
    const row = await env.DB.prepare("SELECT updated_at FROM worker_flags WHERE key='gateway_relay_last_seen'")
      .first<{ updated_at: number }>();
    return row?.updated_at ?? null;
  } catch {
    return null;
  }
}

async function dispatch(env: Env, t: string, d: any): Promise<void> {
  switch (t) {
    case "RELAY_HEARTBEAT":
      await setFlag(env, "gateway_relay_last_seen", String(d?.version ?? ""));
      return;
    case "READY": {
      const guildIds = (Array.isArray(d?.guilds) ? d.guilds : [])
        .map((guild: any) => String(guild?.id ?? ""))
        .filter((id: string) => /^\d+$/.test(id));
      await replaceBotGuildMembership(env, guildIds);
      await setFlag(env, "gateway_relay_last_seen", "ready");
      // 新しい接続は切れていた間のイベントを再送しないので、一度見比べて取りこぼしを拾う
      await memberActivitySweep(env);
      return;
    }
    case "GUILD_CREATE":
      if (d?.id) await rememberBotGuildMembership(env, String(d.id));
      if (d?.id && d?.name) {
        await upsertBotGuildCache(env, { id: String(d.id), name: String(d.name), icon: d.icon ?? null });
      }
      return;
    case "GUILD_DELETE":
      // unavailable=true は Discord 側の一時障害で、BOT が外されたわけではない
      if (d?.id && !d?.unavailable) {
        await Promise.all([
          deleteBotGuildCache(env, String(d.id)),
          forgetBotGuildMembership(env, String(d.id))
        ]);
      }
      return;
    case "GUILD_MEMBER_ADD":
      await handleMemberActivityGatewayEvent(env, "join", d);
      return;
    case "GUILD_MEMBER_REMOVE":
      await handleMemberActivityGatewayEvent(env, "leave", d);
      return;
    case "CHECK_CHANNEL_MESSAGE":
      // /check 用チャンネルへの投稿。中継は設定されたチャンネルの分だけ送ってくる
      await deleteCheckChannelMessage(env, {
        guildId: String(d?.guild_id ?? ""),
        channelId: String(d?.channel_id ?? ""),
        messageId: String(d?.id ?? ""),
        authorId: String(d?.author_id ?? "")
      });
      return;
  }
}

export async function handleGatewayRelay(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/internal/gateway-relay") return null;
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const timestamp = request.headers.get("X-Relay-Timestamp") ?? "";
  const signature = (request.headers.get("X-Relay-Signature") ?? "").toLowerCase();
  const body = await request.text();
  const ts = Number(timestamp);
  if (!/^\d{12,14}$/.test(timestamp) || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return Response.json({ ok: false, error: "stale_or_missing_timestamp" }, { status: 401 });
  }
  const expected = hex(await crypto.subtle.sign("HMAC", await relayKey(env), new TextEncoder().encode(`${timestamp}.${body}`)));
  if (!sameHex(expected, signature)) {
    return Response.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let payload: { t?: string; d?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (typeof payload.t !== "string") return Response.json({ ok: false, error: "missing_event" }, { status: 400 });

  try {
    await dispatch(env, payload.t, payload.d);
  } catch (error) {
    console.error("gateway relay event failed", payload.t, error);
    // 500 を返すと中継側が再送する（入退室は記録済みかどうかを見て二重通知しない）
    return Response.json({ ok: false, error: "handler_failed" }, { status: 500 });
  }
  // 中継が「どのチャンネルの投稿を送ればよいか」を覚えられるよう、定期連絡と接続時に設定を返す
  if (payload.t === "RELAY_HEARTBEAT" || payload.t === "READY") {
    const checkChannels = await checkChannelIdsForRelay(env).catch(() => null);
    return Response.json({ ok: true, config: checkChannels ? { checkChannels } : undefined });
  }
  return Response.json({ ok: true });
}
