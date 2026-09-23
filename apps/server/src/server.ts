import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField
} from "discord.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { client, invalidateSettings, startBot } from "./bot.js";
import { env, payPayConfigured } from "./config.js";
import { encrypt, hashToken, randomToken, secureEqual } from "./crypto.js";
import {
  cleanExpiredAuth,
  consumeOAuthState,
  createProduct,
  createSession,
  deleteProduct,
  deleteSession,
  getGuildSettings,
  getProduct,
  getSession,
  listProducts,
  migrate,
  putOAuthState,
  saveGuildSettings,
  type WebSession
} from "./db.js";
import {
  authorizeUrl,
  exchangeCode,
  fetchDiscordGuilds,
  fetchDiscordUser,
  getValidAccessToken,
  type DiscordGuild
} from "./discord-oauth.js";
import { applyGuildTemplate, type TemplateName } from "./templates.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: env.WEB_ORIGIN,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"]
});
await app.register(rateLimit, {
  max: 180,
  timeWindow: "1 minute"
});

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function sessionFromRequest(request: FastifyRequest): Promise<WebSession> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw httpError(401, "ログインが必要です");
  const rawToken = authorization.slice("Bearer ".length).trim();
  const session = await getSession(hashToken(rawToken));
  if (!session) throw httpError(401, "セッションが失効しています");
  return session;
}

function hasManageGuild(guild: DiscordGuild): boolean {
  const permissions = BigInt(guild.permissions);
  const administrator = (permissions & 0x8n) === 0x8n;
  const manageGuild = (permissions & 0x20n) === 0x20n;
  return guild.owner || administrator || manageGuild;
}

async function manageableGuilds(session: WebSession): Promise<DiscordGuild[]> {
  const accessToken = await getValidAccessToken(session);
  const guilds = await fetchDiscordGuilds(accessToken);
  return guilds.filter(hasManageGuild);
}

async function requireGuildAccess(
  request: FastifyRequest,
  guildId: string,
  requireBot = true
): Promise<{ session: WebSession; oauthGuild: DiscordGuild }> {
  const session = await sessionFromRequest(request);
  const oauthGuild = (await manageableGuilds(session)).find((guild) => guild.id === guildId);
  if (!oauthGuild) throw httpError(403, "このサーバーを管理する権限がありません");
  if (requireBot && !client.guilds.cache.has(guildId)) {
    throw httpError(409, "先にBOTをサーバーへ追加してください");
  }
  return { session, oauthGuild };
}

const settingsPatchSchema = z.object({
  securityEnabled: z.boolean(),
  antiSpam: z.boolean(),
  spamMax: z.number().int().min(2).max(50),
  spamWindowSeconds: z.number().int().min(2).max(120),
  blockInvites: z.boolean(),
  mentionLimit: z.number().int().min(2).max(50),
  antiRaid: z.boolean(),
  raidJoins: z.number().int().min(3).max(100),
  raidWindowSeconds: z.number().int().min(5).max(300),
  antiNuke: z.boolean(),
  nukeActions: z.number().int().min(2).max(30),
  nukeWindowSeconds: z.number().int().min(5).max(300),
  logChannelId: z.string().nullable(),
  verifiedRoleId: z.string().nullable(),
  minAccountAgeDays: z.number().int().min(0).max(365),
  trustedUserIds: z.array(z.string()).max(100),
  trustedRoleIds: z.array(z.string()).max(100)
}).partial();

const productSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  priceYen: z.number().int().min(1).max(1_000_000),
  deliveryType: z.enum(["role", "text"]),
  roleId: z.string().nullable().optional(),
  deliveryText: z.string().max(4000).nullable().optional()
}).superRefine((value, context) => {
  if (value.deliveryType === "role" && !value.roleId) {
    context.addIssue({ code: "custom", message: "ロール商品にはroleIdが必要です" });
  }
  if (value.deliveryType === "text" && !value.deliveryText) {
    context.addIssue({ code: "custom", message: "テキスト商品には納品内容が必要です" });
  }
});

const channelSchema = z.object({ channelId: z.string().min(1) });

const botPermissionBits = new PermissionsBitField([
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.AttachFiles,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ManageMessages,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.ViewAuditLog
]).bitfield.toString();

