import type { Env } from "./types";
import { botJson, type DiscordUser } from "./discord";
import { snowflakeTime } from "./utils";

export type MemberActivitySettings = {
  guildId: string;
  enabled: boolean;
  channelId: string | null;
  joinEnabled: boolean;
  leaveEnabled: boolean;
  initialized: boolean;
  lastScanAt: number | null;
  memberCount: number;
  lastError: string | null;
};

type MemberActivitySettingsRow = {
  guild_id: string;
  enabled: number;
  channel_id: string | null;
  join_enabled: number;
  leave_enabled: number;
  initialized: number;
  last_scan_at: number | null;
  last_member_count: number;
  last_error: string | null;
  updated_at: number;
};

type MemberSnapshotRow = {
  guild_id: string;
  user_id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  is_bot: number;
  first_seen_at: number;
  last_seen_at: number;
};

type DiscordGuildMember = {
  user: DiscordUser & { bot?: boolean };
  joined_at?: string | null;
};

const JOIN_COLOR = 0x57f287;
const LEAVE_COLOR = 0xed4245;
const MAX_DETAIL_NOTIFICATIONS = 24;

let schemaReady: Promise<void> | null = null;

async function ensureMemberActivitySchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS member_activity_settings (
          guild_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          channel_id TEXT,
          join_enabled INTEGER NOT NULL DEFAULT 1,
          leave_enabled INTEGER NOT NULL DEFAULT 1,
          initialized INTEGER NOT NULL DEFAULT 0,
          last_scan_at INTEGER,
          last_member_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          updated_at INTEGER NOT NULL
        )
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS member_activity_members (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          global_name TEXT,
          avatar TEXT,
          is_bot INTEGER NOT NULL DEFAULT 0,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id)
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS member_activity_members_guild_idx
        ON member_activity_members(guild_id)
      `)
    ]).then(() => undefined);
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  await schemaReady;
}

function fromRow(row: MemberActivitySettingsRow): MemberActivitySettings {
  return {
    guildId: row.guild_id,
    enabled: row.enabled === 1,
    channelId: row.channel_id,
    joinEnabled: row.join_enabled === 1,
    leaveEnabled: row.leave_enabled === 1,
    initialized: row.initialized === 1,
    lastScanAt: row.last_scan_at,
    memberCount: row.last_member_count,
    lastError: row.last_error
  };
}

async function getSettingsRow(
  env: Env,
  guildId: string
): Promise<MemberActivitySettingsRow> {
  await ensureMemberActivitySchema(env);
  const existing = await env.DB.prepare(
    "SELECT * FROM member_activity_settings WHERE guild_id=?"
  ).bind(guildId).first<MemberActivitySettingsRow>();
  if (existing) return existing;

  const now = Date.now();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO member_activity_settings(
      guild_id,enabled,channel_id,join_enabled,leave_enabled,
      initialized,last_scan_at,last_member_count,last_error,updated_at
    ) VALUES (?,0,NULL,1,1,0,NULL,0,NULL,?)
  `).bind(guildId, now).run();

  return {
    guild_id: guildId,
    enabled: 0,
    channel_id: null,
    join_enabled: 1,
    leave_enabled: 1,
    initialized: 0,
    last_scan_at: null,
    last_member_count: 0,
    last_error: null,
    updated_at: now
  };
}

export async function getMemberActivitySettings(
  env: Env,
  guildId: string
): Promise<MemberActivitySettings> {
  return fromRow(await getSettingsRow(env, guildId));
}

export async function saveMemberActivitySettings(
  env: Env,
  guildId: string,
  input: {
    enabled: boolean;
    channelId: string | null;
    joinEnabled: boolean;
    leaveEnabled: boolean;
  }
): Promise<MemberActivitySettings> {
  const previous = await getSettingsRow(env, guildId);
  const enabling = input.enabled && previous.enabled !== 1;
  const initialized = input.enabled
    ? enabling
      ? 0
      : previous.initialized
    : 0;

  await env.DB.prepare(`
    INSERT INTO member_activity_settings(
      guild_id,enabled,channel_id,join_enabled,leave_enabled,
      initialized,last_scan_at,last_member_count,last_error,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET
      enabled=excluded.enabled,
      channel_id=excluded.channel_id,
      join_enabled=excluded.join_enabled,
      leave_enabled=excluded.leave_enabled,
      initialized=excluded.initialized,
      last_error=NULL,
      updated_at=excluded.updated_at
  `).bind(
    guildId,
    input.enabled ? 1 : 0,
    input.channelId,
    input.joinEnabled ? 1 : 0,
    input.leaveEnabled ? 1 : 0,
    initialized,
    previous.last_scan_at,
    previous.last_member_count,
    null,
    Date.now()
  ).run();

  return getMemberActivitySettings(env, guildId);
}

