import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type GuildMember,
  type Interaction,
  type Message,
  type Role
} from "discord.js";
import { randomBytes, randomUUID } from "node:crypto";
import { env, payPayConfigured } from "./config.js";
import {
  createPayment,
  getGuildSettings,
  getProduct,
  listUndeliveredPayments,
  markDelivered,
  setPaymentStatus,
  type GuildSettings,
  type Payment
} from "./db.js";
import { createPayPayQr, getPayPayPaymentStatus } from "./paypay.js";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("管理ダッシュボードを開きます"),
  new SlashCommandBuilder()
    .setName("security-status")
    .setDescription("このサーバーのセキュリティ設定を表示します"),
  new SlashCommandBuilder()
    .setName("verify-panel")
    .setDescription("認証パネルを設置します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("認証パネルを置くチャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("チケットパネルを設置します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("チケットパネルを置くチャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
].map((command) => command.toJSON());

const settingsCache = new Map<string, { settings: GuildSettings; expiresAt: number }>();
const spamHistory = new Map<string, number[]>();
const joinHistory = new Map<string, number[]>();
const raidModeUntil = new Map<string, number>();
const actionHistory = new Map<string, number[]>();
const challenges = new Map<
  string,
  { guildId: string; userId: string; code: string; expiresAt: number }
>();

const DANGEROUS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers
];

async function cachedSettings(guildId: string): Promise<GuildSettings> {
  const cached = settingsCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.settings;
  const settings = await getGuildSettings(guildId);
  settingsCache.set(guildId, { settings, expiresAt: Date.now() + 15_000 });
  return settings;
}

export function invalidateSettings(guildId: string): void {
  settingsCache.delete(guildId);
}

function sendableChannel(guild: Guild, id: string | null) {
  const channel = id ? guild.channels.cache.get(id) : guild.systemChannel;
  if (!channel) return null;
  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) return null;
  return channel;
}

async function securityLog(
  guild: Guild,
  settings: GuildSettings,
  title: string,
  description: string
): Promise<void> {
  const channel = sendableChannel(guild, settings.logChannelId);
  if (!channel) return;
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp()
    ]
  }).catch(() => undefined);
}

function isTrusted(member: GuildMember, settings: GuildSettings): boolean {
  if (member.id === member.guild.ownerId) return true;
  if (member.id === client.user?.id) return true;
  if (settings.trustedUserIds.includes(member.id)) return true;
  return member.roles.cache.some((role) => settings.trustedRoleIds.includes(role.id));
}

async function neutralizeExecutor(
  guild: Guild,
  executorId: string,
  settings: GuildSettings,
  reason: string
): Promise<void> {
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member || isTrusted(member, settings)) return;

  const removable = member.roles.cache.filter(
    (role) =>
      role.id !== guild.id &&
      !role.managed &&
      role.editable &&
      DANGEROUS.some((permission) => role.permissions.has(permission))
  );

  if (removable.size > 0) {
    await member.roles.remove(removable, reason).catch(() => undefined);
  }

  await securityLog(
    guild,
    settings,
    "危険操作を停止しました",
    `<@${executorId}> から危険権限を持つロールを解除しました。\n理由: ${reason}`
  );
}

function recordWindow(key: string, windowMs: number): number {
  const now = Date.now();
  const history = (actionHistory.get(key) ?? []).filter((t) => now - t <= windowMs);
  history.push(now);
  actionHistory.set(key, history);
  return history.length;
}

async function inspectAuditAction(
  guild: Guild,
  targetId: string,
  event: AuditLogEvent,
  label: string
): Promise<void> {
  const settings = await cachedSettings(guild.id);
  if (!settings.securityEnabled || !settings.antiNuke) return;

  await new Promise((resolve) => setTimeout(resolve, 700));
  const logs = await guild.fetchAuditLogs({ type: event, limit: 5 }).catch(() => null);
  if (!logs) return;

  const entry = logs.entries.find((item) => {
    const target = item.target as { id?: string } | null;
    return target?.id === targetId && Date.now() - item.createdTimestamp < 8_000;
  });
  const executorId = entry?.executorId ?? entry?.executor?.id;
  if (!executorId || executorId === client.user?.id) return;

  const executor = await guild.members.fetch(executorId).catch(() => null);
  if (!executor || isTrusted(executor, settings)) return;

  const count = recordWindow(
    `${guild.id}:${executorId}`,
    settings.nukeWindowSeconds * 1000
  );
  await securityLog(
    guild,
    settings,
    "監査ログ検知",
    `${label}: <@${executorId}>（短時間の危険操作 ${count} 回）`
  );

  if (count >= settings.nukeActions) {
    await neutralizeExecutor(
      guild,
      executorId,
      settings,
      `Anti-Nuke: ${settings.nukeWindowSeconds}秒で${count}回の危険操作`
    );
  }
}