app.get("/health", async () => ({
  ok: true,
  discordReady: client.isReady(),
  payPayConfigured
}));

app.get("/api/status", async () => ({
  discordReady: client.isReady(),
  payPayConfigured,
  payPayEnvironment: env.PAYPAY_ENV
}));

app.get("/auth/discord", async (_request, reply) => {
  const state = randomToken(24);
  await putOAuthState(state);
  const secure = env.API_PUBLIC_URL.startsWith("https://");
  reply.header(
    "set-cookie",
    `dsm_oauth_state=${encodeURIComponent(state)}; Path=/auth/discord; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`
  );
  return reply.redirect(authorizeUrl(state));
});

app.get("/auth/discord/callback", async (request, reply) => {
  const query = z.object({
    code: z.string().min(1),
    state: z.string().min(1)
  }).parse(request.query);

  const cookieState = parseCookie(request.headers.cookie, "dsm_oauth_state");
  if (!cookieState || !secureEqual(cookieState, query.state)) {
    throw httpError(400, "OAuth state mismatch");
  }
  if (!(await consumeOAuthState(query.state))) {
    throw httpError(400, "OAuth state expired");
  }

  const tokens = await exchangeCode(query.code);
  const user = await fetchDiscordUser(tokens.access_token);
  const rawSession = randomToken(32);
  const now = Date.now();

  await createSession({
    token_hash: hashToken(rawSession),
    user_id: user.id,
    username: user.global_name || user.username,
    avatar: user.avatar ?? null,
    access_token_enc: encrypt(tokens.access_token),
    refresh_token_enc: encrypt(tokens.refresh_token),
    token_expires_at: new Date(now + tokens.expires_in * 1000),
    expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000)
  });

  reply.header(
    "set-cookie",
    "dsm_oauth_state=; Path=/auth/discord; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  return reply.redirect(
    `${env.WEB_ORIGIN.replace(/\/$/, "")}/#session=${encodeURIComponent(rawSession)}`
  );
});

app.post("/api/logout", async (request) => {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    await deleteSession(hashToken(authorization.slice(7).trim()));
  }
  return { ok: true };
});

app.get("/api/me", async (request) => {
  const session = await sessionFromRequest(request);
  return {
    id: session.user_id,
    username: session.username,
    avatar: session.avatar
  };
});

app.get("/api/guilds", async (request) => {
  const session = await sessionFromRequest(request);
  const guilds = await manageableGuilds(session);
  return guilds.map((guild) => ({
    ...guild,
    botInstalled: client.guilds.cache.has(guild.id),
    inviteUrl:
      `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}` +
      `&permissions=${botPermissionBits}&integration_type=0&scope=bot%20applications.commands`
  }));
});

app.get("/api/guilds/:guildId/meta", async (request) => {
  const { guildId } = z.object({ guildId: z.string() }).parse(request.params);
  await requireGuildAccess(request, guildId);
  const guild = client.guilds.cache.get(guildId)!;

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    channels: guild.channels.cache
      .filter(
        (channel) =>
          channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildAnnouncement
      )
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((channel) => ({ id: channel.id, name: channel.name })),
    roles: guild.roles.cache
      .filter((role) => role.id !== guild.id && !role.managed)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name, position: role.position }))
  };
});

app.get("/api/guilds/:guildId/settings", async (request) => {
  const { guildId } = z.object({ guildId: z.string() }).parse(request.params);
  await requireGuildAccess(request, guildId);
  return getGuildSettings(guildId);
});

app.put("/api/guilds/:guildId/settings", async (request) => {
  const { guildId } = z.object({ guildId: z.string() }).parse(request.params);
  await requireGuildAccess(request, guildId);
  const patch = settingsPatchSchema.parse(request.body);
  const settings = await saveGuildSettings(guildId, patch);
  invalidateSettings(guildId);
  return settings;
});

app.post("/api/guilds/:guildId/templates/:template", async (request) => {
  const params = z.object({
    guildId: z.string(),
    template: z.enum(["community", "shop", "support"])
  }).parse(request.params);
  await requireGuildAccess(request, params.guildId);
  const guild = client.guilds.cache.get(params.guildId)!;
  const result = await applyGuildTemplate(guild, params.template as TemplateName);
  if (result.verifiedRoleId) {
    await saveGuildSettings(params.guildId, { verifiedRoleId: result.verifiedRoleId });
    invalidateSettings(params.guildId);
  }
  return result;
});

