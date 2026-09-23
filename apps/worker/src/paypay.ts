import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Env } from "./types";

function baseUrl(env:Env):string{
  if(env.PAYPAY_ENV==="production") return "https://apigw.paypay.ne.jp";
  if(env.PAYPAY_ENV==="staging") return "https://apigw.stg.paypay.ne.jp";
  return "https://apigw.sandbox.paypay.ne.jp";
}

function auth(env:Env,method:string,path:string,body?:string):{
  authorization:string;
  contentType?:string;
}{
  if(!env.PAYPAY_API_KEY||!env.PAYPAY_API_SECRET) throw new Error("PayPay not configured");
  const nonce=randomBytes(6).toString("hex");
  const epoch=Math.floor(Date.now()/1000).toString();
  const contentType=body===undefined?"empty":"application/json";
  const hash=body===undefined
    ?"empty"
    :createHash("md5").update(contentType,"utf8").update(body,"utf8").digest("base64");
  const toSign=[path,method.toUpperCase(),nonce,epoch,contentType,hash].join("\n");
  const mac=createHmac("sha256",env.PAYPAY_API_SECRET).update(toSign,"utf8").digest("base64");
  return {
    authorization:`hmac OPA-Auth:${env.PAYPAY_API_KEY}:${mac}:${nonce}:${epoch}:${hash}`,
    contentType:body===undefined?undefined:contentType
  };
}

async function request<T>(
  env:Env,method:string,path:string,bodyObject?:unknown
):Promise<T>{
  const body=bodyObject===undefined?undefined:JSON.stringify(bodyObject);
  const signed=auth(env,method,path,body);
  const headers=new Headers({Authorization:signed.authorization});
  if(signed.contentType) headers.set("Content-Type",signed.contentType);
  if(env.PAYPAY_MERCHANT_ID) headers.set("X-ASSUME-MERCHANT",env.PAYPAY_MERCHANT_ID);
  const response=await fetch(`${baseUrl(env)}${path}`,{method,headers,body});
  const payload=await response.json() as T;
  if(!response.ok) throw new Error(`PayPay ${response.status}`);
  return payload;
}

export function payPayConfigured(env:Env):boolean{
  return Boolean(env.PAYPAY_API_KEY&&env.PAYPAY_API_SECRET);
}

export async function createPayPayQr(
  env:Env,
  input:{merchantPaymentId:string;amountYen:number;description:string}
):Promise<{url:string}>{
  const payload=await request<{
    data?:{url?:string};
    resultInfo?:{code?:string}
  }>(env,"POST","/v2/codes",{
    merchantPaymentId:input.merchantPaymentId,
    amount:{amount:input.amountYen,currency:"JPY"},
    orderDescription:input.description.slice(0,255),
    codeType:"ORDER_QR",
    requestedAt:Math.floor(Date.now()/1000),
    isAuthorization:false
  });
  if(!payload.data?.url) throw new Error(`PayPay QR failed: ${payload.resultInfo?.code??"unknown"}`);
  return {url:payload.data.url};
}

export async function getPayPayStatus(env:Env,merchantPaymentId:string):Promise<string>{
  const path=`/v2/codes/payments/${encodeURIComponent(merchantPaymentId)}`;
  const payload=await request<{data?:{status?:string}}>(env,"GET",path);
  return payload.data?.status??"UNKNOWN";
}