async function handleMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || !message.member) return;
  const settings = await cachedSettings(message.guild.id);
  if (!settings.securityEnabled) return;

  let violation: string | null = null;
  const content = message.content;

  if (
    settings.blockInvites &&
    /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i.test(content)
  ) {
    violation = "Discord招待リンク";
  }

  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (!violation && mentionCount >= settings.mentionLimit) {
    violation = "大量メンション";
  }

  if (!violation && settings.antiSpam) {
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const history = (spamHistory.get(key) ?? []).filter(
      (time) => now - time <= settings.spamWindowSeconds * 1000
    );
    history.push(now);
    spamHistory.set(key, history);
    if (history.length >= settings.spamMax) violation = "連投スパム";
  }

  if (!violation) return;
  await message.delete().catch(() => undefined);
  if (message.member.moderatable) {
    await message.member.timeout(60_000, `Security: ${violation}`).catch(() => undefined);
  }
  await securityLog(
    message.guild,
    settings,
    "メッセージ保護",
    `<@${message.author.id}> の ${violation} を検知して削除しました。`
  );
}

async function handleJoin(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const settings = await cachedSettings(member.guild.id);
  if (!settings.securityEnabled || !settings.antiRaid) return;

  const now = Date.now();
  const windowMs = settings.raidWindowSeconds * 1000;
  const history = (joinHistory.get(member.guild.id) ?? []).filter(
    (time) => now - time <= windowMs
  );
  history.push(now);
  joinHistory.set(member.guild.id, history);

  if (history.length >= settings.raidJoins) {
    raidModeUntil.set(member.guild.id, now + 10 * 60_000);
    await securityLog(
      member.guild,
      settings,
      "Raid Mode",
      `${settings.raidWindowSeconds}秒以内に${history.length}人が参加したため、10分間Raid Modeに入りました。`
    );
  }

  if ((raidModeUntil.get(member.guild.id) ?? 0) > now && member.moderatable) {
    await member.timeout(10 * 60_000, "Anti-Raid temporary quarantine").catch(() => undefined);
  }
}

function makeChallengeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function startVerification(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;
  const challengeId = randomUUID();
  const code = makeChallengeCode();
  challenges.set(challengeId, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    code,
    expiresAt: Date.now() + 5 * 60_000
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`verify:answer:${challengeId}`)
      .setLabel("コードを入力")
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.reply({
    ephemeral: true,
    content:
      "下の確認コードを入力してください。5分で失効します。\n\n" +
      `**${code.split("").join("  ")}**`,
    components: [row]
  });
}

