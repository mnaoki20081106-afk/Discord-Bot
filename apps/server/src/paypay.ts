import { createHash, createHmac, randomBytes } from "node:crypto";
import { env, payPayConfigured } from "./config.js";

type PayPayCreateResponse = {
  resultInfo?: { code?: string; message?: string };
  data?: {
    codeId?: string;
    url?: string;
    deeplink?: string;
    expiryDate?: number;
    merchantPaymentId?: string;
  };
};

type PayPayPaymentResponse = {
  resultInfo?: { code?: string; message?: string };
  data?: {
    paymentId?: string;
    status?: string;
    acceptedAt?: number;
    merchantPaymentId?: string;
  };
};

function baseUrl(): string {
  if (env.PAYPAY_ENV === "production") return "https://apigw.paypay.ne.jp";
  if (env.PAYPAY_ENV === "staging") return "https://apigw.stg.paypay.ne.jp";
  return "https://apigw.sandbox.paypay.ne.jp";
}

function authHeader(method: string, path: string, body?: string): string {
  if (!env.PAYPAY_API_KEY || !env.PAYPAY_API_SECRET) {
    throw new Error("PayPay is not configured");
  }

  const nonce = randomBytes(6).toString("hex");
  const epoch = Math.floor(Date.now() / 1000).toString();
  const hasBody = body !== undefined;
  const contentType = hasBody ? "application/json" : "empty";
  const bodyHash = hasBody
    ? createHash("md5")
        .update("application/json", "utf8")
        .update(body!, "utf8")
        .digest("base64")
    : "empty";

  const data = [path, method.toUpperCase(), nonce, epoch, contentType, bodyHash].join("\n");
  const mac = createHmac("sha256", env.PAYPAY_API_SECRET)
    .update(data, "utf8")
    .digest("base64");

  return `hmac OPA-Auth:${env.PAYPAY_API_KEY}:${mac}:${nonce}:${epoch}:${bodyHash}`;
}

async function request<T>(method: string, path: string, bodyObject?: unknown): Promise<T> {
  if (!payPayConfigured) throw new Error("PayPay is not configured");
  const body = bodyObject === undefined ? undefined : JSON.stringify(bodyObject);
  const headers: Record<string, string> = {
    Authorization: authHeader(method, path, body)
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (env.PAYPAY_MERCHANT_ID) headers["X-ASSUME-MERCHANT"] = env.PAYPAY_MERCHANT_ID;

  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body
  });
  const payload = await response.json() as T;
  if (!response.ok) {
    throw new Error(`PayPay API failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

export async function createPayPayQr(input: {
  merchantPaymentId: string;
  amountYen: number;
  description: string;
}): Promise<{ url: string; deeplink?: string; expiryDate?: number }> {
  const payload = await request<PayPayCreateResponse>("POST", "/v2/codes", {
    merchantPaymentId: input.merchantPaymentId,
    amount: { amount: input.amountYen, currency: "JPY" },
    orderDescription: input.description.slice(0, 255),
    codeType: "ORDER_QR",
    requestedAt: Math.floor(Date.now() / 1000),
    isAuthorization: false
  });

  if (!payload.data?.url) {
    throw new Error(`PayPay did not return a QR URL: ${payload.resultInfo?.code ?? "unknown"}`);
  }
  return {
    url: payload.data.url,
    deeplink: payload.data.deeplink,
    expiryDate: payload.data.expiryDate
  };
}

export async function getPayPayPaymentStatus(
  merchantPaymentId: string
): Promise<string> {
  const path = `/v2/codes/payments/${encodeURIComponent(merchantPaymentId)}`;
  const payload = await request<PayPayPaymentResponse>("GET", path);
  return payload.data?.status ?? "UNKNOWN";
}
