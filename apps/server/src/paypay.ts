import { decrypt, encrypt } from "./crypto.js";
import {
  getPayPayAccountRow,
  savePayPaySession,
  type PayPayAccountRow
} from "./db.js";

// PayPay web API (PayPaython "WebAPI" flavour): password login with a saved client_uuid skips
// the SMS OTP, the access token travels in the `token` cookie and lives ~2h. No merchant/OPA API.

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const TOKEN_URL = "https://www.paypay.ne.jp/app/v1/oauth/token";
const P2P = "https://www.paypay.ne.jp/app/v2/p2p-api";

export type PayPaySession = { accessToken: string; cookies: Record<string, string> };
export type PayPayAccount = {
  guildId: string;
  phone: string;
  password: string;
  uuid: string;
  session: PayPaySession | null;
};
export type PayPayReceiveResult = {
  ok: boolean;
  pending: boolean;
  amount: number;
  status: string;
};

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    ...(extra ?? {})
  };
}

export function payCode(link: string): string {
  return link.trim().replace(/^https:\/\/pay\.paypay\.ne\.jp\//, "").split(/[?#]/)[0] ?? "";
}

function mergeCookies(cookies: Record<string, string>, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}

function cookieHeader(session: PayPaySession): string {
  return Object.entries({ ...session.cookies, token: session.accessToken })
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

// jstRequestAt: PayPay's receive endpoint wants JST wall-clock time with a fixed +0900 suffix.
function jstRequestAt(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19) + "+0900";
}

export async function payPayLoginStart(phone: string, password: string, uuid: string) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: headers({
      Origin: "https://www.paypay.ne.jp",
      Referer: "https://www.paypay.ne.jp/app/account/sign-in"
    }),
    body: JSON.stringify({
      scope: "SIGN_IN",
      client_uuid: uuid,
      grant_type: "password",
      username: phone,
      password,
      add_otp_prefix: true,
      language: "ja"
    })
  });
  return (await response.json().catch(() => ({}))) as Record<string, any>;
}

export async function payPayLoginOtp(input: {
  uuid: string;
  otp: string;
  otpReferenceId: string;
  otpPrefix: string;
}): Promise<PayPaySession | null> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: headers({
      Origin: "https://www.paypay.ne.jp",
      Referer: "https://www.paypay.ne.jp/app/account/sign-in"
    }),
    body: JSON.stringify({
      scope: "SIGN_IN",
      client_uuid: input.uuid,
      grant_type: "otp",
      otp_prefix: String(input.otpPrefix),
      otp: input.otp,
      otp_reference_id: input.otpReferenceId,
      username_type: "MOBILE",
      language: "ja"
    })
  });
  const data = (await response.json().catch(() => null)) as Record<string, any> | null;
  if (!data?.access_token) return null;
  const cookies: Record<string, string> = {};
  mergeCookies(cookies, response);
  cookies.token = data.access_token;
  return { accessToken: data.access_token, cookies };
}

async function passwordLogin(account: PayPayAccount, code: string): Promise<PayPaySession | null> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: headers({
      Origin: "https://www.paypay.ne.jp",
      Referer: `https://pay.paypay.ne.jp/${code}`
    }),
    body: JSON.stringify({
      scope: "SIGN_IN",
      client_uuid: account.uuid,
      grant_type: "password",
      username: account.phone,
      password: account.password,
      add_otp_prefix: true,
      language: "ja"
    })
  });
  const data = (await response.json().catch(() => null)) as Record<string, any> | null;
  // No access_token means PayPay wants the OTP again; the seller has to re-run /paypay-login.
  if (!data?.access_token) return null;
  const cookies: Record<string, string> = {};
  mergeCookies(cookies, response);
  cookies.token = data.access_token;
  return { accessToken: data.access_token, cookies };
}

export async function checkPayPayLink(link: string): Promise<Record<string, any> | null> {
  const response = await fetch(
    `${P2P}/getP2PLinkInfo?verificationCode=${encodeURIComponent(payCode(link))}`,
    { headers: headers() }
  );
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as Record<string, any> | null;
  return data?.header?.resultCode === "S0000" ? data : null;
}

