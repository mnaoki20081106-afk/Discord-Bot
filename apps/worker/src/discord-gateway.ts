import type { Env } from "./types";
import {
  handleMemberActivityGatewayEvent,
  hasEnabledMemberActivity,
  memberActivitySweep
} from "./member-activity";

type StoredGatewayState = {
  sessionId: string | null;
  sequence: number | null;
  resumeUrl: string | null;
  heartbeatInterval: number | null;
  lastHeartbeatSent: number | null;
  lastHeartbeatAck: number | null;
  reconnectAttempts: number;
};

type GatewayPayload = {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
};

const STATE_KEY = "discord_gateway_state";
const GATEWAY_VERSION = 10;
const GATEWAY_INTENTS = (1 << 0) | (1 << 1); // GUILDS + GUILD_MEMBERS
const RECONNECT_CLOSE_CODE = 3001;

function emptyState(): StoredGatewayState {
  return {
    sessionId: null,
    sequence: null,
    resumeUrl: null,
    heartbeatInterval: null,
    lastHeartbeatSent: null,
    lastHeartbeatAck: null,
    reconnectAttempts: 0
  };
}

function websocketUpgradeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.searchParams.set("v", String(GATEWAY_VERSION));
  url.searchParams.set("encoding", "json");
  return url.toString();
}

function closeNeedsFreshSession(code: number): boolean {
  return code === 4007 || code === 4009;
}

function isFatalGatewayClose(code: number): boolean {
  return [4004, 4010, 4011, 4012, 4013, 4014].includes(code);
}

