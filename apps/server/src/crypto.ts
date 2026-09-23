import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { env } from "./config.js";

const key = Buffer.from(env.SESSION_ENCRYPTION_KEY, "base64");
if (key.length !== 32) {
  throw new Error("SESSION_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string): string {
  const [ivRaw, tagRaw, cipherRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !cipherRaw) throw new Error("Invalid encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