app.post("/api/guilds/:guildId/verification/panel", async (request) => {
  const { guildId } = z.object({ guildId: z.string() }).parse(request.params);
  await requireGuildAccess(request, guildId);
  const { channelId } = channelSchema.parse(request.body);
  const guild = client.guilds.cache.get(guildId)!;
  const channel = guild.channels.cache.get(channelId);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) throw httpError(400, "テキストチャンネルを選択してください");

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("サーバー認証")
        .setDescription("下のボタンから認証を完了してください。")
        .setColor(0x5865f2)
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`verify:start:${guildId}`)
          .setLabel("認証する")
          .setStyle(ButtonStyle.Success)
      )
    ]
  });
  return { ok: true };
});

app.post("/api/guilds/:guildId/tickets/panel", async (request) => {
  const { guildId } = z.object({ guildId: z.string() }).parse(request.params);
  await requireGuildAccess(request, guildId);
  const { channelId } = channelSchema.parse(request.body);
  const guild = client.guilds.cache.get(guildId)!;
  const channel = guild.channels.cache.get(channelId);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) throw httpError(400, "テキストチャンネルを選択してください");

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("サポート")
        .setDescription("問い合わせ用チケットを作成します。")
        .setColor(0x5865f2)
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:create")
          .setLabel("チケットを作成")
          .setStyle(ButtonStyle.Primary)
      )
    ]
  });
  return { ok: true };
});

app.get("/api/guilds/:guildId/products", async (request) => {
  const { guildId } = z.object({ guildId: z.string() }).parse(request.params);
  await requireGuildAccess(request, guildId);
  return listProducts(guildId);
});

app.post("/api/guilds/:guildId/products", async (request) => {
  const { guildId } = z.object({ guildId: z.string() }).parse(request.params);
  await requireGuildAccess(request, guildId);
  const input = productSchema.parse(request.body);
  return createProduct({
    id: randomUUID(),
    guild_id: guildId,
    name: input.name,
    description: input.description,
    price_yen: input.priceYen,
    active: true,
    delivery_type: input.deliveryType,
    role_id: input.roleId ?? null,
    delivery_text: input.deliveryText ?? null,
    created_at: new Date()
  });
});

app.delete("/api/guilds/:guildId/products/:productId", async (request) => {
  const { guildId, productId } = z.object({
    guildId: z.string(),
    productId: z.string()
  }).parse(request.params);
  await requireGuildAccess(request, guildId);
  const deleted = await deleteProduct(guildId, productId);
  if (!deleted) throw httpError(404, "商品が見つかりません");
  return { ok: true };
});

app.post("/api/guilds/:guildId/products/:productId/panel", async (request) => {
  const { guildId, productId } = z.object({
    guildId: z.string(),
    productId: z.string()
  }).parse(request.params);
  await requireGuildAccess(request, guildId);
  const { channelId } = channelSchema.parse(request.body);
  const product = await getProduct(productId);
  if (!product || product.guild_id !== guildId) throw httpError(404, "商品が見つかりません");

  const guild = client.guilds.cache.get(guildId)!;
  const channel = guild.channels.cache.get(channelId);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) throw httpError(400, "テキストチャンネルを選択してください");

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(product.name)
        .setDescription(product.description || "購入ボタンからPayPay決済へ進めます。")
        .addFields({
          name: "価格",
          value: `¥${product.price_yen.toLocaleString("ja-JP")}`
        })
        .setColor(0x06c755)
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`buy:${product.id}`)
          .setLabel("PayPayで購入")
          .setStyle(ButtonStyle.Success)
      )
    ]
  });

  return { ok: true };
});

app.setErrorHandler((error, _request, reply) => {
  const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 500;
  app.log.error(error);
  reply.status(statusCode).send({
    error: statusCode >= 500 ? "server_error" : "request_error",
    message: statusCode >= 500 ? "サーバー処理に失敗しました" : error.message
  });
});

await migrate();
await cleanExpiredAuth();
setInterval(() => void cleanExpiredAuth(), 60 * 60 * 1000).unref();
await startBot();
await app.listen({ host: "0.0.0.0", port: env.PORT });
