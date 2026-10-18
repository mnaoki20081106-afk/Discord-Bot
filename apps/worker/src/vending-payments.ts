import type { Env } from "./types";
import { decrypt, encrypt, randomId } from "./utils";

const PAYPAY_UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const KYASH_VERSION="11.8.1";

function payHeaders(extra?:Record<string,string>){
  return {
    "User-Agent":PAYPAY_UA,
    "Accept":"application/json, text/plain, */*",
    "Content-Type":"application/json",
    ...(extra??{})
  };
}

function payCode(link:string){
  return link.trim().replace(/^https:\/\/pay\.paypay\.ne\.jp\//,"").split(/[?#]/)[0] ?? "";
}

export async function payPayLoginStart(phone:string,password:string,uuid:string){
  const response=await fetch("https://www.paypay.ne.jp/app/v1/oauth/token",{
    method:"POST",
    headers:payHeaders({
      "Origin":"https://www.paypay.ne.jp",
      "Referer":"https://www.paypay.ne.jp/app/account/sign-in"
    }),
    body:JSON.stringify({
      scope:"SIGN_IN",client_uuid:uuid,grant_type:"password",username:phone,
      password,add_otp_prefix:true,language:"ja"
    })
  });
  return response.json() as Promise<any>;
}

export async function payPayLoginOtp(input:{uuid:string;otp:string;otpReferenceId:string;otpPrefix:string}){
  const response=await fetch("https://www.paypay.ne.jp/app/v1/oauth/token",{
    method:"POST",
    headers:payHeaders({
      "Origin":"https://www.paypay.ne.jp",
      "Referer":"https://www.paypay.ne.jp/app/account/sign-in"
    }),
    body:JSON.stringify({
      scope:"SIGN_IN",client_uuid:input.uuid,grant_type:"otp",
      otp_prefix:String(input.otpPrefix),otp:input.otp,
      otp_reference_id:input.otpReferenceId,username_type:"MOBILE",language:"ja"
    })
  });
  return response.json() as Promise<any>;
}

export async function checkPayPayLink(link:string){
  const code=payCode(link);
  const response=await fetch(
    "https://www.paypay.ne.jp/app/v2/p2p-api/getP2PLinkInfo?verificationCode="+encodeURIComponent(code),
    {headers:payHeaders()}
  );
  if(!response.ok) return null;
  const data:any=await response.json();
  if(data?.header?.resultCode!=="S0000") return null;
  return data;
}

export type PayPaySession={accessToken:string;cookies:Record<string,string>};

type PayPayAccount={
  phone:string;
  password:string;
  uuid:string;
  session?:PayPaySession|null;
  persistSession?:(session:PayPaySession)=>Promise<void>;
};

function mergeCookies(cookies:Record<string,string>,setCookie:string|null){
  if(!setCookie) return;
  // Workers joins multiple Set-Cookie headers with ", ". Split only where a new name=value starts.
  for(const part of setCookie.split(/,\s*(?=[^;,=\s]+=)/)){
    const pair=part.split(";")[0]?.trim()??"";
    const eq=pair.indexOf("=");
    if(eq>0) cookies[pair.slice(0,eq)]=pair.slice(eq+1);
  }
}

// PayPaython (WebAPI) puts the access token in the `token` cookie; there is no Authorization header.
function sessionCookie(session:PayPaySession):string{
  return cookieHeader({...session.cookies,token:session.accessToken});
}

function cookieHeader(cookies:Record<string,string>):string{
  return Object.entries(cookies).map(([name,value])=>`${name}=${value}`).join("; ");
}

// PayPay's receive endpoint expects JST wall-clock time with a fixed +0900 suffix.
function jstRequestAt():string{
  return new Date(Date.now()+9*3600_000).toISOString().slice(0,19)+"+0900";
}

async function payPayPasswordLogin(account:PayPayAccount,referer:string):Promise<PayPaySession|null>{
  const response=await fetch("https://www.paypay.ne.jp/app/v1/oauth/token",{
    method:"POST",
    headers:payHeaders({
      "Origin":"https://www.paypay.ne.jp",
      "Referer":referer
    }),
    body:JSON.stringify({
      scope:"SIGN_IN",client_uuid:account.uuid,grant_type:"password",
      username:account.phone,password:account.password,add_otp_prefix:true,language:"ja"
    })
  });
  const data:any=await response.json().catch(()=>null);
  // Without access_token PayPay is asking for OTP again; the seller has to re-run the OTP login.
  if(!data?.access_token) return null;
  const cookies:Record<string,string>={};
  mergeCookies(cookies,response.headers.get("set-cookie"));
  cookies.token=data.access_token;
  return {accessToken:data.access_token,cookies};
}

async function postAcceptP2PLink(payload:unknown,session:PayPaySession):Promise<{ok:boolean;authFailed:boolean}>{
  const response=await fetch("https://www.paypay.ne.jp/app/v2/p2p-api/acceptP2PSendMoneyLink",{
    method:"POST",
    headers:payHeaders({"Cookie":sessionCookie(session)}),
    body:JSON.stringify(payload)
  });
  mergeCookies(session.cookies,response.headers.get("set-cookie"));
  if(response.status===401||response.status===403) return {ok:false,authFailed:true};
  const data:any=await response.json().catch(()=>null);
  const code=data?.header?.resultCode;
  // WebAPI tokens last ~2h; PayPay answers an expired one with S0001 (or S9999) at HTTP 200.
  if(code==="S0001"||code==="S9999") return {ok:false,authFailed:true};
  return {ok:response.ok&&code==="S0000",authFailed:false};
}

export async function acceptPayPayLink(
  link:string,
  account:PayPayAccount,
):Promise<{ok:boolean;pending:boolean;amount:number;status:string}>{
  const code=payCode(link);
  const info:any=await checkPayPayLink(link);
  if(!info) return {ok:false,pending:false,amount:0,status:"INVALID"};
  const amount=Number(info?.payload?.message?.data?.amount??0);
  const status=String(info?.payload?.orderStatus??"UNKNOWN");
  if(info?.payload?.pendingP2PInfo?.isSetPasscode){
    return {ok:false,pending:false,amount,status:"PASSCODE_REQUIRED"};
  }
  if(status!=="PENDING") return {ok:false,pending:false,amount,status};

  // Reuse the seller's stored session. Password login (and its OTP exposure) only happens
  // when there is no session yet, or PayPay rejects the stored one with 401/403.
  const referer="https://pay.paypay.ne.jp/"+code;
  let session=account.session??null;
  if(!session) session=await payPayPasswordLogin(account,referer);
  if(!session) return {ok:false,pending:true,amount,status:"LOGIN_REQUIRED"};

  const data=info.payload.message.data;
  const receivePayload={
    verificationCode:code,
    client_uuid:account.uuid,
    requestAt:jstRequestAt(),
    requestId:data.requestId,
    orderId:data.orderId,
    senderMessageId:info.payload.message.messageId,
    senderChannelUrl:info.payload.message.chatRoomId,
    iosMinimumVersion:"3.45.0",
    androidMinimumVersion:"3.45.0"
  };

  let received=await postAcceptP2PLink(receivePayload,session);
  if(received.authFailed){
    // The stored session expired. A 401 means the request was not processed, so one retry is safe.
    session=await payPayPasswordLogin(account,referer);
    if(!session) return {ok:false,pending:true,amount,status:"LOGIN_REQUIRED"};
    received=await postAcceptP2PLink(receivePayload,session);
  }

  if(account.persistSession){
    try{
      await account.persistSession(session);
    }catch(error){
      console.error("PayPay session save failed",error);
    }
  }
  // Public link state cannot prove WHICH account received the money, so only the
  // authenticated acceptance response may authorize delivery. Anything else stays pending
  // and is re-checked while the link is still PENDING (e.g. until 受け取り保留 is released).
  const ok=received.ok;
  return {ok,pending:!ok,amount,status:ok?"COMPLETED":"PENDING"};
}

function kyashHeaders(clientUuid:string,installationUuid:string,accessToken?:string){
  const h:Record<string,string>={
    "Content-Type":"application/json","X-Kyash-Client-Id":clientUuid,
    "Accept":"application/json","X-Kyash-Device-Language":"ja",
    "X-Kyash-Client-Version":KYASH_VERSION,"X-Kyash-Device-Info":"iPhone 8, Version:16.7.5",
    "Accept-Language":"ja-jp","X-Kyash-Date":String(Math.round(Date.now()/1000)),
    "User-Agent":"Kyash/2 CFNetwork/1240.0.4 Darwin/20.6.0",
    "X-Kyash-Installation-Id":installationUuid,"X-Kyash-Os":"iOS"
  };
  if(accessToken) h["X-Auth"]=accessToken;
  return h;
}

export async function kyashLoginStart(email:string,password:string,clientUuid:string,installationUuid:string){
  const response=await fetch("https://api.kyash.me/v2/login",{
    method:"POST",headers:kyashHeaders(clientUuid,installationUuid),
    body:JSON.stringify({email,password})
  });
  return response.json() as Promise<any>;
}

export async function kyashLoginOtp(input:{email:string;otp:string;clientUuid:string;installationUuid:string}){
  const response=await fetch("https://api.kyash.me/v2/login/mobile/verify",{
    method:"POST",headers:kyashHeaders(input.clientUuid,input.installationUuid),
    body:JSON.stringify({verificationCode:input.otp,email:input.email})
  });
  return response.json() as Promise<any>;
}

export async function checkKyashLink(link:string){
  const url=link.includes("https://kyash.me/payments/")?link:"https://kyash.me/payments/"+link.trim();
  const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});
  if(!response.ok) return null;
  const html=await response.text();
  const amount=(html.match(/class=["'][^"']*amountText text_send[^"']*["'][^>]*>([^<]+)/i)?.[1]??"")
    .replace(/[¥,\s]/g,"");
  const raw=html.match(/data-href-app=["']kyash:\/\/claim\/([^"']+)/i)?.[1];
  if(!amount||!raw) return null;
  return {amount:Number(amount),uuid:raw};
}

export async function receiveKyashLink(link:string,account:{clientUuid:string;installationUuid:string;accessToken:string}){
  const info=await checkKyashLink(link);
  if(!info) return {ok:false,amount:0,status:"INVALID"};
  const response=await fetch("https://api.kyash.me/v1/links/"+encodeURIComponent(info.uuid)+"/receive",{
    method:"PUT",headers:kyashHeaders(account.clientUuid,account.installationUuid,account.accessToken)
  });
  const data:any=await response.json().catch(()=>null);
  return {ok:response.ok&&data?.code===200,amount:info.amount,status:data?.code===200?"COMPLETED":"FAILED"};
}

export async function saveKyashAccount(
  env:Env,userId:string,input:{email:string;password:string;clientUuid:string;installationUuid:string;accessToken:string}
){
  await env.DB.prepare("INSERT INTO vending_payment_accounts(user_id,kyash_email_enc,kyash_password_enc,kyash_client_uuid,kyash_installation_uuid,kyash_access_token_enc,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kyash_email_enc=excluded.kyash_email_enc,kyash_password_enc=excluded.kyash_password_enc,kyash_client_uuid=excluded.kyash_client_uuid,kyash_installation_uuid=excluded.kyash_installation_uuid,kyash_access_token_enc=excluded.kyash_access_token_enc,updated_at=excluded.updated_at")
    .bind(userId,await encrypt(env.SESSION_ENCRYPTION_KEY,input.email),await encrypt(env.SESSION_ENCRYPTION_KEY,input.password),input.clientUuid,input.installationUuid,await encrypt(env.SESSION_ENCRYPTION_KEY,input.accessToken),Date.now()).run();
}

export async function getKyashAccount(env:Env,userId:string){
  const r=await env.DB.prepare("SELECT kyash_client_uuid,kyash_installation_uuid,kyash_access_token_enc FROM vending_payment_accounts WHERE user_id=?").bind(userId).first<{kyash_client_uuid:string|null;kyash_installation_uuid:string|null;kyash_access_token_enc:string|null}>();
  if(!r?.kyash_client_uuid||!r.kyash_installation_uuid||!r.kyash_access_token_enc) return null;
  return {
    clientUuid:r.kyash_client_uuid,
    installationUuid:r.kyash_installation_uuid,
    accessToken:await decrypt(env.SESSION_ENCRYPTION_KEY,r.kyash_access_token_enc)
  };
}

export async function saveKyashChallenge(env:Env,userId:string,payload:unknown){
  const id=randomId();
  await env.DB.prepare("INSERT INTO vending_payment_login_challenges(id,user_id,provider,payload_enc,expires_at) VALUES (?,?,'kyash',?,?)")
    .bind(id,userId,await encrypt(env.SESSION_ENCRYPTION_KEY,JSON.stringify(payload)),Date.now()+5*60_000).run();
  return id;
}
export async function takeKyashChallenge(env:Env,id:string,userId:string){
  const r=await env.DB.prepare("SELECT payload_enc,expires_at FROM vending_payment_login_challenges WHERE id=? AND user_id=? AND provider='kyash'").bind(id,userId).first<{payload_enc:string;expires_at:number}>();
  if(!r||r.expires_at<Date.now()) return null;
  await env.DB.prepare("DELETE FROM vending_payment_login_challenges WHERE id=?").bind(id).run();
  return JSON.parse(await decrypt(env.SESSION_ENCRYPTION_KEY,r.payload_enc));
}