async function openVerificationModal(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const challengeId = interaction.customId.split(":")[2];
  if (!challengeId) return;
  const challenge = challenges.get(challengeId);
  if (
    !challenge ||
    challenge.userId !== interaction.user.id ||
    challenge.expiresAt < Date.now()
  ) {
    await interaction.reply({ ephemeral: true, content: "認証コードが失効しています。" });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`verify:modal:${challengeId}`)
    .setTitle("サーバー認証");
  const input = new TextInputBuilder()
    .setCustomId("code")
    .setLabel("確認コード")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(6)
    .setMaxLength(6);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

async function completeVerification(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guild) return;
  const challengeId = interaction.customId.split(":")[2];
  if (!challengeId) return;
  const challenge = challenges.get(challengeId);
  challenges.delete(challengeId);

  if (
    !challenge ||
    challenge.userId !== interaction.user.id ||
    challenge.guildId !== interaction.guild.id ||
    challenge.expiresAt < Date.now()
  ) {
    await interaction.reply({ ephemeral: true, content: "認証が失効しています。" });
    return;
  }

  const answer = interaction.fields.getTextInputValue("code").trim().toUpperCase();
  if (answer !== challenge.code) {
    await interaction.reply({ ephemeral: true, content: "コードが一致しません。" });
    return;
  }

  const settings = await cachedSettings(interaction.guild.id);
  if (!settings.verifiedRoleId) {
    await interaction.reply({
      ephemeral: true,
      content: "認証ロールが管理画面で設定されていません。"
    });
    return;
  }

  const accountAge =
    Date.now() - interaction.user.createdTimestamp;
  if (accountAge < settings.minAccountAgeDays * 86_400_000) {
    await interaction.reply({
      ephemeral: true,
      content: `このサーバーでは作成から${settings.minAccountAgeDays}日未満のアカウントは認証できません。`
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  await member.roles.add(settings.verifiedRoleId, "Discord Server Manager verification");
  await interaction.reply({ ephemeral: true, content: "認証が完了しました。" });
}

async function createTicket(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guild) return;
  const guild = interaction.guild;
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.topic === `dsm-ticket:${interaction.user.id}`
  );
  if (existing) {
    await interaction.reply({
      ephemeral: true,
      content: `既にチケットがあります: <#${existing.id}>`
    });
    return;
  }

  const support = guild.roles.cache.find((role) => role.name === "Support");
  const me = guild.members.me;
  const channel = await guild.channels.create({
    name: `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 18) || interaction.user.id.slice(-6)}`,
    type: ChannelType.GuildText,
    topic: `dsm-ticket:${interaction.user.id}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles
        ]
      },
      ...(support
        ? [{
            id: support.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory
            ]
          }]
        : []),
      ...(me
        ? [{
            id: me.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ManageChannels
            ]
          }]
        : [])
    ]
  });

  await channel.send({
    content: `<@${interaction.user.id}> サポート担当者が対応します。`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:close")
          .setLabel("チケットを閉じる")
          .setStyle(ButtonStyle.Danger)
      )
    ]
  });
  await interaction.reply({ ephemeral: true, content: `作成しました: <#${channel.id}>` });
}

async function purchase(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guild) return;
  const productId = interaction.customId.slice("buy:".length);
  const product = await getProduct(productId);
  if (!product || !product.active || product.guild_id !== interaction.guild.id) {
    await interaction.reply({ ephemeral: true, content: "この商品は現在購入できません。" });
    return;
  }
  if (!payPayConfigured) {
    await interaction.reply({
      ephemeral: true,
      content: "PayPay決済がまだ管理者によって設定されていません。"
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const merchantPaymentId =
    `dsm_${Date.now()}_${randomBytes(6).toString("hex")}`;
  const qr = await createPayPayQr({
    merchantPaymentId,
    amountYen: product.price_yen,
    description: product.name
  });

  const payment: Payment = {
    id: randomUUID(),
    merchant_payment_id: merchantPaymentId,
    guild_id: interaction.guild.id,
    user_id: interaction.user.id,
    product_id: product.id,
    status: "CREATED",
    paypay_url: qr.url,
    amount_yen: product.price_yen,
    created_at: new Date(),
    updated_at: new Date(),
    delivered_at: null
  };
  await createPayment(payment);

  await interaction.editReply({
    content:
      `**${product.name}** — ¥${product.price_yen.toLocaleString("ja-JP")}\n` +
      "PayPayで支払いを完了すると自動で商品を受け取れます。",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel("PayPayで支払う")
          .setStyle(ButtonStyle.Link)
          .setURL(qr.url)
      )
    ]
  });
}

async function deliverPayment(payment: Payment): Promise<void> {
  const product = await getProduct(payment.product_id);
  const guild = client.guilds.cache.get(payment.guild_id);
  if (!product || !guild) throw new Error("Product or guild unavailable");

  if (product.delivery_type === "role") {
    if (!product.role_id) throw new Error("Product role is not configured");
    const member = await guild.members.fetch(payment.user_id);
    await member.roles.add(product.role_id, `Paid product: ${product.name}`);
  } else {
    if (!product.delivery_text) throw new Error("Product delivery text is empty");
    const user = await client.users.fetch(payment.user_id);
    await user.send(
      `「${product.name}」の購入ありがとうございます。\n\n${product.delivery_text}`
    );
  }
  await markDelivered(payment.id);
}

async function paymentPoll(): Promise<void> {
  if (!payPayConfigured) return;
  const payments = await listUndeliveredPayments();
  for (const payment of payments) {
    try {
      let status = payment.status;
      if (status !== "COMPLETED") {
        status = await getPayPayPaymentStatus(payment.merchant_payment_id);
        await setPaymentStatus(payment.id, status);
      }
      if (status === "COMPLETED") await deliverPayment(payment);
    } catch (error) {
      console.error("payment poll failed", payment.id, error);
    }
  }
}

async function onInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "dashboard") {
      await interaction.reply({
        ephemeral: true,
        content: `管理画面: ${env.WEB_ORIGIN}`
      });
      return;
    }

    if (interaction.commandName === "security-status" && interaction.guildId) {
      const settings = await cachedSettings(interaction.guildId);
      await interaction.reply({
        ephemeral: true,
        embeds: [
          new EmbedBuilder()
            .setTitle("Security Status")
            .addFields(
              { name: "Security", value: settings.securityEnabled ? "ON" : "OFF", inline: true },
              { name: "Anti-Spam", value: settings.antiSpam ? "ON" : "OFF", inline: true },
              { name: "Anti-Raid", value: settings.antiRaid ? "ON" : "OFF", inline: true },
              { name: "Anti-Nuke", value: settings.antiNuke ? "ON" : "OFF", inline: true }
            )
        ]
      });
      return;
    }

    if (
      (interaction.commandName === "verify-panel" ||
        interaction.commandName === "ticket-panel") &&
      interaction.guild
    ) {
      const channelOption = interaction.options.getChannel("channel", true);
      const channel = await interaction.guild.channels.fetch(channelOption.id).catch(() => null);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        await interaction.reply({ ephemeral: true, content: "テキストチャンネルを指定してください。" });
        return;
      }
      if (interaction.commandName === "verify-panel") {
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
                .setCustomId(`verify:start:${interaction.guild.id}`)
                .setLabel("認証する")
                .setStyle(ButtonStyle.Success)
            )
          ]
        });
      } else {
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
      }
      await interaction.reply({ ephemeral: true, content: "パネルを設置しました。" });
      return;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("verify:start:")) return startVerification(interaction);
    if (interaction.customId.startsWith("verify:answer:")) return openVerificationModal(interaction);
    if (interaction.customId === "ticket:create") return createTicket(interaction);
    if (interaction.customId === "ticket:close") {
      await interaction.reply({ ephemeral: true, content: "チケットを閉じます。" });
      const ticketChannel = interaction.guild?.channels.cache.get(interaction.channelId);
      setTimeout(() => {
        if (ticketChannel?.deletable) void ticketChannel.delete().catch(() => undefined);
      }, 1200);
      return;
    }
    if (interaction.customId.startsWith("buy:")) return purchase(interaction);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("verify:modal:")) {
    return completeVerification(interaction);
  }
}