async function listGuildMembers(
  env: Env,
  guildId: string
): Promise<DiscordGuildMember[]> {
  const result: DiscordGuildMember[] = [];
  let after = "0";

  for (let page = 0; page < 100; page++) {
    const batch = await botJson<DiscordGuildMember[]>(
      env,
      `/guilds/${guildId}/members?limit=1000&after=${after}`
    );
    result.push(...batch);
    if (batch.length < 1000) break;
    const last = batch[batch.length - 1]?.user?.id;
    if (!last || last === after) break;
    after = last;
  }

  return result;
}

async function getSnapshot(
  env: Env,
  guildId: string
): Promise<MemberSnapshotRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM member_activity_members WHERE guild_id=?"
  ).bind(guildId).all<MemberSnapshotRow>();
  return rows.results;
}

async function persistSnapshot(
  env: Env,
  guildId: string,
  members: DiscordGuildMember[],
  scanAt: number
): Promise<void> {
  const statements = members.map(member =>
    env.DB.prepare(`
      INSERT INTO member_activity_members(
        guild_id,user_id,username,global_name,avatar,is_bot,first_seen_at,last_seen_at
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(guild_id,user_id) DO UPDATE SET
        username=excluded.username,
        global_name=excluded.global_name,
        avatar=excluded.avatar,
        is_bot=excluded.is_bot,
        last_seen_at=excluded.last_seen_at
    `).bind(
      guildId,
      member.user.id,
      member.user.username,
      member.user.global_name ?? null,
      member.user.avatar ?? null,
      member.user.bot ? 1 : 0,
      scanAt,
      scanAt
    )
  );

  for (let index = 0; index < statements.length; index += 75) {
    await env.DB.batch(statements.slice(index, index + 75));
  }

  await env.DB.prepare(
    "DELETE FROM member_activity_members WHERE guild_id=? AND last_seen_at<?"
  ).bind(guildId, scanAt).run();
}

function displayName(user: DiscordUser): string {
  return user.global_name?.trim() || user.username;
}

