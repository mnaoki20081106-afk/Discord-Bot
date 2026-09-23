import type { Env, GuildSettings, SessionRow } from "./types";
import { decrypt, encrypt, hexToBytes, toArrayBuffer } from "./utils";
import { updateSessionTokens } from "./db";

const API="https://discord.com/api/v10";

export type DiscordUser={
  id:string;
  username:string;
  global_name?:string|null;
  avatar?:string|null;
};

export type DiscordGuild={
  id:string;
  name:string;
  icon:string|null;
  owner:boolean;
  permissions:string;
};

export type DiscordChannel={
  id:string;
  name:string;
  type:number;
  guild_id?:string;
  parent_id?:string|null;
  topic?:string|null;
  position?:number;
  permission_overwrites?:Array<{
    id:string;
    type:number;
    allow:string;
    deny:string;
  }>;
};

export type DiscordRole={
  id:string;
  name:string;
  permissions:string;
  position:number;
  managed:boolean;
};

export class DiscordApiError extends Error {
  constructor(public status:number, message:string){ super(message); }
}

export async function botFetch(
  env:Env,
  path:string,
  init:RequestInit={}
):Promise<Response>{
  const headers=new Headers(init.headers);
  headers.set("Authorization",`Bot ${env.DISCORD_BOT_TOKEN.trim()}`);
  if(init.body&&!headers.has("Content-Type")) headers.set("Content-Type","application/json");
  return fetch(`${API}${path}`,{...init,headers});
}

export async function botJson<T>(
  env:Env,
  path:string,
  init:RequestInit={}
):Promise<T>{
  for(let attempt=0;attempt<3;attempt++){
    const response=await botFetch(env,path,init);

    if(response.status===429){
      const raw=await response.text().catch(()=>"");
      let retryAfterMs=1000;
      try{
        const payload=JSON.parse(raw) as {retry_after?:number};
        if(typeof payload.retry_after==="number"&&Number.isFinite(payload.retry_after)){
          retryAfterMs=Math.max(100,Math.ceil(payload.retry_after*1000));
        }
      }catch{
        const header=response.headers.get("Retry-After");
        const seconds=header?Number(header):NaN;
        if(Number.isFinite(seconds)) retryAfterMs=Math.max(100,Math.ceil(seconds*1000));
      }

      if(attempt<2){
        await new Promise(resolve=>setTimeout(resolve,retryAfterMs+50));
        continue;
      }
      throw new DiscordApiError(429, "Discord APIのレート制限中です。少し待って再試行してください");
    }

    if(!response.ok){
      const text=await response.text().catch(()=>"");
      throw new DiscordApiError(response.status, `Discord API ${response.status}: ${text.slice(0,300)}`);
    }
    if(response.status===204) return undefined as T;
    return response.json() as Promise<T>;
  }

  throw new Error("Discord API request failed");
}

export async function userJson<T>(path:string,accessToken:string):Promise<T>{
  const response=await fetch(`${API}${path}`,{
    headers:{Authorization:`Bearer ${accessToken}`}
  });
  if(!response.ok) throw new Error(`Discord user API ${response.status}`);
  return response.json() as Promise<T>;
}

function basic(env:Env):string{
  return btoa(`${env.DISCORD_APPLICATION_ID}:${env.DISCORD_CLIENT_SECRET}`);
}

