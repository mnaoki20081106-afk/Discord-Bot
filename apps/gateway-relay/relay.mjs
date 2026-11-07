#!/usr/bin/env node
/**
 * Discord Gateway 中継（VPS で常時動かす）
 *
 * Main Bot の Discord Gateway に常時接続し、必要なイベントだけを
 * Cloudflare Worker（/internal/gateway-relay）へ署名付きで転送する。
 * Cloudflare の Durable Objects 無料枠を Security Bot に譲るためのもの。
 *
 * 依存パッケージなし（Node.js 22 以上の組み込み WebSocket / fetch / crypto を使う）。
 *
 * 環境変数:
 *   DISCORD_BOT_TOKEN  Main Bot のトークン（Worker の DISCORD_BOT_TOKEN と同じもの）
 *   RELAY_URL          例: https://discord-bot.example.workers.dev/internal/gateway-relay
 */
import { createHash, createHmac } from "node:crypto";

const VERSION = "2";
const TOKEN = (process.env.DISCORD_BOT_TOKEN ?? "").trim();
const RELAY_URL = (process.env.RELAY_URL ?? "").trim();
// テスト用に差し替えられるようにしているだけ。本番では指定しない
const API_BASE = (process.env.DISCORD_API_BASE ?? "https://discord.com/api/v10").replace(/\/$/, "");
// GUILDS + GUILD_MEMBERS + GUILD_MESSAGES。
// GUILD_MESSAGES は /check 用チャンネルへの投稿をすぐ消すため。本文は読まないので Message Content Intent は不要
const INTENTS = (1 << 0) | (1 << 1) | (1 << 9);
const FORWARD = new Set(["READY", "GUILD_CREATE", "GUILD_DELETE", "GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE"]);
const HEARTBEAT_TO_WORKER_MS = 60_000;
const MAX_QUEUE = 2000;

if (!TOKEN || !RELAY_URL) {
  console.error("DISCORD_BOT_TOKEN と RELAY_URL を設定してください");
  process.exit(2);
}
if (typeof globalThis.WebSocket !== "function") {
  console.error("Node.js 22 以上が必要です（組み込みの WebSocket を使います）。node -v:", process.version);
  process.exit(2);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- Worker への転送（順番を保って再送する） --------------------------------------
const key = createHash("sha256").update("gateway-relay:" + TOKEN).digest();
const queue = [];
let draining = false;
// Worker から教えてもらう「/check 用チャンネル」。この中の投稿だけを転送する
let checkChannels = new Set();
let botUserId = null;

function applyConfig(text) {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.config?.checkChannels)) {
      const next = new Set(data.config.checkChannels.map(String));
      if (next.size !== checkChannels.size || [...next].some(id => !checkChannels.has(id))) {
        log(`/check 用チャンネル: ${next.size} 件`);
      }
      checkChannels = next;
    }
  } catch {
    // 設定が付いていない応答は無視する
  }
}

function sign(timestamp, body) {
  return createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
}

function enqueue(t, d) {
  if (queue.length >= MAX_QUEUE) {
    log("転送待ちが多すぎるため古いイベントを捨てます（Worker 側の1分ごとの見比べで補われます）");
    queue.shift();
  }
  queue.push({ t, d });
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    let backoff = 1_000;
    while (queue.length) {
      const item = queue[0];
      const body = JSON.stringify(item);
      const timestamp = String(Date.now());
      try {
        const response = await fetch(RELAY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Relay-Timestamp": timestamp,
            "X-Relay-Signature": sign(timestamp, body)
          },
          body,
          signal: AbortSignal.timeout(20_000)
        });
        if (response.status === 401) {
          // 署名が合わない＝トークンが Worker と違う。再送しても通らないので捨てる
          log("Worker に拒否されました（401）。DISCORD_BOT_TOKEN が Worker と同じか確認してください", item.t);
          queue.shift();
          continue;
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        if (item.t === "RELAY_HEARTBEAT" || item.t === "READY") applyConfig(await response.text());
        queue.shift();
        backoff = 1_000;
      } catch (error) {
        log("Worker への転送に失敗。再試行します:", item.t, String(error?.message ?? error));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  } finally {
    draining = false;
  }
}

setInterval(() => enqueue("RELAY_HEARTBEAT", { version: VERSION }), HEARTBEAT_TO_WORKER_MS).unref();
// 起動直後に一度連絡して、/check 用チャンネルの設定を受け取っておく
enqueue("RELAY_HEARTBEAT", { version: VERSION });

// ---- Discord Gateway --------------------------------------------------------------
let ws = null;
let sequence = null;
let sessionId = null;
let resumeUrl = null;
let heartbeatTimer = null;
let heartbeatAcked = true;
let reconnectDelay = 1_000;