export async function startBot(): Promise<void> {
  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message);
  });
  client.on(Events.GuildMemberAdd, (member) => {
    void handleJoin(member);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void onInteraction(interaction).catch(console.error);
  });

  client.on(Events.ChannelDelete, (channel) => {
    if (channel.isDMBased()) return;
    void inspectAuditAction(
      channel.guild,
      channel.id,
      AuditLogEvent.ChannelDelete,
      `チャンネル削除 #${channel.name}`
    );
  });

  client.on(Events.GuildRoleDelete, (role) => {
    void inspectAuditAction(
      role.guild,
      role.id,
      AuditLogEvent.RoleDelete,
      `ロール削除 @${role.name}`
    );
  });

  client.on(Events.GuildBanAdd, (ban) => {
    void inspectAuditAction(
      ban.guild,
      ban.user.id,
      AuditLogEvent.MemberBanAdd,
      `メンバーBAN <@${ban.user.id}>`
    );
  });

  client.on(Events.GuildRoleUpdate, (oldRole: Role, newRole: Role) => {
    void (async () => {
      const dangerousAdded = DANGEROUS.some(
        (permission) =>
          !oldRole.permissions.has(permission) && newRole.permissions.has(permission)
      );
      if (!dangerousAdded) return;

      const settings = await cachedSettings(newRole.guild.id);
      if (!settings.securityEnabled || !settings.antiNuke) return;
      await new Promise((resolve) => setTimeout(resolve, 700));
      const logs = await newRole.guild
        .fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 5 })
        .catch(() => null);
      const entry = logs?.entries.find((item) => {
        const target = item.target as { id?: string } | null;
        return target?.id === newRole.id && Date.now() - item.createdTimestamp < 8_000;
      });
      const executorId = entry?.executorId ?? entry?.executor?.id;
      if (!executorId) return;
      const executor = await newRole.guild.members.fetch(executorId).catch(() => null);
      if (!executor || isTrusted(executor, settings)) return;

      await newRole.setPermissions(oldRole.permissions, "Security rollback: dangerous permission");
      await neutralizeExecutor(
        newRole.guild,
        executorId,
        settings,
        "危険権限をロールへ追加したため"
      );
    })().catch(console.error);
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Discord bot ready as ${ready.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: commands });
    setInterval(() => {
      void paymentPoll();
    }, 3_000).unref();
  });

  await client.login(env.DISCORD_TOKEN);
}