export function oauthAuthorizeUrl(env:Env,origin:string,state:string):string{
  const redirect=`${origin}/auth/discord/callback`;
  const params=new URLSearchParams({
    client_id:env.DISCORD_APPLICATION_ID,
    response_type:"code",
    redirect_uri:redirect,
    scope:"identify guilds",
    state,
    prompt:"consent"
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function oauthToken(env:Env,params:URLSearchParams):Promise<{
  access_token:string;
  refresh_token:string;
  expires_in:number;
}>{
  const response=await fetch(`${API}/oauth2/token`,{
    method:"POST",
    headers:{
      Authorization:`Basic ${basic(env)}`,
      "Content-Type":"application/x-www-form-urlencoded"
    },
    body:params
  });
  if(!response.ok) throw new Error(`Discord OAuth ${response.status}`);
  return response.json();
}

export async function exchangeCode(env:Env,origin:string,code:string){
  return oauthToken(env,new URLSearchParams({
    grant_type:"authorization_code",
    code,
    redirect_uri:`${origin}/auth/discord/callback`
  }));
}

export async function validAccessToken(env:Env,session:SessionRow):Promise<string>{
  if(session.token_expires_at>Date.now()+60_000){
    return decrypt(env.SESSION_ENCRYPTION_KEY,session.access_token_enc);
  }
  const refreshed=await oauthToken(env,new URLSearchParams({
    grant_type:"refresh_token",
    refresh_token:await decrypt(env.SESSION_ENCRYPTION_KEY,session.refresh_token_enc)
  }));
  const accessEnc=await encrypt(env.SESSION_ENCRYPTION_KEY,refreshed.access_token);
  const refreshEnc=await encrypt(env.SESSION_ENCRYPTION_KEY,refreshed.refresh_token);
  const expiresAt=Date.now()+refreshed.expires_in*1000;
  await updateSessionTokens(env,session.token_hash,accessEnc,refreshEnc,expiresAt);
  session.access_token_enc=accessEnc;
  session.refresh_token_enc=refreshEnc;
  session.token_expires_at=expiresAt;
  return refreshed.access_token;
}

export function canManageGuild(guild:DiscordGuild):boolean{
  const permissions=BigInt(guild.permissions);
  return guild.owner||(permissions&8n)===8n||(permissions&32n)===32n;
}

export async function verifyInteraction(
  env:Env,
  request:Request,
  bodyText:string
):Promise<boolean>{
  const signature=request.headers.get("X-Signature-Ed25519");
  const timestamp=request.headers.get("X-Signature-Timestamp");
  if(!signature||!timestamp) return false;
  const key=await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(hexToBytes(env.DISCORD_PUBLIC_KEY)),
    {name:"Ed25519"} as AlgorithmIdentifier,
    false,
    ["verify"]
  );
  const message=new TextEncoder().encode(timestamp+bodyText);
  return crypto.subtle.verify(
    {name:"Ed25519"} as AlgorithmIdentifier,
    key,
    toArrayBuffer(hexToBytes(signature)),
    toArrayBuffer(message)
  );
}

export async function syncAutoMod(
  env:Env,
  guildId:string,
  settings:GuildSettings
):Promise<void>{
  const existing=await botJson<Array<{id:string;name:string}>>(
    env,`/guilds/${guildId}/auto-moderation/rules`
  ).catch(()=>[]);
  for(const rule of existing){
    if(rule.name.startsWith("DSM ")){
      await botFetch(env,`/guilds/${guildId}/auto-moderation/rules/${rule.id}`,{
        method:"DELETE"
      }).catch(()=>undefined);
    }
  }
  if(!settings.securityEnabled) return;

  const alertAction=settings.logChannelId
    ? [{type:2,metadata:{channel_id:settings.logChannelId}}]
    : [];
  const block=(message:string)=>[
    {type:1,metadata:{custom_message:message}},
    ...alertAction
  ];

  const rules:unknown[]=[];
  if(settings.antiSpam){
    rules.push({
      name:"DSM Anti-Spam",
      event_type:1,
      trigger_type:3,
      trigger_metadata:{},
      actions:block("スパムを検出しました。"),
      enabled:true
    });
  }
  if(settings.blockInvites){
    rules.push({
      name:"DSM Invite Guard",
      event_type:1,
      trigger_type:1,
      trigger_metadata:{
        keyword_filter:[
          "*discord.gg/*",
          "*discord.com/invite/*",
          "*discordapp.com/invite/*"
        ]
      },
      actions:block("外部Discord招待リンクは禁止されています。"),
      enabled:true
    });
  }
  rules.push({
    name:"DSM Mention Guard",
    event_type:1,
    trigger_type:5,
    trigger_metadata:{mention_total_limit:settings.mentionLimit},
    actions:block("大量メンションを検出しました。"),
    enabled:true
  });

  for(const rule of rules){
    await botJson(env,`/guilds/${guildId}/auto-moderation/rules`,{
      method:"POST",
      body:JSON.stringify(rule)
    }).catch(()=>undefined);
  }
}