async function gatewayUrl() {
  const response = await fetch(API_BASE + "/gateway/bot", {
    headers: { Authorization: "Bot " + TOKEN },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 401) {
    log("BOT トークンが正しくありません（401）。停止します");
    process.exit(3);
  }
  if (!response.ok) throw new Error("gateway/bot HTTP " + response.status);
  const data = await response.json();
  return data.url;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat(interval) {
  stopHeartbeat();
  heartbeatAcked = true;
  const beat = () => {
    if (!heartbeatAcked) {
      log("Heartbeat の応答がないため再接続します");
      try { ws?.close(4000, "heartbeat timeout"); } catch {}
      return;
    }
    heartbeatAcked = false;
    send({ op: 1, d: sequence });
  };
  setTimeout(beat, Math.floor(interval * Math.random()));
  heartbeatTimer = setInterval(beat, interval);
}

async function connect() {
  const canResume = Boolean(sessionId && resumeUrl);
  let base;
  try {
    base = canResume ? resumeUrl : await gatewayUrl();
  } catch (error) {
    log("Gateway URL の取得に失敗:", String(error?.message ?? error));
    return scheduleReconnect();
  }
  const url = new URL(base);
  url.searchParams.set("v", "10");
  url.searchParams.set("encoding", "json");
  log(canResume ? "再開（RESUME）で接続します" : "新しく接続します");
  ws = new WebSocket(url.toString());

  ws.addEventListener("message", event => {
    let payload;
    try { payload = JSON.parse(String(event.data)); } catch { return; }
    if (payload.s !== null && payload.s !== undefined) sequence = payload.s;
    switch (payload.op) {
      case 10: // HELLO
        startHeartbeat(payload.d.heartbeat_interval);
        if (canResume) {
          send({ op: 6, d: { token: TOKEN, session_id: sessionId, seq: sequence } });
        } else {
          send({
            op: 2,
            d: {
              token: TOKEN,
              intents: INTENTS,
              properties: { os: "linux", browser: "dsm-gateway-relay", device: "dsm-gateway-relay" }
            }
          });
        }
        break;
      case 11: // HEARTBEAT ACK
        heartbeatAcked = true;
        break;
      case 1: // サーバーからの即時 heartbeat 要求
        send({ op: 1, d: sequence });
        break;
      case 7: // RECONNECT
        log("Discord から再接続の指示");
        try { ws.close(4000, "reconnect requested"); } catch {}
        break;
      case 9: // INVALID SESSION
        log("セッションが無効になりました。", payload.d ? "再開を試みます" : "新しく接続し直します");
        if (!payload.d) { sessionId = null; resumeUrl = null; sequence = null; }
        setTimeout(() => { try { ws.close(4000, "invalid session"); } catch {} }, 1_000 + Math.random() * 4_000);
        break;
      case 0: // DISPATCH
        if (payload.t === "READY") {
          botUserId = payload.d.user?.id ?? null;
          sessionId = payload.d.session_id;
          resumeUrl = payload.d.resume_gateway_url;
          reconnectDelay = 1_000;
          log(`接続しました: ${payload.d.user?.username ?? "bot"}（サーバー ${payload.d.guilds?.length ?? 0} 件）`);
          enqueue("READY", { guilds: (payload.d.guilds ?? []).map(g => ({ id: g.id })) });
          break;
        }
        if (payload.t === "RESUMED") {
          reconnectDelay = 1_000;
          log("再開しました");
          break;
        }
        if (payload.t === "MESSAGE_CREATE") {
          const m = payload.d;
          // /check 用チャンネルの投稿だけを、ID だけにして送る（本文は送らない）
          if (m?.guild_id && checkChannels.has(String(m.channel_id)) && m.author?.id !== botUserId) {
            enqueue("CHECK_CHANNEL_MESSAGE", { guild_id: m.guild_id, channel_id: m.channel_id, id: m.id, author_id: m.author?.id ?? null });
          }
          break;
        }
        if (FORWARD.has(payload.t)) {
          const d = payload.t === "GUILD_CREATE"
            // GUILD_CREATE は大きいので、Worker が使う項目だけ送る
            ? { id: payload.d.id, name: payload.d.name, icon: payload.d.icon ?? null }
            : payload.d;
          enqueue(payload.t, d);
        }
        break;
    }
  });

  ws.addEventListener("close", event => {
    stopHeartbeat();
    const code = event.code;
    if (code === 4004) {
      log("認証に失敗しました（4004）。BOT トークンを確認してください。停止します");
      process.exit(3);
    }
    if (code === 4013 || code === 4014) {
      log(`Intent が許可されていません（${code}）。Developer Portal で Server Members Intent を ON にしてください。停止します`);
      process.exit(4);
    }
    if (code === 4007 || code === 4009) { sessionId = null; resumeUrl = null; sequence = null; }
    log(`切断されました（${code}）`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // close イベントで再接続する
  });
}

let reconnectPending = false;
function scheduleReconnect() {
  if (reconnectPending) return;
  reconnectPending = true;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  setTimeout(() => {
    reconnectPending = false;
    void connect();
  }, delay);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("終了します");
    try { ws?.close(1000, "shutdown"); } catch {}
    setTimeout(() => process.exit(0), 500);
  });
}

void connect();
