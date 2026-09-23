import type { DashboardSession, Env, GuildSettings, PaymentRow, ProductRow, SessionRow } from "./types";

export const DEFAULT_SETTINGS: GuildSettings = {
  securityEnabled: true,
  antiSpam: true,
  spamMax: 6,
  spamWindowSeconds: 8,
  blockInvites: true,
  mentionLimit: 6,
  antiRaid: true,
  raidJoins: 10,
  raidWindowSeconds: 20,
  antiNuke: true,
  nukeActions: 4,
  nukeWindowSeconds: 15,
  logChannelId: null,
  verifiedRoleId: null,
  minAccountAgeDays: 3,
  ticketSupportRoleIds: [],
  trustedUserIds: [],
  trustedRoleIds: []
};

const schema = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '3');

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions(user_id);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_yen INTEGER NOT NULL CHECK (price_yen > 0),
  active INTEGER NOT NULL DEFAULT 1,
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('role','text')),
  role_id TEXT,
  delivery_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS products_guild_idx ON products(guild_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  merchant_payment_id TEXT UNIQUE NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  paypay_url TEXT,
  amount_yen INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS payments_pending_idx ON payments(status, delivered_at, created_at);

CREATE TABLE IF NOT EXISTS verification_challenges (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_cursors (
  guild_id TEXT PRIMARY KEY,
  last_entry_id TEXT,
  updated_at INTEGER NOT NULL
);
`;

const schemaInitializations = new WeakMap<D1Database, Promise<void>>();
export async function ensureSchema(env: Env): Promise<void> {
  let initialization = schemaInitializations.get(env.DB);
  if (!initialization) {
    initialization = (async () => {
      // D1 exec splits on newlines, including those inside CREATE TABLE.
      // This static DDL contains no semicolons in literals or triggers.
      const statements = schema.split(";").map(sql => sql.trim()).filter(Boolean);
      await env.DB.batch([
        ...statements.map(sql => env.DB.prepare(sql)),
        env.DB.prepare(`
          INSERT INTO meta(key, value) VALUES ('schema_version', '3')
          ON CONFLICT(key) DO UPDATE SET value='3'
        `)
      ]);
    })();
    schemaInitializations.set(env.DB, initialization);
    initialization.catch(() => schemaInitializations.delete(env.DB));
  }
  await initialization;
}

export async function cleanExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM web_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM dashboard_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM verification_challenges WHERE expires_at < ?").bind(now)
  ]);
}

export async function putOAuthState(env: Env, state: string): Promise<void> {
  await env.DB.prepare("INSERT INTO oauth_states(state, expires_at) VALUES (?, ?)")
    .bind(state, Date.now() + 10 * 60_000).run();
}

export async function consumeOAuthState(env: Env, state: string): Promise<boolean> {
  const now = Date.now();
  const found = await env.DB.prepare(
    "SELECT state FROM oauth_states WHERE state=? AND expires_at>?"
  ).bind(state, now).first();
  if (!found) return false;
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
  return true;
}

export async function createSession(env: Env, row: SessionRow): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO web_sessions(
      token_hash,user_id,username,avatar,access_token_enc,refresh_token_enc,
      token_expires_at,expires_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    row.token_hash,row.user_id,row.username,row.avatar,row.access_token_enc,
    row.refresh_token_enc,row.token_expires_at,row.expires_at,Date.now()
  ).run();
}

export async function getSession(env: Env, tokenHash: string): Promise<SessionRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM web_sessions WHERE token_hash=? AND expires_at>?"
  ).bind(tokenHash, Date.now()).first<SessionRow>() ?? null;
}

export async function updateSessionTokens(
  env: Env,
  tokenHash: string,
  accessEnc: string,
  refreshEnc: string,
  expiresAt: number
): Promise<void> {
  await env.DB.prepare(`
    UPDATE web_sessions
    SET access_token_enc=?, refresh_token_enc=?, token_expires_at=?
    WHERE token_hash=?
  `).bind(accessEnc, refreshEnc, expiresAt, tokenHash).run();
}

export async function deleteSession(env: Env, tokenHash: string): Promise<void> {
  await env.DB.prepare("DELETE FROM web_sessions WHERE token_hash=?").bind(tokenHash).run();
}


async function ensureDashboardSessionTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();
}

export async function dashboardSessionStorageReady(env: Env): Promise<boolean> {
  try {
    await ensureDashboardSessionTable(env);
    await env.DB.prepare("SELECT token_hash FROM dashboard_sessions LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

export async function createDashboardSession(
  env: Env,
  tokenHash: string,
  expiresAt: number
): Promise<void> {
  await ensureDashboardSessionTable(env);
  await env.DB.prepare(
    "INSERT INTO dashboard_sessions(token_hash,expires_at,created_at) VALUES (?,?,?)"
  ).bind(tokenHash, expiresAt, Date.now()).run();
}

export async function getDashboardSession(
  env: Env,
  tokenHash: string
): Promise<DashboardSession | null> {
  await ensureDashboardSessionTable(env);
  return await env.DB.prepare(
    "SELECT token_hash,expires_at,created_at FROM dashboard_sessions WHERE token_hash=? AND expires_at>?"
  ).bind(tokenHash, Date.now()).first<DashboardSession>() ?? null;
}

export async function deleteDashboardSession(env: Env, tokenHash: string): Promise<void> {
  await ensureDashboardSessionTable(env);
  await env.DB.prepare("DELETE FROM dashboard_sessions WHERE token_hash=?").bind(tokenHash).run();
}

export async function getGuildSettings(env: Env, guildId: string): Promise<GuildSettings> {
  const row = await env.DB.prepare("SELECT config FROM guild_settings WHERE guild_id=?")
    .bind(guildId).first<{config:string}>();
  if (!row) return { ...DEFAULT_SETTINGS };
  let parsed: Partial<GuildSettings> = {};
  try { parsed = JSON.parse(row.config) as Partial<GuildSettings>; } catch {}
  return { ...DEFAULT_SETTINGS, ...parsed };
}

export async function saveGuildSettings(
  env: Env,
  guildId: string,
  patch: Partial<GuildSettings>
): Promise<GuildSettings> {
  const next = { ...(await getGuildSettings(env, guildId)), ...patch };
  await env.DB.prepare(`
    INSERT INTO guild_settings(guild_id, config, updated_at) VALUES (?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at
  `).bind(guildId, JSON.stringify(next), Date.now()).run();
  return next;
}

export async function listAllGuildSettings(env: Env, limit=20): Promise<Array<{guild_id:string;config:string}>> {
  const result = await env.DB.prepare(
    "SELECT guild_id, config FROM guild_settings ORDER BY updated_at DESC LIMIT ?"
  ).bind(limit).all<{guild_id:string;config:string}>();
  return result.results;
}

export async function listProducts(env: Env, guildId: string): Promise<ProductRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM products WHERE guild_id=? AND active=1 ORDER BY created_at DESC"
  ).bind(guildId).all<ProductRow>();
  return result.results;
}

export async function getProduct(env: Env, id: string): Promise<ProductRow | null> {
  return await env.DB.prepare("SELECT * FROM products WHERE id=?")
    .bind(id).first<ProductRow>() ?? null;
}

export async function createProduct(env: Env, row: ProductRow): Promise<ProductRow> {
  await env.DB.prepare(`
    INSERT INTO products(
      id,guild_id,name,description,price_yen,active,delivery_type,role_id,delivery_text,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id,row.guild_id,row.name,row.description,row.price_yen,row.active,
    row.delivery_type,row.role_id,row.delivery_text,row.created_at
  ).run();
  return row;
}

export async function deleteProduct(env: Env, guildId: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE products SET active=0 WHERE guild_id=? AND id=? AND active=1"
  ).bind(guildId,id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function createPayment(env: Env, row: PaymentRow): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO payments(
      id,merchant_payment_id,guild_id,user_id,product_id,status,paypay_url,
      amount_yen,created_at,updated_at,delivered_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id,row.merchant_payment_id,row.guild_id,row.user_id,row.product_id,row.status,
    row.paypay_url,row.amount_yen,row.created_at,row.updated_at,row.delivered_at
  ).run();
}

export async function getPaymentByMerchantId(env: Env, merchantId: string): Promise<PaymentRow | null> {
  return await env.DB.prepare("SELECT * FROM payments WHERE merchant_payment_id=?")
    .bind(merchantId).first<PaymentRow>() ?? null;
}

export async function listPendingPayments(env: Env, limit=10): Promise<PaymentRow[]> {
  const result = await env.DB.prepare(`
    SELECT * FROM payments
    WHERE delivered_at IS NULL
      AND created_at > ?
      AND status NOT IN ('CANCELED','EXPIRED','FAILED')
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(Date.now()-24*60*60_000,limit).all<PaymentRow>();
  return result.results;
}

export async function setPaymentStatus(env: Env, id:string, status:string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET status=?, updated_at=? WHERE id=?")
    .bind(status,Date.now(),id).run();
}

export async function markDelivered(env: Env, id:string): Promise<void> {
  await env.DB.prepare("UPDATE payments SET delivered_at=?, updated_at=? WHERE id=?")
    .bind(Date.now(),Date.now(),id).run();
}

export async function putChallenge(
  env:Env,id:string,guildId:string,userId:string,code:string
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO verification_challenges(id,guild_id,user_id,code,expires_at)
    VALUES (?,?,?,?,?)
  `).bind(id,guildId,userId,code,Date.now()+5*60_000).run();
}

export async function consumeChallenge(env:Env,id:string): Promise<{
  guild_id:string;user_id:string;code:string;expires_at:number
}|null> {
  const row=await env.DB.prepare(
    "SELECT guild_id,user_id,code,expires_at FROM verification_challenges WHERE id=?"
  ).bind(id).first<{guild_id:string;user_id:string;code:string;expires_at:number}>();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM verification_challenges WHERE id=?").bind(id).run();
  return row;
}

export async function getAuditCursor(env:Env,guildId:string): Promise<string|null> {
  const row=await env.DB.prepare("SELECT last_entry_id FROM audit_cursors WHERE guild_id=?")
    .bind(guildId).first<{last_entry_id:string|null}>();
  return row?.last_entry_id ?? null;
}

export async function setAuditCursor(env:Env,guildId:string,lastEntryId:string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_cursors(guild_id,last_entry_id,updated_at) VALUES (?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET
      last_entry_id=excluded.last_entry_id,
      updated_at=excluded.updated_at
  `).bind(guildId,lastEntryId,Date.now()).run();
}
