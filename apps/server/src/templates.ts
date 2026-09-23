import {
  ChannelType,
  Guild,
  PermissionsBitField,
  type CategoryChannel,
  type Role,
  type TextChannel
} from "discord.js";

async function ensureRole(
  guild: Guild,
  name: string,
  permissions: bigint[] = []
): Promise<Role> {
  const existing = guild.roles.cache.find((role) => role.name === name);
  if (existing) return existing;
  return guild.roles.create({
    name,
    permissions,
    reason: "Discord Server Manager template"
  });
}

async function ensureCategory(guild: Guild, name: string): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === name
  ) as CategoryChannel | undefined;
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "Discord Server Manager template"
  });
}

async function ensureTextChannel(
  guild: Guild,
  category: CategoryChannel,
  name: string,
  options?: { readOnly?: boolean; privateRole?: Role }
): Promise<TextChannel> {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === name &&
      channel.parentId === category.id
  ) as TextChannel | undefined;
  if (existing) return existing;

  const overwrites: Array<{
    id: string;
    allow?: bigint[];
    deny?: bigint[];
  }> = [];

  if (options?.readOnly) {
    overwrites.push({
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.SendMessages]
    });
  }

  if (options?.privateRole) {
    overwrites.push(
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: options.privateRole.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      }
    );
  }

  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    reason: "Discord Server Manager template"
  });
}

export type TemplateName = "community" | "shop" | "support";

export async function applyGuildTemplate(
  guild: Guild,
  template: TemplateName
): Promise<{ created: string[]; verifiedRoleId?: string }> {
  const created: string[] = [];

  if (template === "community") {
    const verified = await ensureRole(guild, "Verified");
    const moderator = await ensureRole(guild, "Moderator", [
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.KickMembers
    ]);

    const start = await ensureCategory(guild, "START HERE");
    const community = await ensureCategory(guild, "COMMUNITY");
    const staff = await ensureCategory(guild, "STAFF");

    await ensureTextChannel(guild, start, "welcome", { readOnly: true });
    await ensureTextChannel(guild, start, "rules", { readOnly: true });
    await ensureTextChannel(guild, community, "general");
    await ensureTextChannel(guild, community, "media");
    await ensureTextChannel(guild, staff, "staff-chat", { privateRole: moderator });

    created.push("Verified", "Moderator", "START HERE", "COMMUNITY", "STAFF");
    return { created, verifiedRoleId: verified.id };
  }

  if (template === "shop") {
    const customer = await ensureRole(guild, "Customer");
    const support = await ensureRole(guild, "Support", [
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ModerateMembers
    ]);

    const shop = await ensureCategory(guild, "SHOP");
    const help = await ensureCategory(guild, "SUPPORT");
    await ensureTextChannel(guild, shop, "announcements", { readOnly: true });
    await ensureTextChannel(guild, shop, "products", { readOnly: true });
    await ensureTextChannel(guild, shop, "orders");
    await ensureTextChannel(guild, help, "open-ticket");
    await ensureTextChannel(guild, help, "support-staff", { privateRole: support });

    created.push("Customer", "Support", "SHOP", "SUPPORT");
    return { created, verifiedRoleId: customer.id };
  }

  const support = await ensureRole(guild, "Support", [
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ModerateMembers
  ]);
  const category = await ensureCategory(guild, "SUPPORT");
  await ensureTextChannel(guild, category, "faq", { readOnly: true });
  await ensureTextChannel(guild, category, "open-ticket");
  await ensureTextChannel(guild, category, "staff-support", { privateRole: support });
  created.push("Support", "SUPPORT");
  return { created };
}