async function postAccept(
  payload: unknown,
  session: PayPaySession
): Promise<{ ok: boolean; authFailed: boolean }> {
  const response = await fetch(`${P2P}/acceptP2PSendMoneyLink`, {
    method: "POST",
    headers: headers({ Cookie: cookieHeader(session) }),
    body: JSON.stringify(payload)
  });
  mergeCookies(session.cookies, response);
  if (response.status === 401 || response.status === 403) return { ok: false, authFailed: true };
  const data = (await response.json().catch(() => null)) as Record<string, any> | null;
  const code = data?.header?.resultCode;
  // Expired tokens come back as S0001 (or S9999) at HTTP 200.
  if (code === "S0001" || code === "S9999") return { ok: false, authFailed: true };
  return { ok: response.ok && code === "S0000", authFailed: false };
}

export async function loadPayPayAccount(guildId: string): Promise<PayPayAccount | null> {
  const row = await getPayPayAccountRow(guildId);
  return row ? rowToAccount(row) : null;
}

function rowToAccount(row: PayPayAccountRow): PayPayAccount {
  let session: PayPaySession | null = null;
  if (row.session_enc) {
    try {
      session = JSON.parse(decrypt(row.session_enc)) as PayPaySession;
    } catch {
      session = null;
    }
  }
  return {
    guildId: row.guild_id,
    phone: decrypt(row.phone_enc),
    password: decrypt(row.password_enc),
    uuid: row.client_uuid,
    session
  };
}

export function sealSession(session: PayPaySession): string {
  return encrypt(JSON.stringify(session));
}

/**
 * Receive a PayPay send-money link on the seller's stored session.
 * Password login (client_uuid => no OTP) only runs when there is no session or PayPay
 * rejects the stored token; the receive is then retried once on the fresh session.
 */
export async function acceptPayPayLink(
  link: string,
  account: PayPayAccount,
  expectedAmount = 1
): Promise<PayPayReceiveResult> {
  const code = payCode(link);
  const info = await checkPayPayLink(link);
  if (!info) return { ok: false, pending: false, amount: 0, status: "INVALID" };
  const amount = Number(info.payload?.message?.data?.amount ?? 0);
  const status = String(info.payload?.orderStatus ?? "UNKNOWN");
  if (!Number.isSafeInteger(amount) || amount < expectedAmount) {
    return { ok: false, pending: false, amount, status: "AMOUNT_INSUFFICIENT" };
  }
  if (info.payload?.pendingP2PInfo?.isSetPasscode) {
    return { ok: false, pending: false, amount, status: "PASSCODE_REQUIRED" };
  }
  // Public link state cannot prove WHICH account received the money; only an authenticated
  // acceptance response may authorize delivery, so anything but PENDING is never a success.
  if (status !== "PENDING") return { ok: false, pending: false, amount, status };

  let session = account.session;
  if (!session) session = await passwordLogin(account, code);
  if (!session) return { ok: false, pending: true, amount, status: "LOGIN_REQUIRED" };

  const data = info.payload.message.data;
  const receivePayload = {
    verificationCode: code,
    client_uuid: account.uuid,
    requestAt: jstRequestAt(),
    requestId: data.requestId,
    orderId: data.orderId,
    senderMessageId: info.payload.message.messageId,
    senderChannelUrl: info.payload.message.chatRoomId,
    iosMinimumVersion: "3.45.0",
    androidMinimumVersion: "3.45.0"
  };

  let received = await postAccept(receivePayload, session);
  if (received.authFailed) {
    session = await passwordLogin(account, code);
    if (!session) return { ok: false, pending: true, amount, status: "LOGIN_REQUIRED" };
    received = await postAccept(receivePayload, session);
  }

  await savePayPaySession(account.guildId, account.uuid, sealSession(session)).catch((error) =>
    console.error("PayPay session save failed", error)
  );
  // 受け取り保留 and other soft failures stay pending; the poller re-checks while the link is PENDING.
  return { ok: received.ok, pending: !received.ok, amount, status: received.ok ? "COMPLETED" : "PENDING" };
}
