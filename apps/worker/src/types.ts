export interface Env {
  DB: D1Database;
  DISCORD_GATEWAY: DurableObjectNamespace;
  WEB_ORIGIN: string;
  WEB_PUBLIC_URL: string;
  PAYPAY_ENV: "sandbox" | "staging" | "production";
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_ENCRYPTION_KEY: string;
  DASHBOARD_PASSWORD: string;
  PAYPAY_API_KEY?: string;
  PAYPAY_API_SECRET?: string;
  PAYPAY_MERCHANT_ID?: string;
}

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
  ticketSupportRoleIds: string[];
  trustedUserIds: string[];
  trustedRoleIds: string[];
};

export type DashboardSession = {
  token_hash: string;
  expires_at: number;
  created_at: number;
};

export type SessionRow = {
  token_hash: string;
  user_id: string;
  username: string;
  avatar: string | null;
  access_token_enc: string;
  refresh_token_enc: string;
  token_expires_at: number;
  expires_at: number;
};

export type ProductRow = {
  id: string;
  guild_id: string;
  name: string;
  description: string;
  price_yen: number;
  active: number;
  delivery_type: "role" | "text";
  role_id: string | null;
  delivery_text: string | null;
  created_at: number;
};

export type PaymentRow = {
  id: string;
  merchant_payment_id: string;
  guild_id: string;
  user_id: string;
  product_id: string;
  status: string;
  paypay_url: string | null;
  amount_yen: number;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
};