function avatarUrl(user: DiscordUser): string {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`;
  }
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function elapsedText(createdAt: number, now = Date.now()): string {
  const totalMinutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return `${days}日 ${String(hours).padStart(2, "0")}時間 ${String(minutes).padStart(2, "0")}分`;
}

function createdAtText(createdAt: number): string {
  const text = new Date(createdAt).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  return `${text.replaceAll("/", "-")} JST`;
}

function memberEmbed(
  kind: "join" | "leave",
  user: DiscordUser,
  memberCount: number,
  guildName: string
) {
  const createdAt = snowflakeTime(user.id);
  const joined = kind === "join";
  return {
    author: {
      name: displayName(user),
      icon_url: avatarUrl(user)
    },
    description: `<@${user.id}> がサーバー${joined ? "に参加しました" : "から退出しました"}`,
    color: joined ? JOIN_COLOR : LEAVE_COLOR,
    thumbnail: { url: avatarUrl(user) },
    fields: [
      {
        name: "🕰️ アカウント作成からの経過",
        value: `${createdAtText(createdAt)}\n経過: ${elapsedText(createdAt)}`
      },
      {
        name: "👥 現在のサーバー人数",
        value: String(memberCount)
      }
    ],
    footer: { text: guildName },
    timestamp: new Date().toISOString()
  };
}

async function sendActivityMessage(
  env: Env,
  channelId: string,
  kind: "join" | "leave",
  user: DiscordUser,
  memberCount: number,
  guildName: string
): Promise<void> {
  await botJson(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [memberEmbed(kind, user, memberCount, guildName)],
      allowed_mentions: { parse: [] }
    })
  });
}

async function sendOverflowSummary(
  env: Env,
  channelId: string,
  joined: number,
  left: number,
  memberCount: number,
  guildName: string
): Promise<void> {
  await botJson(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [{
        title: "入退室ログのまとめ",
        description:
          `短時間に多数の入退室が発生したため、詳細通知を一部まとめました。\n` +
          `参加: **${joined}人** / 退出: **${left}人** / 現在: **${memberCount}人**`,
        color: 0x5865f2,
        footer: { text: guildName },
        timestamp: new Date().toISOString()
      }]
    })
  });
}

async function syncGuild(
  env: Env,
  row: MemberActivitySettingsRow
): Promise<MemberActivitySettings> {
  if (row.enabled !== 1 || !row.channel_id) return fromRow(row);

  const scanAt = Date.now();
  try {
    const [members, previous, guild] = await Promise.all([
      listGuildMembers(env, row.guild_id),
      getSnapshot(env, row.guild_id),
      botJson<{ name: string }>(env, `/guilds/${row.guild_id}`)
    ]);

    const currentById = new Map(members.map(member => [member.user.id, member]));
    const previousById = new Map(previous.map(member => [member.user_id, member]));

    const joined = members.filter(member => !previousById.has(member.user.id));
    const left = previous.filter(member => !currentById.has(member.user_id));

    await persistSnapshot(env, row.guild_id, members, scanAt);
    await env.DB.prepare(`
      UPDATE member_activity_settings
      SET initialized=1,last_scan_at=?,last_member_count=?,last_error=NULL,updated_at=?
      WHERE guild_id=?
    `).bind(scanAt, members.length, scanAt, row.guild_id).run();

    if (row.initialized === 1) {
      let sent = 0;
      let overflowJoin = 0;
      let overflowLeave = 0;

      if (row.join_enabled === 1) {
        for (const member of joined) {
          if (sent >= MAX_DETAIL_NOTIFICATIONS) {
            overflowJoin++;
            continue;
          }
          await sendActivityMessage(
            env,
            row.channel_id,
            "join",
            member.user,
            members.length,
            guild.name
          );
          sent++;
        }
      }

      if (row.leave_enabled === 1) {
        for (const member of left) {
          if (sent >= MAX_DETAIL_NOTIFICATIONS) {
            overflowLeave++;
            continue;
          }
          await sendActivityMessage(
            env,
            row.channel_id,
            "leave",
            {
              id: member.user_id,
              username: member.username,
              global_name: member.global_name,
              avatar: member.avatar
            },
            members.length,
            guild.name
          );
          sent++;
        }
      }

      if (overflowJoin || overflowLeave) {
        await sendOverflowSummary(
          env,
          row.channel_id,
          overflowJoin,
          overflowLeave,
          members.length,
          guild.name
        );
      }
    }

    return getMemberActivitySettings(env, row.guild_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`
      UPDATE member_activity_settings
      SET last_scan_at=?,last_error=?,updated_at=?
      WHERE guild_id=?
    `).bind(scanAt, message.slice(0, 500), scanAt, row.guild_id).run();
    throw error;
  }
}

export async function primeMemberActivity(
  env: Env,
  guildId: string
): Promise<MemberActivitySettings> {
  const row = await getSettingsRow(env, guildId);
  return syncGuild(env, row);
}

export async function sendMemberActivityTest(
  env: Env,
  guildId: string,
  channelId: string
): Promise<void> {
  await ensureMemberActivitySchema(env);
  const [bot, guild, settings] = await Promise.all([
    botJson<DiscordUser>(env, "/users/@me"),
    botJson<{ name: string }>(env, `/guilds/${guildId}`),
    getMemberActivitySettings(env, guildId)
  ]);
  const count = Math.max(1, settings.memberCount);
  await sendActivityMessage(env, channelId, "join", bot, count, guild.name);
  await sendActivityMessage(env, channelId, "leave", bot, Math.max(0, count - 1), guild.name);
}


export type GatewayMemberActivityEvent = {
  guild_id: string;
  user: DiscordUser & { bot?: boolean };
  joined_at?: string | null;
};

export async function hasEnabledMemberActivity(env: Env): Promise<boolean> {
  await ensureMemberActivitySchema(env);
  const row = await env.DB.prepare(`
    SELECT guild_id FROM member_activity_settings
    WHERE enabled=1 AND channel_id IS NOT NULL
    LIMIT 1
  `).first<{ guild_id: string }>();
  return Boolean(row);
}

async function snapshotMember(
  env: Env,
  guildId: string,
  userId: string
): Promise<MemberSnapshotRow | null> {
  return (
    await env.DB.prepare(
      "SELECT * FROM member_activity_members WHERE guild_id=? AND user_id=?"
    ).bind(guildId, userId).first<MemberSnapshotRow>()
  ) ?? null;
}

async function retryActivityMessage(
  env: Env,
  channelId: string,
  kind: "join" | "leave",
  user: DiscordUser,
  memberCount: number,
  guildName: string
): Promise<void> {
  try {
    await sendActivityMessage(
      env,
      channelId,
      kind,
      user,
      memberCount,
      guildName
    );
  } catch (firstError) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      await sendActivityMessage(
        env,
        channelId,
        kind,
        user,
        memberCount,
        guildName
      );
    } catch {
      throw firstError;
    }
  }
}

export async function handleMemberActivityGatewayEvent(
  env: Env,
  kind: "join" | "leave",
  event: GatewayMemberActivityEvent
): Promise<void> {
  if (!event?.guild_id || !event.user?.id) return;

  const row = await getSettingsRow(env, event.guild_id);
  if (row.enabled !== 1 || !row.channel_id) return;

  // If an old configuration has not been primed yet, establish the baseline
  // instead of treating every existing member as a new event.
  if (row.initialized !== 1) {
    await syncGuild(env, row);
    return;
  }

  const existing = await snapshotMember(env, event.guild_id, event.user.id);

  // Gateway sessions can replay dispatches during RESUME. The snapshot is our
  // idempotency guard so a replay never emits a duplicate notification.
  if (kind === "join" && existing) {
    return;
  }
  if (kind === "leave" && !existing) {
    return;
  }

  const now = Date.now();
  const memberCount =
    kind === "join"
      ? Math.max(0, row.last_member_count) + 1
      : Math.max(0, row.last_member_count - 1);

  const shouldNotify =
    kind === "join" ? row.join_enabled === 1 : row.leave_enabled === 1;

  const notificationUser: DiscordUser =
    kind === "leave" && existing
      ? {
          id: existing.user_id,
          username: existing.username,
          global_name: existing.global_name,
          avatar: existing.avatar
        }
      : event.user;

  if (shouldNotify) {
    const guild = await botJson<{ name: string }>(
      env,
      `/guilds/${event.guild_id}`
    );
    await retryActivityMessage(
      env,
      row.channel_id,
      kind,
      notificationUser,
      memberCount,
      guild.name
    );
  }

  if (kind === "join") {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO member_activity_members(
          guild_id,user_id,username,global_name,avatar,is_bot,first_seen_at,last_seen_at
        ) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(guild_id,user_id) DO UPDATE SET
          username=excluded.username,
          global_name=excluded.global_name,
          avatar=excluded.avatar,
          is_bot=excluded.is_bot,
          last_seen_at=excluded.last_seen_at
      `).bind(
        event.guild_id,
        event.user.id,
        event.user.username,
        event.user.global_name ?? null,
        event.user.avatar ?? null,
        event.user.bot ? 1 : 0,
        now,
        now
      ),
      env.DB.prepare(`
        UPDATE member_activity_settings
        SET last_scan_at=?,last_member_count=?,last_error=NULL,updated_at=?
        WHERE guild_id=?
      `).bind(now, memberCount, now, event.guild_id)
    ]);
    return;
  }

  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM member_activity_members WHERE guild_id=? AND user_id=?"
    ).bind(event.guild_id, event.user.id),
    env.DB.prepare(`
      UPDATE member_activity_settings
      SET last_scan_at=?,last_member_count=?,last_error=NULL,updated_at=?
      WHERE guild_id=?
    `).bind(now, memberCount, now, event.guild_id)
  ]);
}

export async function memberActivitySweep(env: Env): Promise<void> {
  await ensureMemberActivitySchema(env);
  const rows = await env.DB.prepare(`
    SELECT * FROM member_activity_settings
    WHERE enabled=1 AND channel_id IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT 25
  `).all<MemberActivitySettingsRow>();

  for (const row of rows.results) {
    try {
      await syncGuild(env, row);
    } catch (error) {
      console.warn("member activity sweep failed", row.guild_id, error);
    }
  }
}
