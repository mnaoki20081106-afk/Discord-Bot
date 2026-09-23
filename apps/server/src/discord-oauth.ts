import { env } from "./config.js";
import {
  updateSessionTokens,
  type WebSession
} from "./db.js";
import { decrypt, encrypt } from "./crypto.js";

const API = "https://discord.com/api/v10";

export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

export type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

function basicAuth(): string {
  return Buffer.from(
    `${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`
  ).toString("base64");
}

export function discordRedirectUri(): string {
  return `${env.API_PUBLIC_URL.replace(/\/$/, "")}/auth/discord/callback`;
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: discordRedirectUri(),
    scope: "identify guilds",
    state,
    prompt: "consent"
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function tokenRequest(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  if (!response.ok) {
    throw new Error(`Discord token exchange failed: ${response.status}`);
  }
  return response.json() as Promise<TokenResponse>;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: discordRedirectUri()
  }));
}

async function refreshToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  }));
}

export async function discordGet<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Discord API failed: ${response.status} ${path}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  return discordGet<DiscordUser>("/users/@me", accessToken);
}

export async function fetchDiscordGuilds(accessToken: string): Promise<DiscordGuild[]> {
  return discordGet<DiscordGuild[]>("/users/@me/guilds", accessToken);
}

export async function getValidAccessToken(session: WebSession): Promise<string> {
  const now = Date.now();
  if (session.token_expires_at.getTime() > now + 60_000) {
    return decrypt(session.access_token_enc);
  }

  const refreshed = await refreshToken(decrypt(session.refresh_token_enc));
  const accessEnc = encrypt(refreshed.access_token);
  const refreshEnc = encrypt(refreshed.refresh_token);
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  await updateSessionTokens(session.token_hash, accessEnc, refreshEnc, expiresAt);
  session.access_token_enc = accessEnc;
  session.refresh_token_enc = refreshEnc;
  session.token_expires_at = expiresAt;
  return refreshed.access_token;
}
