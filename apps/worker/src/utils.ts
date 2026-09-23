import type { Env } from "./types";

export function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.WEB_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Vary": "Origin"
  };
}

export function json(env: Env, data: unknown, status=200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(env), "Content-Type": "application/json; charset=utf-8" }
  });
}

export function withCors(env: Env, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key,value] of Object.entries(corsHeaders(env))) headers.set(key,String(value));
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export function randomToken(bytes=32): string {
  const data=new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64Url(data);
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function hexToBytes(hex:string): Uint8Array {
  if (hex.length%2!==0) throw new Error("Invalid hex");
  const out=new Uint8Array(hex.length/2);
  for(let i=0;i<out.length;i++) out[i]=Number.parseInt(hex.slice(i*2,i*2+2),16);
  return out;
}

export function toArrayBuffer(bytes:Uint8Array):ArrayBuffer {
  const copy=new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesToHex(bytes:ArrayBuffer|Uint8Array): string {
  const view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  return [...view].map(v=>v.toString(16).padStart(2,"0")).join("");
}

export function bytesToBase64(bytes:Uint8Array):string {
  let binary="";
  for(const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value:string):Uint8Array {
  const binary=atob(value);
  const out=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) out[i]=binary.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes:Uint8Array):string {
  return bytesToBase64(bytes).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

export async function sha256Hex(value:string):Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));
}

async function deriveAesKeyBytes(secret:string):Promise<Uint8Array> {
  const value=secret.trim();
  if(value.length<32){
    throw new Error("SESSION_ENCRYPTION_KEY must be at least 32 characters");
  }

  // Backward compatibility: keep using an existing 32-byte base64 secret as-is.
  try{
    if(/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length%4===0){
      const decoded=base64ToBytes(value);
      if(decoded.length===32) return decoded;
    }
  }catch{
    // Not valid legacy base64; fall through to passphrase derivation.
  }

  const digest=await crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(new TextEncoder().encode(value))
  );
  return new Uint8Array(digest);
}

async function aesKey(secret:string, usages:KeyUsage[]):Promise<CryptoKey> {
  const raw=await deriveAesKeyBytes(secret);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    {name:"AES-GCM"},
    false,
    usages
  );
}

export async function encrypt(secret:string,value:string):Promise<string> {
  const iv=new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key=await aesKey(secret,["encrypt"]);
  const encrypted=await crypto.subtle.encrypt(
    {name:"AES-GCM",iv:toArrayBuffer(iv)},
    key,
    toArrayBuffer(new TextEncoder().encode(value))
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function decrypt(secret:string,value:string):Promise<string> {
  const [ivRaw,cipherRaw]=value.split(".");
  if(!ivRaw||!cipherRaw) throw new Error("Invalid encrypted value");
  const decodeUrl=(v:string)=>base64ToBytes(v.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(v.length/4)*4,"="));
  const key=await aesKey(secret,["decrypt"]);
  const plain=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:toArrayBuffer(decodeUrl(ivRaw))},
    key,
    toArrayBuffer(decodeUrl(cipherRaw))
  );
  return new TextDecoder().decode(plain);
}

export function parseCookie(header:string|null,name:string):string|null {
  if(!header) return null;
  for(const part of header.split(";")){
    const [key,...rest]=part.trim().split("=");
    if(key===name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function accountCreatedAt(userId:string):number {
  return Number((BigInt(userId)>>22n)+1420070400000n);
}

export function snowflakeTime(id:string):number {
  return Number((BigInt(id)>>22n)+1420070400000n);
}

export function challengeCode():string {
  const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes=new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map(v=>alphabet[v%alphabet.length]).join("");
}
