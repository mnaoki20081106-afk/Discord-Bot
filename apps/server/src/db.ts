import pg from "pg";
import { env } from "./config.js";

const { Pool } = pg;
export const pool = new Pool({ connectionString: env.DATABASE_URL });

export type GuildSettings = {
  securityEnabled: boolean;
  antiSpam: boolean;
  spamMax: number;
  spamWindowSeconds: number;
  blockInvites: boolean;
  mentionLimit: number;
  antiRaid: boolean;
  raidJoins: number;
  raidWindowSeconds: number;
  antiNuke: boolean;
  nukeActions: number;
  nukeWindowSeconds: number;
  logChannelId: string | null;
  verifiedRoleId: string | null;
  minAccountAgeDays: number;
  trustedUserIds: string[];
  trustedRoleIds: string[];
};

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
  trustedUserIds: [],
  trustedRoleIds: []
};

export type WebSession = {
  token_hash: string;
  user_id: string;
  username: string;
  avatar: string | null;
  access_token_enc: string;
  refresh_token_enc: string;
  token_expires_at: Date;
  expires_at: Date;
};

export type Product = {
  id: string;
  guild_id: string;
  name: string;
  description: string;
  price_yen: number;
  active: boolean;
  delivery_type: "role" | "text";
  role_id: string | null;
  delivery_text: string | null;
  created_at: Date;
};

export type Payment = {
  id: string;
  merchant_payment_id: string;
  guild_id: string;
  user_id: string;
  product_id: string;
  status: string;
  paypay_url: string | null;
  amount_yen: number;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
};

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar TEXT,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      token_expires_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions(user_id);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_yen INTEGER NOT NULL CHECK (price_yen > 0),
      active BOOLEAN NOT NULL DEFAULT true,
      delivery_type TEXT NOT NULL CHECK (delivery_type IN ('role', 'text')),
      role_id TEXT,
      delivery_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS products_guild_idx ON products(guild_id);

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      merchant_payment_id TEXT UNIQUE NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      status TEXT NOT NULL,
      paypay_url TEXT,
      amount_yen INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS payments_pending_idx
      ON payments(status, delivered_at, created_at);
  `);
}

export async function cleanExpiredAuth(): Promise<void> {
  await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");
  await pool.query("DELETE FROM web_sessions WHERE expires_at < now()");
}

export async function putOAuthState(state: string): Promise<void> {
  await pool.query(
    "INSERT INTO oauth_states(state, expires_at) VALUES ($1, now() + interval '10 minutes')",
    [state]
  );
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING state",
    [state]
  );
  return result.rowCount === 1;
}

export async function createSession(session: WebSession): Promise<void> {
  await pool.query(
    `INSERT INTO web_sessions(
      token_hash, user_id, username, avatar, access_token_enc, refresh_token_enc,
      token_expires_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      session.token_hash,
      session.user_id,
      session.username,
      session.avatar,
      session.access_token_enc,
      session.refresh_token_enc,
      session.token_expires_at,
      session.expires_at
    ]
  );
}

export async function getSession(tokenHash: string): Promise<WebSession | null> {
  const result = await pool.query<WebSession>(
    "SELECT * FROM web_sessions WHERE token_hash = $1 AND expires_at > now()",
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export async function updateSessionTokens(
  tokenHash: string,
  accessTokenEnc: string,
  refreshTokenEnc: string,
  tokenExpiresAt: Date
): Promise<void> {
  await pool.query(
    `UPDATE web_sessions
     SET access_token_enc=$2, refresh_token_enc=$3, token_expires_at=$4
     WHERE token_hash=$1`,
    [tokenHash, accessTokenEnc, refreshTokenEnc, tokenExpiresAt]
  );
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await pool.query("DELETE FROM web_sessions WHERE token_hash=$1", [tokenHash]);
}

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const result = await pool.query<{ config: Partial<GuildSettings> }>(
    "SELECT config FROM guild_settings WHERE guild_id=$1",
    [guildId]
  );
  return { ...DEFAULT_SETTINGS, ...(result.rows[0]?.config ?? {}) };
}

export async function saveGuildSettings(
  guildId: string,
  patch: Partial<GuildSettings>
): Promise<GuildSettings> {
  const current = await getGuildSettings(guildId);
  const next: GuildSettings = { ...current, ...patch };
  await pool.query(
    `INSERT INTO guild_settings(guild_id, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (guild_id)
     DO UPDATE SET config=EXCLUDED.config, updated_at=now()`,
    [guildId, JSON.stringify(next)]
  );
  return next;
}

export async function listProducts(guildId: string): Promise<Product[]> {
  const result = await pool.query<Product>(
    "SELECT * FROM products WHERE guild_id=$1 ORDER BY created_at DESC",
    [guildId]
  );
  return result.rows;
}

export async function getProduct(id: string): Promise<Product | null> {
  const result = await pool.query<Product>("SELECT * FROM products WHERE id=$1", [id]);
  return result.rows[0] ?? null;
}

export async function createProduct(product: Product): Promise<Product> {
  const result = await pool.query<Product>(
    `INSERT INTO products(
      id,guild_id,name,description,price_yen,active,delivery_type,role_id,delivery_text
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      product.id, product.guild_id, product.name, product.description, product.price_yen,
      product.active, product.delivery_type, product.role_id, product.delivery_text
    ]
  );
  return result.rows[0]!;
}

export async function deleteProduct(guildId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM products WHERE guild_id=$1 AND id=$2",
    [guildId, id]
  );
  return result.rowCount === 1;
}

export async function createPayment(payment: Payment): Promise<void> {
  await pool.query(
    `INSERT INTO payments(
      id,merchant_payment_id,guild_id,user_id,product_id,status,paypay_url,amount_yen
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      payment.id, payment.merchant_payment_id, payment.guild_id, payment.user_id,
      payment.product_id, payment.status, payment.paypay_url, payment.amount_yen
    ]
  );
}

export async function listUndeliveredPayments(): Promise<Payment[]> {
  const result = await pool.query<Payment>(
    `SELECT * FROM payments
     WHERE delivered_at IS NULL
       AND created_at > now() - interval '24 hours'
       AND status NOT IN ('CANCELED','EXPIRED','FAILED')
     ORDER BY created_at ASC
     LIMIT 50`
  );
  return result.rows;
}

export async function setPaymentStatus(id: string, status: string): Promise<void> {
  await pool.query(
    "UPDATE payments SET status=$2, updated_at=now() WHERE id=$1",
    [id, status]
  );
}

export async function markDelivered(id: string): Promise<void> {
  await pool.query(
    "UPDATE payments SET delivered_at=now(), updated_at=now() WHERE id=$1",
    [id]
  );
}