export async function ensureDiscordGateway(env: Env): Promise<void> {
  if (!env.DISCORD_GATEWAY) return;

  const enabled = await hasEnabledMemberActivity(env);
  const id = env.DISCORD_GATEWAY.idFromName("member-activity");
  const stub = env.DISCORD_GATEWAY.get(id);
  const response = await stub.fetch(
    `https://discord-gateway.internal/${enabled ? "start" : "stop"}`,
    { method: "POST" }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Discord Gateway の起動確認に失敗しました: ${response.status} ${detail}`);
  }
}

export class DiscordGateway {
  private socket: WebSocket | null = null;
  private plannedClose = false;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (path === "/start") {
      await this.start();
      return Response.json({ ok: true });
    }

    if (path === "/stop") {
      await this.stop();
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      const enabled = await hasEnabledMemberActivity(this.env);
      if (!enabled) {
        await this.stop();
        return;
      }

      if (!this.socket) {
        await this.connect();
        return;
      }

      const stored = await this.loadState();
      if (!stored.heartbeatInterval) {
        await this.state.storage.setAlarm(Date.now() + 5_000);
        return;
      }

      if (
        stored.lastHeartbeatSent !== null &&
        (stored.lastHeartbeatAck === null ||
          stored.lastHeartbeatAck < stored.lastHeartbeatSent)
      ) {
        console.warn("discord gateway heartbeat ACK missing; reconnecting");
        await this.scheduleReconnect(false);
        return;
      }

      this.sendHeartbeat(stored);
      stored.lastHeartbeatSent = Date.now();
      await this.saveState(stored);
      await this.state.storage.setAlarm(
        Date.now() + Math.max(1_000, stored.heartbeatInterval)
      );
    } catch (error) {
      console.error("discord gateway alarm failed", error);
      await this.state.storage.setAlarm(Date.now() + 15_000);
    }
  }

  private async start(): Promise<void> {
    if (this.socket) return;
    await this.connect();
  }

  private async stop(): Promise<void> {
    await this.state.storage.deleteAlarm();
    if (this.socket) {
      this.plannedClose = true;
      try {
        this.socket.close(1000, "member activity disabled");
      } catch {
        // Already closed.
      }
      this.socket = null;
    }
    await this.state.storage.delete(STATE_KEY);
  }

  private async loadState(): Promise<StoredGatewayState> {
    return (
      (await this.state.storage.get<StoredGatewayState>(STATE_KEY)) ??
      emptyState()
    );
  }

  private async saveState(value: StoredGatewayState): Promise<void> {
    await this.state.storage.put(STATE_KEY, value);
  }

  private async gatewayUrl(): Promise<string> {
    const response = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: {
        Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`
      }
    });

    if (!response.ok) {
      throw new Error(
        `Discord Gateway URL取得失敗: ${response.status} ${await response.text()}`
      );
    }

    const data = (await response.json()) as { url?: string };
    if (!data.url) throw new Error("Discord Gateway URLが空です");
    return data.url;
  }

  private async connect(): Promise<void> {
    if (this.socket) return;

    const stored = await this.loadState();
    const canResume =
      Boolean(stored.sessionId) &&
      stored.sequence !== null &&
      Boolean(stored.resumeUrl);

    let baseUrl: string;
    try {
      baseUrl = canResume ? stored.resumeUrl! : await this.gatewayUrl();
    } catch (error) {
      console.error("discord gateway URL resolution failed", error);
      await this.scheduleReconnect(false);
      return;
    }

    let response: Response;
    try {
      response = await fetch(websocketUpgradeUrl(baseUrl), {
        headers: { Upgrade: "websocket" }
      });
    } catch (error) {
      console.error("discord gateway websocket upgrade failed", error);
      await this.scheduleReconnect(false);
      return;
    }

    if (!response.webSocket) {
      console.error("discord gateway websocket missing", response.status);
      await this.scheduleReconnect(false);
      return;
    }

    const socket = response.webSocket;
    socket.accept();
    this.socket = socket;
    this.plannedClose = false;

    socket.addEventListener("message", event => {
      if (this.socket !== socket) return;
      this.messageQueue = this.messageQueue
        .then(() => this.handleMessage(String(event.data)))
        .catch(error => {
          console.error("discord gateway message failed", error);
        });
    });

    socket.addEventListener("close", event => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.plannedClose) {
        this.plannedClose = false;
        return;
      }

      const clearSession = closeNeedsFreshSession(event.code);
      const delay = isFatalGatewayClose(event.code) ? 60_000 : undefined;
      void this.scheduleReconnect(clearSession, delay);
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.plannedClose) return;
      void this.scheduleReconnect(false);
    });

    await this.state.storage.setAlarm(Date.now() + 10_000);
  }

  private async scheduleReconnect(
    clearSession: boolean,
    forcedDelay?: number
  ): Promise<void> {
    const stored = await this.loadState();
    stored.reconnectAttempts += 1;
    stored.heartbeatInterval = null;
    stored.lastHeartbeatSent = null;
    stored.lastHeartbeatAck = null;

    if (clearSession) {
      stored.sessionId = null;
      stored.sequence = null;
      stored.resumeUrl = null;
    }

    await this.saveState(stored);

    if (this.socket) {
      this.plannedClose = true;
      try {
        this.socket.close(RECONNECT_CLOSE_CODE, "reconnect");
      } catch {
        // Already closed.
      }
      this.socket = null;
    }

    const delay =
      forcedDelay ??
      Math.min(60_000, 1_000 * 2 ** Math.min(stored.reconnectAttempts, 5));

    await this.state.storage.setAlarm(Date.now() + delay);
  }

  private async handleMessage(raw: string): Promise<void> {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      return;
    }

    const stored = await this.loadState();
    if (payload.s !== undefined && payload.s !== null) {
      stored.sequence = payload.s;
      await this.saveState(stored);
    }

    switch (payload.op) {
      case 10: {
        const hello = payload.d as { heartbeat_interval?: number };
        if (!hello?.heartbeat_interval) {
          await this.scheduleReconnect(false);
          return;
        }
        stored.heartbeatInterval = hello.heartbeat_interval;
        stored.lastHeartbeatAck = Date.now();
        stored.lastHeartbeatSent = null;
        await this.saveState(stored);
        await this.identifyOrResume(stored);
        const firstDelay = Math.max(
          1_000,
          Math.floor(hello.heartbeat_interval * Math.random())
        );
        await this.state.storage.setAlarm(Date.now() + firstDelay);
        return;
      }

      case 11:
        stored.lastHeartbeatAck = Date.now();
        await this.saveState(stored);
        return;

      case 1:
        this.sendHeartbeat(stored);
        return;

      case 7:
        await this.scheduleReconnect(false, 1_000);
        return;

      case 9: {
        const resumable = payload.d === true;
        await this.scheduleReconnect(!resumable, 1_000 + Math.random() * 4_000);
        return;
      }

      case 0:
        await this.handleDispatch(payload, stored);
        return;
    }
  }

  private async identifyOrResume(stored: StoredGatewayState): Promise<void> {
    if (!this.socket) return;

    if (
      stored.sessionId &&
      stored.sequence !== null &&
      stored.resumeUrl
    ) {
      this.socket.send(
        JSON.stringify({
          op: 6,
          d: {
            token: this.env.DISCORD_BOT_TOKEN,
            session_id: stored.sessionId,
            seq: stored.sequence
          }
        })
      );
      return;
    }

    this.socket.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          intents: GATEWAY_INTENTS,
          properties: {
            os: "cloudflare",
            browser: "discord-member-activity",
            device: "discord-member-activity"
          }
        }
      })
    );
  }

  private sendHeartbeat(stored: StoredGatewayState): void {
    if (!this.socket) return;
    this.socket.send(
      JSON.stringify({
        op: 1,
        d: stored.sequence
      })
    );
  }

  private async handleDispatch(
    payload: GatewayPayload,
    stored: StoredGatewayState
  ): Promise<void> {
    if (payload.t === "READY") {
      const ready = payload.d as {
        session_id?: string;
        resume_gateway_url?: string;
      };
      stored.sessionId = ready.session_id ?? null;
      stored.resumeUrl = ready.resume_gateway_url ?? stored.resumeUrl;
      stored.reconnectAttempts = 0;
      await this.saveState(stored);

      // A fresh Identify cannot replay events from before the connection.
      // Reconcile once here, then all subsequent notifications are Gateway-driven.
      await memberActivitySweep(this.env);
      return;
    }

    if (payload.t === "RESUMED") {
      stored.reconnectAttempts = 0;
      await this.saveState(stored);
      return;
    }

    if (payload.t === "GUILD_MEMBER_ADD") {
      await handleMemberActivityGatewayEvent(
        this.env,
        "join",
        payload.d as never
      );
      return;
    }

    if (payload.t === "GUILD_MEMBER_REMOVE") {
      await handleMemberActivityGatewayEvent(
        this.env,
        "leave",
        payload.d as never
      );
    }
  }
}
