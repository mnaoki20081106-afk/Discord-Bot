import type { Env, GuildSettings, PaymentRow, ProductRow, SessionRow } from "./types";
import {
  DEFAULT_SETTINGS,
  dashboardSessionStorageReady,
  cleanExpired,
  consumeOAuthState,
  createDashboardSession,
  createPayment,
  createProduct,
  createSession,
  deleteDashboardSession,
  deleteProduct,
  deleteSession,
  ensureSchema,
  getAuditCursor,
  getDashboardSession,
  getGuildSettings,
  getPaymentByMerchantId,
  getProduct,
  getSession,
  listAllGuildSettings,
  listBotGuildCache,
  listKnownGuildIds,
  listPendingPayments,
  listProducts,
  markDelivered,
  putOAuthState,
  replaceBotGuildCache,
  replaceBotGuildMembership,
  saveGuildSettings,
  setAuditCursor,
  setPaymentStatus
} from "./db";
import {
  DiscordApiError,
  botFetch,
  botJson,
  canManageGuild,
  exchangeCode,
  oauthAuthorizeUrl,
  syncAutoMod,
  userJson,
  validAccessToken,
  verifyInteraction,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordRole,
  type DiscordUser
} from "./discord";
import { createPayPayQr, getPayPayStatus, payPayConfigured } from "./paypay";
import {
  BackupHttpError,
  backupRestoreSweep,
  createVerificationRecoveryAuthorizeUrl,
  handleBackupApi,
  handleRecoveryOAuth,
  upgradeTrackedVerificationPanel,
  verificationPanelPayload
} from "./backup";
import { recordPanelDeployment } from "./backup-db";
import {
  handleVendingApi,
  handleVendingInteraction,
  handleVendingMedia,
  vendingSweep,
  VendingHttpError
} from "./vending";
import {
  getMemberActivitySettings,
  primeMemberActivity,
  saveMemberActivitySettings,
  sendMemberActivityTest
} from "./member-activity";
import { ensureDiscordGateway } from "./discord-gateway";
export { DiscordGateway } from "./discord-gateway";
import {
  openSecurityMaintenanceLease,
  securityBridgeConfigured,
  securityBridgeJson
} from "./security-bridge";
import {
  accountCreatedAt,
  corsHeaders,
  encrypt,
  json,
  parseCookie,
  randomId,
  randomToken,
  sha256Hex,
  snowflakeTime,
  withCors
} from "./utils";

const BOT_PERMISSIONS=(
  1n|32n|1024n|2048n|16384n|32768n|65536n|8192n|16n|134217728n|268435456n|
  2n|4n|1099511627776n|128n
).toString();

const DANGEROUS_PERMISSION_MASK=
  8n|32n|16n|268435456n|536870912n|4n|2n;

class HttpError extends Error {
  constructor(public status:number,message:string){super(message);}
}

type DashboardActor={
  user_id:string;
  username:string;
  avatar:null;
};

async function sessionFromRequest(request:Request,env:Env):Promise<DashboardActor>{
  const auth=request.headers.get("Authorization");
  if(!auth?.startsWith("Bearer ")) throw new HttpError(401,"ログインが必要です");
  const raw=auth.slice(7).trim();
  const row=await getDashboardSession(env,await sha256Hex(raw));
  if(!row) throw new HttpError(401,"セッションが失効しています");
  return {user_id:"shared-dashboard",username:"共同管理者",avatar:null};
}

async function requireMainSecurityLease(
  env:Env,
  guildId:string,
  scope:"dashboard_edit"|"restore"="dashboard_edit",
  seconds=30
):Promise<void>{
  if(!securityBridgeConfigured(env)) return;
  try{
    await openSecurityMaintenanceLease(env,guildId,scope,seconds);
  }catch(error){
    console.error("security maintenance lease failed",guildId,scope,error);
    throw new HttpError(
      503,
      "Security Botとの安全な操作許可を確立できませんでした。誤検知防止のため操作を中止しました"
    );
  }
}

async function requireGuild(
  request:Request,env:Env,guildId:string,_requireBot=true
):Promise<{session:DashboardActor;guild:{id:string;name:string;icon:string|null}}>{
  const session=await sessionFromRequest(request,env);
  const guild=await botJson<{id:string;name:string;icon:string|null}>(env,`/guilds/${guildId}`);
  if(request.method!=="GET"){
    await requireMainSecurityLease(env,guildId,"dashboard_edit",30);
  }
  return {session,guild};
}

function bodyObject<T=Record<string,unknown>>(request:Request):Promise<T>{
  return request.json() as Promise<T>;
}

type DiscordGuildMember={
  roles:string[];
};

const PANEL_PERMISSION_MASK=1024n|2048n|16384n;
const BOT_CHANNEL_GUARD_MASK=
  PANEL_PERMISSION_MASK|32768n|65536n|8192n|16n|268435456n;

function fallbackBotMember(
  botId:string,
  roles:DiscordRole[]
):DiscordGuildMember{
  return {
    roles:roles
      .filter(role=>role.tags?.bot_id===botId)
      .map(role=>role.id)
  };
}

async function getBotGuildMember(
  env:Env,
  guildId:string,
  roles:DiscordRole[]
):Promise<DiscordGuildMember>{
  const botId=env.DISCORD_APPLICATION_ID.trim();
  try{
    return await botJson<DiscordGuildMember>(
      env,
      `/guilds/${guildId}/members/${botId}`
    );
  }catch{
    return fallbackBotMember(botId,roles);
  }
}

function botBasePermissions(
  guildId:string,
  roles:DiscordRole[],
  member:DiscordGuildMember
):bigint{
  let permissions=BigInt(
    roles.find(role=>role.id===guildId)?.permissions??"0"
  );
  for(const roleId of member.roles){
    const role=roles.find(item=>item.id===roleId);
    if(role) permissions|=BigInt(role.permissions||"0");
  }
  return permissions;
}

function compareRoleHierarchy(a:DiscordRole,b:DiscordRole):number{
  if(a.position!==b.position) return a.position>b.position?1:-1;
  if(a.id===b.id) return 0;
  // Discord permits duplicate role positions. For equal positions, roles are
  // ordered by snowflake ID; this matches discord.js RoleManager comparison.
  return BigInt(a.id)<BigInt(b.id)?1:-1;
}

function highestMemberRole(
  roles:DiscordRole[],
  member:DiscordGuildMember
):DiscordRole|null{
  let highest:DiscordRole|null=null;
  for(const role of roles){
    if(!member.roles.includes(role.id)) continue;
    if(!highest||compareRoleHierarchy(role,highest)>0) highest=role;
  }
  return highest;
}

function botChannelPermissions(
  guildId:string,
  botId:string,
  roles:DiscordRole[],
  member:DiscordGuildMember,
  channel:DiscordChannel
):bigint{
  let permissions=botBasePermissions(guildId,roles,member);
  if((permissions&8n)===8n) return permissions|PANEL_PERMISSION_MASK;

  const overwrites=channel.permission_overwrites??[];
  const everyone=overwrites.find(
    overwrite=>overwrite.id===guildId&&overwrite.type===0
  );
  if(everyone){
    permissions&=~BigInt(everyone.deny||"0");
    permissions|=BigInt(everyone.allow||"0");
  }

  let roleAllow=0n;
  let roleDeny=0n;
  for(const roleId of member.roles){
    const overwrite=overwrites.find(
      item=>item.id===roleId&&item.type===0
    );
    if(!overwrite) continue;
    roleAllow|=BigInt(overwrite.allow||"0");
    roleDeny|=BigInt(overwrite.deny||"0");
  }
  permissions&=~roleDeny;
  permissions|=roleAllow;

  const memberOverwrite=overwrites.find(
    overwrite=>overwrite.id===botId&&overwrite.type===1
  );
  if(memberOverwrite){
    permissions&=~BigInt(memberOverwrite.deny||"0");
    permissions|=BigInt(memberOverwrite.allow||"0");
  }

  return permissions;
}

async function writeBotChannelGuard(
  env:Env,
  channel:DiscordChannel,
  allow:bigint,
  deny:bigint
):Promise<void>{
  const botId=env.DISCORD_APPLICATION_ID.trim();
  try{
    await botJson<void>(
      env,
      `/channels/${channel.id}/permissions/${botId}`,
      {
        method:"PUT",
        body:JSON.stringify({
          type:1,
          allow:allow.toString(),
          deny:deny.toString()
        })
      }
    );
    return;
  }catch(error){
    if(!(error instanceof DiscordApiError)||error.status!==403) throw error;
  }

  // A bot that has just lost View Channel can receive Missing Access from the
  // single-overwrite endpoint. As a recovery path, preserve every canonical
  // overwrite from the guild channel list and replace only this bot member's
  // overwrite through Modify Channel.
  const repairedOverwrites=[
    ...(channel.permission_overwrites??[])
      .filter(overwrite=>!(overwrite.id===botId&&overwrite.type===1))
      .map(overwrite=>({
        id:overwrite.id,
        type:overwrite.type,
        allow:overwrite.allow,
        deny:overwrite.deny
      })),
    {
      id:botId,
      type:1,
      allow:allow.toString(),
      deny:deny.toString()
    }
  ];
  await botJson<DiscordChannel>(
    env,
    `/channels/${channel.id}`,
    {
      method:"PATCH",
      body:JSON.stringify({permission_overwrites:repairedOverwrites})
    }
  );
}

async function protectBotChannelAccess(
  env:Env,
  guildId:string,
  channel:DiscordChannel
):Promise<void>{
  const botId=env.DISCORD_APPLICATION_ID.trim();
  const current=(channel.permission_overwrites??[]).find(
    overwrite=>overwrite.id===botId&&overwrite.type===1
  );
  let allow=BigInt(current?.allow??"0");
  let deny=BigInt(current?.deny??"0");
  const alreadyProtected=
    (allow&BOT_CHANNEL_GUARD_MASK)===BOT_CHANNEL_GUARD_MASK&&
    (deny&BOT_CHANNEL_GUARD_MASK)===0n;
  if(alreadyProtected) return;

  allow|=BOT_CHANNEL_GUARD_MASK;
  deny&=~BOT_CHANNEL_GUARD_MASK;

  try{
    await writeBotChannelGuard(env,channel,allow,deny);
  }catch(error){
    if(error instanceof DiscordApiError&&error.status===403){
      throw new HttpError(
        409,
        "この変更を保存するとBOT自身がチャンネルから締め出される可能性があるため停止しました。対象カテゴリ/チャンネルでBOTの「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」「ロールの管理」を確認してください"
      );
    }
    throw error;
  }
}

type BotAccessRepairResult={
  administrator:boolean;
  checked:number;
  repaired:number;
  failed:Array<{id:string;name:string;status:number}>;
};

async function repairBotChannelAccess(
  env:Env,
  guildId:string
):Promise<BotAccessRepairResult>{
  const [roles,initialChannels]=await Promise.all([
    botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`),
    botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`)
  ]);
  const member=await getBotGuildMember(env,guildId,roles);
  const administrator=(botBasePermissions(guildId,roles,member)&8n)===8n;
  const supported=(channel:DiscordChannel)=>[0,2,4,5,13,15,16].includes(channel.type);
  const initialSupported=initialChannels.filter(supported);
  if(administrator){
    return {administrator:true,checked:initialSupported.length,repaired:0,failed:[]};
  }

  const botId=env.DISCORD_APPLICATION_ID.trim();
  const repairedIds=new Set<string>();
  const failedById=new Map<string,{id:string;name:string;status:number}>();

  const ensureGuard=async(channel:DiscordChannel)=>{
    const current=(channel.permission_overwrites??[]).find(
      overwrite=>overwrite.id===botId&&overwrite.type===1
    );
    let allow=BigInt(current?.allow??"0");
    let deny=BigInt(current?.deny??"0");
    const alreadyProtected=
      (allow&BOT_CHANNEL_GUARD_MASK)===BOT_CHANNEL_GUARD_MASK&&
      (deny&BOT_CHANNEL_GUARD_MASK)===0n;
    if(alreadyProtected) return;

    allow|=BOT_CHANNEL_GUARD_MASK;
    deny&=~BOT_CHANNEL_GUARD_MASK;
    try{
      await requireMainSecurityLease(env,guildId,"dashboard_edit",45);
      await writeBotChannelGuard(env,channel,allow,deny);
      repairedIds.add(channel.id);
      failedById.delete(channel.id);
    }catch(error){
      if(error instanceof DiscordApiError){
        failedById.set(channel.id,{
          id:channel.id,
          name:channel.name,
          status:error.status
        });
        return;
      }
      throw error;
    }
  };

  // Protect categories first. Discord propagates category permission changes to
  // channels that are still synchronized with that category. We then refetch so
  // synchronized children are not unnecessarily given their own overwrite.
  for(const category of initialSupported.filter(channel=>channel.type===4)){
    await ensureGuard(category);
  }

  // Only refetch after a category was actually changed. In steady state this
  // keeps the scheduled guard lightweight, while still preserving category
  // synchronization when a repair propagates to child channels.
  const channelsForChildren=repairedIds.size>0
    ?await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`)
    :initialChannels;
  for(const channel of channelsForChildren.filter(
    item=>supported(item)&&item.type!==4
  )){
    await ensureGuard(channel);
  }

  return {
    administrator:false,
    checked:channelsForChildren.filter(supported).length,
    repaired:repairedIds.size,
    failed:[...failedById.values()]
  };
}

async function botAccessGuardSweep(env:Env):Promise<void>{
  // Do not consume Discord's /users/@me/guilds rate-limit bucket from the
  // every-minute cron. The dashboard owns live guild-list refreshes; the guard
  // can safely operate on recently cached/known guild IDs.
  const [cached,configured]=await Promise.all([
    listBotGuildCache(env,24*60*60_000).catch(()=>[]),
    listAllGuildSettings(env,200).catch(()=>[])
  ]);
  const guildIds=[...new Set([
    ...cached.map(guild=>guild.id),
    ...configured.map(row=>row.guild_id)
  ])];

  for(const guildId of guildIds){
    try{
      const result=await repairBotChannelAccess(env,guildId);
      if(result.failed.length>0){
        console.warn(
          "bot access guard: repair incomplete",
          guildId,
          result.failed
        );
      }
    }catch(error){
      console.error("bot access guard: guild repair failed",guildId,error);
    }
  }
}

type ChannelPermissionKey=
  "view"|"send"|"history"|"react"|"files"|"embeds"|"appCommands"|"polls"|
  "createPublicThreads"|"createPrivateThreads"|"sendInThreads"|"manageThreads"|
  "manageMessages"|"mentionEveryone"|"externalEmojis"|"externalStickers"|
  "voiceMessages"|"createInvite"|"manageWebhooks"|"pinMessages"|"bypassSlowmode"|
  "connect"|"speak"|"stream"|"useVad"|"soundboard"|"externalSounds"|
  "setVoiceStatus"|"prioritySpeaker"|"muteMembers"|"deafenMembers"|"moveMembers"|
  "threads";
type ChannelPermissionMode="inherit"|"allow"|"deny";
type ChannelPermissionPatch=Partial<Record<ChannelPermissionKey,ChannelPermissionMode>>;

const CHANNEL_PERMISSION_BITS:Record<ChannelPermissionKey,bigint>={
  view:1024n,
  send:2048n,
  history:65536n,
  react:64n,
  files:32768n,
  embeds:16384n,
  appCommands:2147483648n,
  polls:562949953421312n,
  createPublicThreads:34359738368n,
  createPrivateThreads:68719476736n,
  sendInThreads:274877906944n,
  manageThreads:17179869184n,
  manageMessages:8192n,
  mentionEveryone:131072n,
  externalEmojis:262144n,
  externalStickers:137438953472n,
  voiceMessages:70368744177664n,
  createInvite:1n,
  manageWebhooks:536870912n,
  pinMessages:2251799813685248n,
  bypassSlowmode:4503599627370496n,
  connect:1048576n,
  speak:2097152n,
  stream:512n,
  useVad:33554432n,
  soundboard:4398046511104n,
  externalSounds:35184372088832n,
  setVoiceStatus:281474976710656n,
  prioritySpeaker:256n,
  muteMembers:4194304n,
  deafenMembers:8388608n,
  moveMembers:16777216n,
  threads:34359738368n
};

async function botFetchInteractive(
  env:Env,
  path:string,
  init:RequestInit={}
):Promise<Response>{
  const controller=new AbortController();
  const timeoutId=setTimeout(()=>controller.abort(),7_000);
  try{
    const response=await botFetch(env,path,{...init,signal:controller.signal});
    if(response.status===429){
      const raw=await response.text().catch(()=>"");
      let retryAfterSeconds:number|null=null;
      try{
        const payload=JSON.parse(raw) as {retry_after?:number};
        if(typeof payload.retry_after==="number"&&Number.isFinite(payload.retry_after)){
          retryAfterSeconds=Math.max(1,Math.ceil(payload.retry_after));
        }
      }catch{
        const header=response.headers.get("Retry-After");
        const parsed=header?Number(header):NaN;
        if(Number.isFinite(parsed)) retryAfterSeconds=Math.max(1,Math.ceil(parsed));
      }
      throw new HttpError(
        429,
        retryAfterSeconds
          ? `Discordのレート制限中です。約${retryAfterSeconds}秒後にもう一度保存してください`
          : "Discordのレート制限中です。少し待ってもう一度保存してください"
      );
    }
    return response;
  }catch(error){
    if(controller.signal.aborted){
      throw new HttpError(
        504,
        "Discord APIの応答が7秒以内に返りませんでした。権限変更は確定していないため、もう一度保存してください"
      );
    }
    throw error;
  }finally{
    clearTimeout(timeoutId);
  }
}

async function applyChannelRolePermissionsFast(
  env:Env,
  guildId:string,
  channel:DiscordChannel,
  targetId:string,
  permissions:ChannelPermissionPatch
):Promise<{allow:string;deny:string;changed:boolean}>{
  if(channel.guild_id&&channel.guild_id!==guildId){
    throw new HttpError(404,"対象チャンネルがこのサーバーに見つかりません");
  }

  // Denying View Channel can immediately hide the channel from the bot.
  // Protect the bot with a direct member overwrite before applying the role deny.
  if(permissions.view==="deny"){
    const botId=env.DISCORD_APPLICATION_ID.trim();
    const botOverwrite=(channel.permission_overwrites??[]).find(
      overwrite=>overwrite.id===botId&&overwrite.type===1
    );
    let botAllow=BigInt(botOverwrite?.allow??"0");
    let botDeny=BigInt(botOverwrite?.deny??"0");
    const protectedAlready=
      (botAllow&BOT_CHANNEL_GUARD_MASK)===BOT_CHANNEL_GUARD_MASK&&
      (botDeny&BOT_CHANNEL_GUARD_MASK)===0n;

    if(!protectedAlready){
      botAllow|=BOT_CHANNEL_GUARD_MASK;
      botDeny&=~BOT_CHANNEL_GUARD_MASK;
      const guardResponse=await botFetchInteractive(
        env,
        `/channels/${channel.id}/permissions/${botId}`,
        {
          method:"PUT",
          body:JSON.stringify({
            type:1,
            allow:botAllow.toString(),
            deny:botDeny.toString()
          })
        }
      );
      if(!guardResponse.ok){
        const detail=await guardResponse.text().catch(()=>"");
        if(guardResponse.status===403){
          throw new HttpError(
            409,
            "BOTのアクセス保護を設定できないため保存を停止しました。BOTロールに「チャンネルの管理」と「ロールの管理」を許可してください"
          );
        }
        throw new DiscordApiError(
          guardResponse.status,
          "Discord API "+guardResponse.status+": "+detail.slice(0,300)
        );
      }
    }
  }

  const current=(channel.permission_overwrites??[]).find(
    overwrite=>overwrite.id===targetId&&overwrite.type===0
  );
  let allow=BigInt(current?.allow??"0");
  let deny=BigInt(current?.deny??"0");
  const beforeAllow=allow;
  const beforeDeny=deny;

  for(const [rawKey,mode] of Object.entries(permissions)){
    if(!(rawKey in CHANNEL_PERMISSION_BITS)) continue;
    if(mode!=="inherit"&&mode!=="allow"&&mode!=="deny") continue;
    const bit=CHANNEL_PERMISSION_BITS[rawKey as ChannelPermissionKey];
    allow&=~bit;
    deny&=~bit;
    if(mode==="allow") allow|=bit;
    if(mode==="deny") deny|=bit;
  }

  if(allow===beforeAllow&&deny===beforeDeny){
    return {allow:allow.toString(),deny:deny.toString(),changed:false};
  }

  const response=
    allow===0n&&deny===0n
      ? current
        ? await botFetchInteractive(
            env,
            `/channels/${channel.id}/permissions/${targetId}`,
            {method:"DELETE"}
          )
        : null
      : await botFetchInteractive(
          env,
          `/channels/${channel.id}/permissions/${targetId}`,
          {
            method:"PUT",
            body:JSON.stringify({
              type:0,
              allow:allow.toString(),
              deny:deny.toString()
            })
          }
        );

  if(response&&!response.ok){
    const detail=await response.text().catch(()=>"");
    if(response.status===403){
      throw new HttpError(
        403,
        "Discordが権限変更を拒否しました。BOTロールの「チャンネルの管理」と「ロールの管理」、および対象チャンネルへのアクセスを確認してください"
      );
    }
    throw new DiscordApiError(
      response.status,
      "Discord API "+response.status+": "+detail.slice(0,300)
    );
  }

  return {allow:allow.toString(),deny:deny.toString(),changed:true};
}

async function applyChannelRolePermissions(
  env:Env,
  guildId:string,
  channel:DiscordChannel,
  targetId:string,
  roles:DiscordRole[],
  member:DiscordGuildMember,
  permissions:ChannelPermissionPatch
):Promise<{allow:string;deny:string}>{
  const botId=env.DISCORD_APPLICATION_ID.trim();
  const botAdministrator=(botBasePermissions(guildId,roles,member)&8n)===8n;

  if(!botAdministrator&&targetId!==botId){
    const targetCanAffectBot=targetId===guildId||member.roles.includes(targetId);
    if(targetCanAffectBot){
      const effective=botChannelPermissions(
        guildId,
        botId,
        roles,
        member,
        channel
      );
      const botCanManageChannel=
        (effective&16n)===16n||
        (botBasePermissions(guildId,roles,member)&16n)===16n;
      if(!botCanManageChannel){
        throw new HttpError(
          409,
          "このチャンネルの権限を変更するとBOT自身が締め出される可能性があります。対象カテゴリ/チャンネルでBOTの「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」を確認してください"
        );
      }
      await protectBotChannelAccess(env,guildId,channel);
    }
  }

  const current=(channel.permission_overwrites??[]).find(
    overwrite=>overwrite.id===targetId&&overwrite.type===0
  );
  let allow=BigInt(current?.allow??"0");
  let deny=BigInt(current?.deny??"0");

  for(const [rawKey,mode] of Object.entries(permissions)){
    if(!(rawKey in CHANNEL_PERMISSION_BITS)) continue;
    if(mode!=="inherit"&&mode!=="allow"&&mode!=="deny") continue;
    const key=rawKey as ChannelPermissionKey;
    const bit=CHANNEL_PERMISSION_BITS[key];
    allow&=~bit;
    deny&=~bit;
    if(mode==="allow") allow|=bit;
    if(mode==="deny") deny|=bit;
  }

  try{
    if(allow===0n&&deny===0n){
      if(current){
        const response=await botFetch(
          env,
          `/channels/${channel.id}/permissions/${targetId}`,
          {method:"DELETE"}
        );
        if(!response.ok){
          const detail=await response.text().catch(()=>"");
          throw new DiscordApiError(
            response.status,
            "Discord API "+response.status+": "+detail.slice(0,300)
          );
        }
      }
    }else{
      await botJson(
        env,
        `/channels/${channel.id}/permissions/${targetId}`,
        {
          method:"PUT",
          body:JSON.stringify({
            type:0,
            allow:allow.toString(),
            deny:deny.toString()
          })
        }
      );
    }
  }catch(error){
    if(error instanceof DiscordApiError&&error.status===403){
      throw new HttpError(
        403,
        "Discordがこのチャンネルの権限変更を拒否しました。対象カテゴリ/チャンネルでBOTの「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」「ロールの管理」を確認してください"
      );
    }
    throw error;
  }

  return {allow:allow.toString(),deny:deny.toString()};
}

function channelPermissionPatchMatches(
  channel:DiscordChannel,
  targetId:string,
  permissions:ChannelPermissionPatch
):boolean{
  const overwrite=(channel.permission_overwrites??[]).find(
    item=>item.id===targetId&&item.type===0
  );
  const allow=BigInt(overwrite?.allow??"0");
  const deny=BigInt(overwrite?.deny??"0");

  for(const [rawKey,mode] of Object.entries(permissions)){
    if(!(rawKey in CHANNEL_PERMISSION_BITS)) continue;
    if(mode!=="inherit"&&mode!=="allow"&&mode!=="deny") continue;
    const bit=CHANNEL_PERMISSION_BITS[rawKey as ChannelPermissionKey];
    if(mode==="allow"&&((allow&bit)!==bit||(deny&bit)!==0n)) return false;
    if(mode==="deny"&&((deny&bit)!==bit||(allow&bit)!==0n)) return false;
    if(mode==="inherit"&&((allow&bit)!==0n||(deny&bit)!==0n)) return false;
  }
  return true;
}

async function discordMeta(env:Env,guildId:string){
  let channels:DiscordChannel[];
  let roles:DiscordRole[];
  let member:DiscordGuildMember;

  const channelsPromise=botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  const rolesPromise=botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`);

  try{
    channels=await channelsPromise;
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    throw new HttpError(502,"Discordチャンネル一覧の取得に失敗しました: "+detail.slice(0,220));
  }

  try{
    roles=await rolesPromise;
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    throw new HttpError(502,"Discordロール一覧の取得に失敗しました: "+detail.slice(0,220));
  }

  member=await getBotGuildMember(env,guildId,roles);

  const basePermissions=botBasePermissions(guildId,roles,member);
  const botAdministrator=(basePermissions&8n)===8n;
  const botId=env.DISCORD_APPLICATION_ID.trim();

  return {
    botAdministrator,
    channels:channels
      .filter(c=>[0,2,5,13,15,16].includes(c.type))
      .sort((a,b)=>(a.position??0)-(b.position??0))
      .map(c=>{
        const effective=botChannelPermissions(guildId,botId,roles,member,c);
        const botCanView=(effective&1024n)===1024n;
        const botCanPost=
          botCanView&&
          (effective&2048n)===2048n&&
          (effective&16384n)===16384n;
        return {
          id:c.id,
          name:c.name,
          type:
            c.type===2?"voice":
            c.type===5?"announcement":
            c.type===13?"stage":
            c.type===15?"forum":
            c.type===16?"media":"text",
          parentId:c.parent_id??null,
          topic:c.topic??"",
          position:c.position??0,
          botCanView,
          botCanPost,
          permissionOverwrites:(c.permission_overwrites??[]).map(overwrite=>({
            id:overwrite.id,
            type:overwrite.type,
            allow:overwrite.allow,
            deny:overwrite.deny
          }))
        };
      }),
    categories:channels
      .filter(c=>c.type===4)
      .sort((a,b)=>(a.position??0)-(b.position??0))
      .map(c=>({
        id:c.id,
        name:c.name,
        position:c.position??0
      })),
    roles:roles
      .filter(r=>!r.managed)
      .sort((a,b)=>b.position-a.position)
      .map(r=>({
        id:r.id,
        name:r.name,
        position:r.position,
        color:r.color??0,
        permissions:r.permissions,
        isEveryone:r.id===guildId
      }))
  };
}

async function sendMessage(
  env:Env,channelId:string,payload:unknown
):Promise<{id?:string}>{
  return botJson<{id?:string}>(env,`/channels/${channelId}/messages`,{
    method:"POST",
    body:JSON.stringify(payload)
  });
}

async function sendPanelMessage(
  env:Env,
  guildId:string,
  channelId:string,
  payload:unknown
):Promise<{id?:string}>{
  try{
    return await sendMessage(env,channelId,payload);
  }catch(error){
    if(error instanceof DiscordApiError&&error.status===403){
      throw new HttpError(
        403,
        "BOTがこのチャンネルから締め出されています。対象カテゴリ/チャンネルの権限にBOTを追加して「チャンネルを見る」を一度許可し、管理画面を再読み込みしてください。以後はBOTアクセス保護を自動適用します。Administratorは必須ではありません"
      );
    }
    throw error;
  }
}

async function publishVerificationPanel(
  env:Env,guildId:string,channelId:string,workerOrigin:string
){
  const message=await sendPanelMessage(
    env,guildId,channelId,verificationPanelPayload(workerOrigin,guildId)
  );
  await recordPanelDeployment(env,{
    guildId,kind:"verification",channelId,messageId:message.id??null
  });
}

async function publishTicketPanel(env:Env,guildId:string,channelId:string){
  const message=await sendPanelMessage(env,guildId,channelId,{
    embeds:[{
      title:"サポート",
      description:"問い合わせ用チケットを作成します。",
      color:5793266
    }],
    components:[{
      type:1,
      components:[{
        type:2,
        custom_id:"ticket:create",
        label:"チケットを作成",
        style:1
      }]
    }]
  });
  await recordPanelDeployment(env,{
    guildId,kind:"ticket",channelId,messageId:message.id??null
  });
}

async function requireMessageChannel(env:Env,guildId:string,channelId:string):Promise<void>{
  if(!/^\d+$/.test(channelId)) throw new HttpError(400,"設置先チャンネルが不正です");

  let channels:DiscordChannel[];
  try{
    channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    throw new HttpError(
      502,
      "設置先チャンネル一覧の取得に失敗しました: "+detail.slice(0,220)
    );
  }

  const channel=channels.find(item=>item.id===channelId);
  if(!channel){
    throw new HttpError(
      404,
      "設置先チャンネルが見つかりません。チャンネル一覧を再読み込みしてください"
    );
  }
  if(![0,5].includes(channel.type)){
    throw new HttpError(
      400,
      "パネルはテキストまたはアナウンスチャンネルに設置してください"
    );
  }
}

async function publishProductPanel(env:Env,guildId:string,channelId:string,product:ProductRow){
  const message=await sendMessage(env,channelId,{
    embeds:[{
      title:product.name,
      description:product.description||"購入ボタンからPayPay決済へ進めます。",
      color:443221,
      fields:[{name:"価格",value:`¥${product.price_yen.toLocaleString("ja-JP")}`}]
    }],
    components:[{
      type:1,
      components:[{
        type:2,
        custom_id:`buy:${product.id}`,
        label:"PayPayで購入",
        style:3
      }]
    }]
  });
  await recordPanelDeployment(env,{
    guildId,kind:"product",objectId:product.id,channelId,messageId:message.id??null
  });
}

async function ensureRole(env:Env,guildId:string,name:string,permissions="0"):Promise<DiscordRole>{
  const roles=await botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`);
  const existing=roles.find(r=>r.name===name);
  if(existing) return existing;
  return botJson(env,`/guilds/${guildId}/roles`,{
    method:"POST",
    body:JSON.stringify({name,permissions})
  });
}

async function ensureCategory(env:Env,guildId:string,name:string):Promise<DiscordChannel>{
  const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  const existing=channels.find(c=>c.type===4&&c.name===name);
  if(existing) return existing;
  return botJson(env,`/guilds/${guildId}/channels`,{
    method:"POST",
    body:JSON.stringify({
      name,
      type:4,
      permission_overwrites:[{
        id:env.DISCORD_APPLICATION_ID.trim(),
        type:1,
        allow:BOT_CHANNEL_GUARD_MASK.toString()
      }]
    })
  });
}

async function ensureText(
  env:Env,guildId:string,name:string,parentId:string,
  options?:{readOnly?:boolean;privateRoleId?:string}
):Promise<void>{
  const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  if(channels.some(c=>c.type===0&&c.name===name&&c.parent_id===parentId)) return;
  const overwrites:Array<Record<string,unknown>>=[{
    id:env.DISCORD_APPLICATION_ID.trim(),
    type:1,
    allow:BOT_CHANNEL_GUARD_MASK.toString()
  }];
  if(options?.readOnly){
    overwrites.push({id:guildId,type:0,deny:"2048"});
  }
  if(options?.privateRoleId){
    overwrites.push(
      {id:guildId,type:0,deny:"1024"},
      {id:options.privateRoleId,type:0,allow:(1024n|2048n|65536n).toString()}
    );
  }
  await botJson(env,`/guilds/${guildId}/channels`,{
    method:"POST",
    body:JSON.stringify({
      name,type:0,parent_id:parentId,
      permission_overwrites:overwrites
    })
  });
}

async function applyTemplate(env:Env,guildId:string,template:string){
  if(template==="community"){
    const verified=await ensureRole(env,guildId,"Verified");
    const moderator=await ensureRole(env,guildId,"Moderator",(8192n|1099511627776n|2n).toString());
    const start=await ensureCategory(env,guildId,"START HERE");
    const community=await ensureCategory(env,guildId,"COMMUNITY");
    const staff=await ensureCategory(env,guildId,"STAFF");
    await ensureText(env,guildId,"welcome",start.id,{readOnly:true});
    await ensureText(env,guildId,"rules",start.id,{readOnly:true});
    await ensureText(env,guildId,"general",community.id);
    await ensureText(env,guildId,"media",community.id);
    await ensureText(env,guildId,"staff-chat",staff.id,{privateRoleId:moderator.id});
    await saveGuildSettings(env,guildId,{verifiedRoleId:verified.id});
    return;
  }
  if(template==="shop"){
    await ensureRole(env,guildId,"Customer");
    const support=await ensureRole(env,guildId,"Support",(8192n|1099511627776n).toString());
    const shop=await ensureCategory(env,guildId,"SHOP");
    const help=await ensureCategory(env,guildId,"SUPPORT");
    await ensureText(env,guildId,"announcements",shop.id,{readOnly:true});
    await ensureText(env,guildId,"products",shop.id,{readOnly:true});
    await ensureText(env,guildId,"orders",shop.id);
    await ensureText(env,guildId,"open-ticket",help.id);
    await ensureText(env,guildId,"support-staff",help.id,{privateRoleId:support.id});
    return;
  }
  const support=await ensureRole(env,guildId,"Support",(8192n|1099511627776n).toString());
  const category=await ensureCategory(env,guildId,"SUPPORT");
  await ensureText(env,guildId,"faq",category.id,{readOnly:true});
  await ensureText(env,guildId,"open-ticket",category.id);
  await ensureText(env,guildId,"staff-support",category.id,{privateRoleId:support.id});
}

function interactionResponse(data:unknown):Response{
  return new Response(JSON.stringify(data),{
    headers:{"Content-Type":"application/json"}
  });
}

function ephemeral(content:string,components?:unknown[]){
  return {
    type:4,
    data:{
      content,
      flags:64,
      ...(components?{components}:{})
    }
  };
}

function deferredEphemeral():Response{
  return interactionResponse({
    type:5,
    data:{flags:64}
  });
}

function interactionCustomId(interaction:any):string{
  return String(interaction?.data?.custom_id??"");
}

function isVendingInteraction(interaction:any):boolean{
  return (
    (interaction?.type===3||interaction?.type===5)&&
    interactionCustomId(interaction).startsWith("vm:")
  );
}

function shouldDeferInteraction(interaction:any):boolean{
  const id=interactionCustomId(interaction);
  if(interaction?.type===2){
    return interaction?.data?.name==="security-status";
  }
  if(interaction?.type===3){
    if(
      id==="ticket:create"||
      id.startsWith("verify:start:")||
      id.startsWith("buy:")
    ) return true;

    if(id.startsWith("vm:")){
      // These two component actions must return a modal as the initial response,
      // so they cannot be deferred.
      if(id.startsWith("vm:product:")||id.startsWith("vm:pay:")) return false;
      return true;
    }
  }

  // Vending modal submissions can involve D1, external payment APIs and Discord
  // REST calls. Always acknowledge them first and finish in the background.
  return interaction?.type===5&&id.startsWith("vm:");
}

async function patchOriginalInteraction(
  interaction:any,
  data:Record<string,unknown>
):Promise<void>{
  const applicationId=String(interaction?.application_id??"");
  const token=String(interaction?.token??"");
  if(!applicationId||!token) throw new Error("interaction callback metadata missing");

  const url=
    "https://discord.com/api/v10/webhooks/"+
    encodeURIComponent(applicationId)+"/"+
    encodeURIComponent(token)+
    "/messages/@original";

  let lastError:unknown=null;
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();
    let timeoutId:ReturnType<typeof setTimeout>|undefined;
    try{
      const request=fetch(url,{
        method:"PATCH",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(data),
        signal:controller.signal
      });
      const timeout=new Promise<Response>((_,reject)=>{
        timeoutId=setTimeout(()=>{
          controller.abort();
          reject(new Error("deferred interaction update timed out"));
        },5_000);
      });
      const response=await Promise.race([request,timeout]);
      if(!response.ok){
        const detail=await response.text().catch(()=>"");
        throw new Error(
          "Discord deferred update "+response.status+": "+detail.slice(0,240)
        );
      }
      return;
    }catch(error){
      lastError=error;
      if(attempt===0) await new Promise(resolve=>setTimeout(resolve,150));
    }finally{
      if(timeoutId!==undefined) clearTimeout(timeoutId);
    }
  }
  throw lastError instanceof Error?lastError:new Error(String(lastError));
}

async function finishDeferredInteraction(
  interaction:any,
  result:Response
):Promise<void>{
  let payload:any=null;
  try{
    payload=await result.json();
  }catch{
    // Fall through to a safe generic message.
  }

  if(payload?.type===4&&payload?.data){
    const data={...payload.data};
    delete data.flags;
    await patchOriginalInteraction(interaction,data);
    return;
  }

  await patchOriginalInteraction(interaction,{
    content:"処理は完了しました。",
    components:[]
  });
}

async function failDeferredInteraction(
  interaction:any,
  error:unknown
):Promise<void>{
  console.error("deferred interaction failed",{
    interactionId:String(interaction?.id??""),
    type:interaction?.type,
    customId:interactionCustomId(interaction),
    error:error instanceof Error?error.message:String(error)
  });
  try{
    await patchOriginalInteraction(interaction,{
      content:"処理中にエラーが発生しました。もう一度お試しください。",
      components:[]
    });
  }catch(updateError){
    console.error(
      "deferred interaction error response failed",
      updateError instanceof Error?updateError.message:String(updateError)
    );
  }
}

async function deliverPayment(env:Env,payment:PaymentRow):Promise<void>{
  if(payment.delivered_at) return;
  const product=await getProduct(env,payment.product_id);
  if(!product) throw new Error("Product missing");
  if(product.delivery_type==="role"){
    if(!product.role_id) throw new Error("Role product misconfigured");
    await botJson(env,`/guilds/${payment.guild_id}/members/${payment.user_id}/roles/${product.role_id}`,{
      method:"PUT"
    });
  }else{
    if(!product.delivery_text) throw new Error("Text product misconfigured");
    const dm=await botJson<{id:string}>(env,"/users/@me/channels",{
      method:"POST",
      body:JSON.stringify({recipient_id:payment.user_id})
    });
    await sendMessage(env,dm.id,{
      content:`「${product.name}」の購入ありがとうございます。\n\n${product.delivery_text}`
    });
  }
  await markDelivered(env,payment.id);
}

async function confirmAndDeliver(env:Env,payment:PaymentRow):Promise<void>{
  const status=await getPayPayStatus(env,payment.merchant_payment_id);
  await setPaymentStatus(env,payment.id,status);
  if(status==="COMPLETED") await deliverPayment(env,{...payment,status});
}

async function createTicketFromInteraction(env:Env,interaction:any):Promise<Response>{
  const guildId=interaction.guild_id as string;
  const userId=interaction.member?.user?.id as string;
  const username=(interaction.member?.user?.username as string)||userId.slice(-6);
  const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  const topic=`dsm-ticket:${userId}`;
  const existing=channels.find(c=>c.type===0&&c.topic===topic);
  if(existing) return interactionResponse(ephemeral(`既にチケットがあります: <#${existing.id}>`));
  const [roles,settings]=await Promise.all([
    botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`),
    getGuildSettings(env,guildId)
  ]);
  const configuredIds=settings.ticketSupportRoleIds??[];
  const supportRoles=configuredIds.length
    ?roles.filter(role=>configuredIds.includes(role.id))
    :roles.filter(role=>role.name==="Support").slice(0,1);
  const safe=username.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,18)||userId.slice(-6);
  const overwrites:Array<Record<string,unknown>>=[
    {id:guildId,type:0,deny:"1024"},
    {id:userId,type:1,allow:(1024n|2048n|65536n|32768n).toString()},
    {id:env.DISCORD_APPLICATION_ID.trim(),type:1,allow:BOT_CHANNEL_GUARD_MASK.toString()}
  ];
  for(const role of supportRoles){
    overwrites.push({
      id:role.id,
      type:0,
      allow:(1024n|2048n|65536n|32768n).toString()
    });
  }
  const channel=await botJson<DiscordChannel>(env,`/guilds/${guildId}/channels`,{
    method:"POST",
    headers:{"X-Audit-Log-Reason":"Discord Main Bot: ticket created"},
    body:JSON.stringify({
      name:`ticket-${safe}`,
      type:0,
      topic,
      permission_overwrites:overwrites
    })
  });
  await sendMessage(env,channel.id,{
    content:`<@${userId}> サポート担当者が対応します。${supportRoles.length?" 対応者ロール: "+supportRoles.map(role=>"@"+role.name).join(" / "):""}`,
    components:[{
      type:1,
      components:[{type:2,custom_id:"ticket:close",label:"チケットを閉じる",style:4}]
    }]
  });
  return interactionResponse(ephemeral(`作成しました: <#${channel.id}>`));
}

async function processInteraction(
  interaction:any,
  request:Request,
  env:Env,
  ctx:ExecutionContext
):Promise<Response>{
  if(isVendingInteraction(interaction)){
    const vendingResponse=await handleVendingInteraction(interaction,env,ctx);
    if(vendingResponse) return vendingResponse;
  }

  if(interaction.type===2){
    const name=interaction.data?.name;
    if(name==="dashboard") return interactionResponse(ephemeral(`管理画面: ${env.WEB_PUBLIC_URL}`));
    if(name==="security-status"&&interaction.guild_id){
      await ensureSchema(env);
      const s=await getGuildSettings(env,interaction.guild_id);
      return interactionResponse(ephemeral(
        `Security: ${s.securityEnabled?"ON":"OFF"}\nAutoMod Spam: ${s.antiSpam?"ON":"OFF"}\nAnti-Nuke: ${s.antiNuke?"ON":"OFF"}`
      ));
    }
    return interactionResponse(ephemeral("このコマンドは管理画面から操作してください。"));
  }

  if(interaction.type===3){
    const id=interaction.data?.custom_id as string;
    if(id?.startsWith("verify:start:")){
      await ensureSchema(env);
      const guildId=id.split(":")[2]!;
      const userId=String(interaction.member?.user?.id??"");
      const settings=await getGuildSettings(env,guildId);
      if(!settings.verifiedRoleId){
        return interactionResponse(ephemeral("認証ロールが設定されていません。"));
      }
      const minAccountAgeDays=Math.max(
        0,
        Math.min(36500,Math.trunc(Number(settings.minAccountAgeDays)||0))
      );
      if(Date.now()-accountCreatedAt(userId)<minAccountAgeDays*86400000){
        return interactionResponse(ephemeral(
          `作成から${minAccountAgeDays}日未満のアカウントは認証できません。`
        ));
      }
      const verificationUrl=await createVerificationRecoveryAuthorizeUrl(
        env,new URL(request.url).origin,guildId,userId
      );
      return interactionResponse(ephemeral(
        "下のボタンからDiscord認証を完了してください。認証ロール付与と復旧用メンバー登録が同時に行われます。",
        [{
          type:1,
          components:[{
            type:2,style:5,label:"Discordで認証",url:verificationUrl
          }]
        }]
      ));
    }
    if(id==="ticket:create"){
      await ensureSchema(env);
      const guildId=String(interaction.guild_id??"");
      if(guildId) await requireMainSecurityLease(env,guildId,"dashboard_edit",30);
      return createTicketFromInteraction(env,interaction);
    }
    if(id==="ticket:close"){
      const guildId=String(interaction.guild_id??"");
      if(guildId) await requireMainSecurityLease(env,guildId,"dashboard_edit",30);
      const channelId=interaction.channel_id as string;
      ctx.waitUntil(botFetch(env,`/channels/${channelId}`,{
        method:"DELETE",
        headers:{"X-Audit-Log-Reason":"Discord Main Bot: ticket closed"}
      }).then(()=>undefined));
      return interactionResponse(ephemeral("チケットを閉じます。"));
    }
    if(id?.startsWith("buy:")){
      await ensureSchema(env);
      const product=await getProduct(env,id.slice(4));
      if(!product||!product.active||product.guild_id!==interaction.guild_id){
        return interactionResponse(ephemeral("この商品は現在購入できません。"));
      }
      if(!payPayConfigured(env)) return interactionResponse(ephemeral("PayPayがまだ設定されていません。"));
      const merchantPaymentId=`dsm_${Date.now()}_${randomToken(6).replace(/[^a-zA-Z0-9_-]/g,"")}`;
      const qr=await createPayPayQr(env,{
        merchantPaymentId,
        amountYen:product.price_yen,
        description:product.name
      });
      const payment:PaymentRow={
        id:randomId(),
        merchant_payment_id:merchantPaymentId,
        guild_id:interaction.guild_id,
        user_id:interaction.member.user.id,
        product_id:product.id,
        status:"CREATED",
        paypay_url:qr.url,
        amount_yen:product.price_yen,
        created_at:Date.now(),
        updated_at:Date.now(),
        delivered_at:null
      };
      await createPayment(env,payment);
      return interactionResponse(ephemeral(
        `**${product.name}** — ¥${product.price_yen.toLocaleString("ja-JP")}\n支払い完了後、自動で納品されます。`,
        [{
          type:1,
          components:[{type:2,style:5,label:"PayPayで支払う",url:qr.url}]
        }]
      ));
    }
  }

  return interactionResponse(ephemeral("未対応の操作です。"));
}

async function handleInteraction(
  request:Request,env:Env,ctx:ExecutionContext
):Promise<Response>{
  const startedAt=Date.now();
  const text=await request.text();
  if(!(await verifyInteraction(env,request,text))){
    return new Response("invalid signature",{status:401});
  }

  const interaction=JSON.parse(text) as any;
  if(interaction.type===1) return interactionResponse({type:1});

  if(shouldDeferInteraction(interaction)){
    const cfRay=request.headers.get("CF-Ray")??"";
    console.log("interaction deferred",{
      interactionId:String(interaction?.id??""),
      type:interaction?.type,
      customId:interactionCustomId(interaction),
      ackPreparationMs:Date.now()-startedAt,
      cfRay
    });

    ctx.waitUntil(
      processInteraction(interaction,request,env,ctx)
        .then(result=>finishDeferredInteraction(interaction,result))
        .catch(error=>failDeferredInteraction(interaction,error))
    );
    return deferredEphemeral();
  }

  return processInteraction(interaction,request,env,ctx);
}

async function registerCommands(env:Env):Promise<void>{
  await botJson(env,`/applications/${env.DISCORD_APPLICATION_ID}/commands`,{
    method:"PUT",
    body:JSON.stringify([
      {name:"dashboard",description:"管理ダッシュボードを開きます",type:1},
      {name:"security-status",description:"セキュリティ設定を表示します",type:1}
    ])
  });
}

async function handleDashboardLogin(request:Request,env:Env):Promise<Response>{
  if(!env.DASHBOARD_PASSWORD) throw new HttpError(503,"管理画面パスワードが未設定です");
  const input=await bodyObject<{password?:string}>(request);
  const password=String(input.password??"");
  if(!password) throw new HttpError(400,"パスワードを入力してください");
  const [actual,expected]=await Promise.all([
    sha256Hex(password),
    sha256Hex(env.DASHBOARD_PASSWORD)
  ]);
  if(actual!==expected) throw new HttpError(401,"パスワードが違います");
  const rawSession=randomToken(32);
  const expiresAt=Date.now()+30*24*60*60_000;
  try{
    await createDashboardSession(env,await sha256Hex(rawSession),expiresAt);
  }catch(error){
    console.error("dashboard session creation failed",error);
    throw new HttpError(500,"管理セッションの保存に失敗しました");
  }
  return json(env,{token:rawSession,expiresAt});
}

type DashboardGuild = { id:string; name:string; icon:string|null };

async function recoverKnownBotGuilds(
  env:Env,
  candidateIds:string[]
):Promise<{guilds:DashboardGuild[];transientFailure:boolean}>{
  const ids=[...new Set(candidateIds.filter(id=>/^\d+$/.test(id)))].slice(0,50);
  const guilds:DashboardGuild[]=[];
  let transientFailure=false;

  for(let offset=0;offset<ids.length;offset+=5){
    const batch=ids.slice(offset,offset+5);
    const results=await Promise.all(batch.map(async id=>{
      try{
        return await botJson<DashboardGuild>(env,`/guilds/${id}`);
      }catch(error){
        if(
          error instanceof DiscordApiError&&
          [401,403,404].includes(error.status)
        ){
          return null;
        }
        transientFailure=true;
        return null;
      }
    }));
    for(const guild of results){
      if(guild) guilds.push(guild);
    }
  }

  return {guilds,transientFailure};
}

async function securityRecoveryGuilds(
  env:Env,
  candidateIds:string[]
):Promise<Array<DashboardGuild & {botInstalled:false}>>{
  if(!securityBridgeConfigured(env)) return [];
  const result:Array<DashboardGuild & {botInstalled:false}>=[];
  for(const id of [...new Set(candidateIds)].slice(0,20)){
    if(!/^\d+$/.test(id)) continue;
    try{
      const overview=await securityBridgeJson<any>(
        env,
        `/internal/guilds/${id}/overview?limit=1`
      );
      if(overview?.installed){
        result.push({
          id,
          name:"Security Bot導入済みサーバー",
          icon:null,
          botInstalled:false
        });
      }
    }catch{
      // Recovery hint is best-effort; never block normal guild loading.
    }
  }
  return result;
}

async function handleApi(request:Request,env:Env,url:URL):Promise<Response>{
  if(url.pathname==="/api/status"&&request.method==="GET"){
    let discordReady=false;
    let discordUser:string|null=null;
    let discordError:string|null=null;
    try{
      const bot=await botJson<{id:string;username:string}>(env,"/users/@me");
      discordReady=true;
      discordUser=bot.username;
    }catch(error){
      discordError=error instanceof Error?error.message:String(error);
    }
    return json(env,{
      discordReady,
      discordUser,
      discordError,
      guildCount:null,
      dashboardPasswordConfigured:Boolean(env.DASHBOARD_PASSWORD),
      payPayConfigured:payPayConfigured(env),
      payPayEnvironment:env.PAYPAY_ENV,
      runtime:"cloudflare-workers",
      inviteUrl:
        `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APPLICATION_ID}`+
        `&permissions=${BOT_PERMISSIONS}&integration_type=0&scope=bot%20applications.commands`
    });
  }

  if(url.pathname==="/api/me"&&request.method==="GET"){
    const s=await sessionFromRequest(request,env);
    return json(env,{id:s.user_id,username:s.username,avatar:s.avatar});
  }

  const securityCenter=url.pathname.match(/^\/api\/guilds\/(\d+)\/security-center$/);
  if(securityCenter){
    const guildId=securityCenter[1]!;
    await requireGuild(request,env,guildId);
    if(request.method==="GET"){
      if(!securityBridgeConfigured(env)){
        return json(env,{
          configured:false,
          settings:null,
          status:{connected:false,lastHeartbeatAck:null,lastEventAt:null,reconnectAttempts:0,botUserId:null},
          incidents:[],
          lockdown:{active:false,expiresAt:null,reason:null}
        });
      }
      try{
        await securityBridgeJson(
          env,
          `/internal/guilds/${guildId}/service-bots`,
          {
            method:"POST",
            body:JSON.stringify({botId:env.DISCORD_APPLICATION_ID,kind:"main"})
          }
        );
        return json(env,await securityBridgeJson(
          env,
          `/internal/guilds/${guildId}/overview?limit=30`
        ));
      }catch(error){
        console.error("security center overview failed",error);
        // This endpoint feeds a dedicated dashboard state. Returning a
        // successful envelope lets the UI render "Security Bot unreachable"
        // instead of the shared API client converting the response into a
        // generic exception before SecurityManager can inspect it.
        return json(env,{
          configured:true,
          unreachable:true,
          message:error instanceof Error?error.message:String(error),
          settings:null,
          status:{connected:false,lastHeartbeatAck:null,lastEventAt:null,reconnectAttempts:0,botUserId:null},
          incidents:[],
          lockdown:{active:false,expiresAt:null,reason:null}
        });
      }
    }
    if(request.method==="PUT"){
      if(!securityBridgeConfigured(env)) throw new HttpError(503,"Security Botがまだ接続されていません");
      const body=await request.text();
      const saved=await securityBridgeJson(
        env,
        `/internal/guilds/${guildId}/settings`,
        {method:"PUT",body}
      );
      return json(env,saved);
    }
  }

  const securityLockdown=url.pathname.match(/^\/api\/guilds\/(\d+)\/security-lockdown$/);
  if(securityLockdown){
    const guildId=securityLockdown[1]!;
    await requireGuild(request,env,guildId);
    if(!securityBridgeConfigured(env)) throw new HttpError(503,"Security Botがまだ接続されていません");
    if(request.method==="POST"){
      const body=await request.text();
      return json(env,await securityBridgeJson(
        env,
        `/internal/guilds/${guildId}/lockdown`,
        {method:"POST",body:body||JSON.stringify({reason:"manual dashboard lockdown"})}
      ));
    }
    if(request.method==="DELETE"){
      return json(env,await securityBridgeJson(
        env,
        `/internal/guilds/${guildId}/lockdown`,
        {method:"DELETE"}
      ));
    }
  }


  if(url.pathname==="/api/logout"&&request.method==="POST"){
    const auth=request.headers.get("Authorization");
    if(auth?.startsWith("Bearer ")) await deleteDashboardSession(env,await sha256Hex(auth.slice(7).trim()));
    return json(env,{ok:true});
  }

  if(url.pathname==="/api/commands/register"&&request.method==="POST"){
    await sessionFromRequest(request,env);
    await registerCommands(env);
    return json(env,{ok:true});
  }

  if(url.pathname==="/api/guilds"&&request.method==="GET"){
    await sessionFromRequest(request,env);

    const [cached,knownIds]=await Promise.all([
      listBotGuildCache(env,24*60*60_000).catch(()=>[]),
      listKnownGuildIds(env).catch(()=>[])
    ]);

    // Prefer the IDs learned from Gateway READY/GUILD_CREATE and persisted
    // subsystems. A direct GET /guilds/:id is the strongest membership check and
    // avoids depending on the aggregate current-user guild-list endpoint.
    if(knownIds.length){
      const recovered=await recoverKnownBotGuilds(env,knownIds);
      if(recovered.guilds.length){
        await Promise.all([
          replaceBotGuildCache(env,recovered.guilds).catch(error=>
            console.error("bot guild cache update failed",error)
          ),
          replaceBotGuildMembership(
            env,
            recovered.guilds.map(guild=>guild.id)
          ).catch(error=>
            console.error("bot guild membership update failed",error)
          )
        ]);
        return json(env,recovered.guilds.map(guild=>({
          ...guild,
          botInstalled:true
        })));
      }

      if(recovered.transientFailure&&cached.length){
        console.warn(
          "bot guild list: direct probes transient; serving recent cache",
          cached.length
        );
        return json(env,cached.map(guild=>({
          id:guild.id,
          name:guild.name,
          icon:guild.icon,
          botInstalled:true
        })));
      }
    }

    // Bootstrap/fallback for installs that have not yet received a fresh READY.
    try{
      const live=await botJson<DashboardGuild[]>(
        env,"/users/@me/guilds?limit=200"
      );

      if(live.length>0){
        await Promise.all([
          replaceBotGuildCache(env,live).catch(error=>
            console.error("bot guild cache update failed",error)
          ),
          replaceBotGuildMembership(
            env,
            live.map(guild=>guild.id)
          ).catch(error=>
            console.error("bot guild membership update failed",error)
          )
        ]);
        return json(env,live.map(guild=>({
          ...guild,
          botInstalled:true
        })));
      }

      if(cached.length){
        console.warn(
          "bot guild list: aggregate endpoint empty; serving recent cache",
          cached.length
        );
        return json(env,cached.map(guild=>({
          id:guild.id,
          name:guild.name,
          icon:guild.icon,
          botInstalled:true
        })));
      }

      const recoveryGuilds=await securityRecoveryGuilds(env,knownIds);
      if(recoveryGuilds.length){
        return json(env,recoveryGuilds);
      }

      return json(env,[]);
    }catch(error){
      console.error("bot guild list failed",error);
      const recoverable=
        !(error instanceof DiscordApiError)||
        [429,500,502,503,504].includes(error.status);
      if(recoverable&&cached.length){
        console.warn("bot guild list: serving recent cache",cached.length);
        return json(env,cached.map(guild=>({
          id:guild.id,
          name:guild.name,
          icon:guild.icon,
          botInstalled:true
        })));
      }
      if(recoverable){
        const recoveryGuilds=await securityRecoveryGuilds(env,knownIds);
        if(recoveryGuilds.length) return json(env,recoveryGuilds);
      }
      const detail=error instanceof Error?error.message:"unknown";
      throw new HttpError(502,"BOT参加サーバー一覧の取得に失敗しました: "+detail.slice(0,160));
    }
  }

  const meta=url.pathname.match(/^\/api\/guilds\/(\d+)\/meta$/);
  if(meta&&request.method==="GET"){
    const guildId=meta[1]!;
    const fast=url.searchParams.get("fast")==="1";

    // Save/refresh flows only need the current Discord structure. Running the
    // full access-repair sweep here can issue one overwrite request per channel
    // and make an otherwise successful save appear to hang in the dashboard.
    if(fast){
      await sessionFromRequest(request,env);
      const [guild,metaData]=await Promise.all([
        botJson<{id:string;name:string;icon:string|null}>(env,`/guilds/${guildId}`),
        discordMeta(env,guildId)
      ]);
      return json(env,{
        ...guild,
        ...metaData
      });
    }

    const {guild}=await requireGuild(request,env,guildId);
    const botAccessRepair=await repairBotChannelAccess(env,guildId);
    let verificationPanelUpgrade:"updated"|"current"|"missing"="missing";
    try{
      verificationPanelUpgrade=await upgradeTrackedVerificationPanel(
        env,guildId,new URL(request.url).origin
      );
    }catch(error){
      console.warn("verification panel auto-upgrade failed",guildId,error);
    }
    return json(env,{
      ...guild,
      ...await discordMeta(env,guildId),
      botAccessRepair,
      verificationPanelUpgrade
    });
  }

  const memberActivityMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/member-activity$/);
  if(memberActivityMatch){
    const guildId=memberActivityMatch[1]!;
    if(request.method==="GET"){
      await sessionFromRequest(request,env);
      return json(env,await getMemberActivitySettings(env,guildId));
    }
    await requireGuild(request,env,guildId);
    if(request.method==="PUT"){
      const input=await bodyObject<{
        enabled?:boolean;
        channelId?:string|null;
        joinEnabled?:boolean;
        leaveEnabled?:boolean;
      }>(request);
      if(typeof input.enabled!=="boolean"||
        typeof input.joinEnabled!=="boolean"||
        typeof input.leaveEnabled!=="boolean"){
        throw new HttpError(400,"入退室設定が不正です");
      }
      const channelId=input.channelId?String(input.channelId):null;
      if(input.enabled&&!channelId){
        throw new HttpError(400,"通知先チャンネルを選択してください");
      }
      if(channelId) await requireMessageChannel(env,guildId,channelId);
      let saved=await saveMemberActivitySettings(env,guildId,{
        enabled:input.enabled,
        channelId,
        joinEnabled:input.joinEnabled,
        leaveEnabled:input.leaveEnabled
      });
      if(saved.enabled){
        try{
          saved=await primeMemberActivity(env,guildId);
        }catch(error){
          if(error instanceof DiscordApiError&&error.status===403){
            throw new HttpError(
              409,
              "メンバー一覧を取得できません。Discord Developer Portal の Bot 設定で Server Members Intent を有効にしてから、もう一度保存してください"
            );
          }
          throw error;
        }
      }
      try{
        await ensureDiscordGateway(env);
      }catch(error){
        console.error("discord gateway start failed",error);
        if(saved.enabled){
          throw new HttpError(
            502,
            "設定は保存されましたが、リアルタイム入退室検知の起動に失敗しました。少し待ってからもう一度保存してください"
          );
        }
      }
      return json(env,saved);
    }
  }

  const memberActivityTest=url.pathname.match(/^\/api\/guilds\/(\d+)\/member-activity\/test$/);
  if(memberActivityTest&&request.method==="POST"){
    const guildId=memberActivityTest[1]!;
    await requireGuild(request,env,guildId);
    const {channelId}=await bodyObject<{channelId?:string}>(request);
    if(!channelId) throw new HttpError(400,"通知先チャンネルを選択してください");
    await requireMessageChannel(env,guildId,channelId);
    await sendMemberActivityTest(env,guildId,channelId);
    return json(env,{ok:true});
  }

  const settingsMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/settings$/);
  if(settingsMatch){
    const guildId=settingsMatch[1]!;
    if(request.method==="GET"){
      await sessionFromRequest(request,env);
      return json(env,await getGuildSettings(env,guildId));
    }
    await requireGuild(request,env,guildId);
    if(request.method==="PUT"){
      const patch=await bodyObject<Partial<GuildSettings>>(request);
      const safe:Partial<GuildSettings>={};
      for(const key of ["securityEnabled","antiSpam","blockInvites","antiRaid","antiNuke"] as const){
        if(patch[key]===undefined) continue;
        if(typeof patch[key]!=="boolean") throw new HttpError(400,key+" はオン/オフで指定してください");
        safe[key]=patch[key];
      }
      const limits={spamMax:[2,50],spamWindowSeconds:[1,300],mentionLimit:[2,50],
        raidJoins:[2,1000],raidWindowSeconds:[1,300],nukeActions:[2,30],
        nukeWindowSeconds:[5,300],minAccountAgeDays:[0,36500]} as const;
      for(const key of Object.keys(limits) as Array<keyof typeof limits>){
        if(patch[key]===undefined) continue;
        const value=patch[key];
        const [min,max]=limits[key];
        if(typeof value!=="number"||!Number.isInteger(value)||value<min||value>max){
          throw new HttpError(400,key+" は "+min+"〜"+max+" の整数で指定してください");
        }
        safe[key]=value;
      }
      for(const key of ["verifiedRoleId","logChannelId"] as const){
        if(patch[key]===undefined) continue;
        const value=patch[key];
        if(value!==null&&(typeof value!=="string"||!/^\d+$/.test(value.trim()))){
          throw new HttpError(400,key+" が不正です");
        }
        safe[key]=value?.trim()??null;
      }
      for(const key of ["ticketSupportRoleIds","trustedUserIds","trustedRoleIds"] as const){
        const value=patch[key];
        if(value===undefined) continue;
        if(!Array.isArray(value)||value.some(id=>typeof id!=="string"||!/^\d+$/.test(id.trim()))){
          throw new HttpError(400,key+" は有効なIDの配列で指定してください");
        }
        if(value.length>100||(key==="ticketSupportRoleIds"&&value.length>20)){
          throw new HttpError(400,key+" の件数が上限を超えています");
        }
        safe[key]=[...new Set(value.map(id=>id.trim()))];
      }

      if(safe.verifiedRoleId){
        const roles=await botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`);
        const targetRole=roles.find(role=>role.id===safe.verifiedRoleId);
        if(!targetRole||targetRole.id===guildId){
          throw new HttpError(400,"認証後ロールには@everyone以外の有効なロールを選択してください");
        }
        if(targetRole.managed){
          throw new HttpError(400,"Discord管理ロールは認証後ロールに指定できません");
        }
        if((BigInt(targetRole.permissions||"0")&DANGEROUS_PERMISSION_MASK)!==0n){
          throw new HttpError(
            400,
            "認証後ロールに管理者・ロール管理・チャンネル管理・BAN/Kickなどの危険権限は設定できません"
          );
        }
        // Do not reject the setting based only on Discord's role position values.
        // Discord is authoritative when the role is actually assigned, and equal
        // numeric positions can still have a valid hierarchy order.
      }

      const saved=await saveGuildSettings(env,guildId,safe);
      const persisted=await getGuildSettings(env,guildId);
      if(
        safe.minAccountAgeDays!==undefined&&
        persisted.minAccountAgeDays!==safe.minAccountAgeDays
      ){
        throw new HttpError(500,"最低アカウント日数の保存確認に失敗しました");
      }
      if(
        safe.verifiedRoleId!==undefined&&
        persisted.verifiedRoleId!==safe.verifiedRoleId
      ){
        throw new HttpError(500,"認証ロールの保存確認に失敗しました");
      }
      const applyWarnings=await syncAutoMod(env,guildId,persisted);
      return json(env,{...persisted,applyWarnings});
    }
  }

  const channelsMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/channels$/);
  if(channelsMatch&&request.method==="POST"){
    const guildId=channelsMatch[1]!;
    await requireGuild(request,env,guildId);
    const input=await bodyObject<{name:string;type:"text"|"voice"|"category";parentId?:string|null;topic?:string}>(request);
    const name=input.name?.trim();
    if(!name||name.length>100) throw new HttpError(400,"チャンネル名が不正です");
    const botOverwrite=[{
      id:env.DISCORD_APPLICATION_ID.trim(),
      type:1,
      allow:BOT_CHANNEL_GUARD_MASK.toString()
    }];
    const created=await botJson<DiscordChannel>(env,`/guilds/${guildId}/channels`,{
      method:"POST",
      body:JSON.stringify(
        input.type==="category"
          ?{name,type:4,permission_overwrites:botOverwrite}
          :input.type==="voice"
            ?{
                name,
                type:2,
                parent_id:input.parentId||undefined,
                ...(input.parentId?{}:{permission_overwrites:botOverwrite})
              }
            :{
                name,
                type:0,
                parent_id:input.parentId||undefined,
                topic:input.topic||undefined,
                ...(input.parentId?{}:{permission_overwrites:botOverwrite})
              }
      )
    });
    return json(env,{id:created.id,name:created.name,type:input.type});
  }

  const channelReorderMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/channels\/reorder$/);
  if(channelReorderMatch&&request.method==="PATCH"){
    const guildId=channelReorderMatch[1]!;
    await requireGuild(request,env,guildId);
    const input=await bodyObject<{
      id:string;
      targetId?:string|null;
      placement?:"before"|"after"|"start";
      parentId?:string|null;
      position?:number;
    }>(request);

    if(!/^\d+$/.test(input.id??"")) throw new HttpError(400,"並び替え対象が不正です");

    const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
    const source=channels.find(channel=>channel.id===input.id);
    if(!source) throw new HttpError(404,"移動するチャンネルが見つかりません");

    // Keep the existing desktop category reorder behavior.
    if(source.type===4){
      if(!Number.isInteger(input.position)){
        throw new HttpError(400,"カテゴリの並び替え位置が不正です");
      }
      await botJson(env,`/guilds/${guildId}/channels`,{
        method:"PATCH",
        body:JSON.stringify([{id:source.id,position:input.position}])
      });
      return json(env,{ok:true,kind:"category"});
    }

    let destinationParent: string|null;
    let destinationIndex=0;
    let destinationSiblings:DiscordChannel[];

    if(input.targetId){
      const target=channels.find(channel=>channel.id===input.targetId);
      if(!target||target.type===4) throw new HttpError(400,"移動先チャンネルが不正です");
      if(target.id===source.id) return json(env,{ok:true,unchanged:true});

      destinationParent=target.parent_id??null;
      destinationSiblings=channels
        .filter(channel=>channel.type!==4&&channel.id!==source.id&&(channel.parent_id??null)===destinationParent)
        .sort((a,b)=>(a.position??0)-(b.position??0));

      const targetIndex=destinationSiblings.findIndex(channel=>channel.id===target.id);
      if(targetIndex<0) throw new HttpError(400,"移動先を判定できませんでした");
      destinationIndex=targetIndex+(input.placement==="after"?1:0);
    }else{
      destinationParent=input.parentId??null;
      if(destinationParent!==null){
        const category=channels.find(channel=>channel.id===destinationParent&&channel.type===4);
        if(!category) throw new HttpError(400,"移動先カテゴリが見つかりません");
      }
      destinationSiblings=channels
        .filter(channel=>channel.type!==4&&channel.id!==source.id&&(channel.parent_id??null)===destinationParent)
        .sort((a,b)=>(a.position??0)-(b.position??0));
      destinationIndex=input.placement==="start"?0:destinationSiblings.length;
    }

    destinationIndex=Math.max(0,Math.min(destinationIndex,destinationSiblings.length));
    const reordered=[...destinationSiblings];
    reordered.splice(destinationIndex,0,source);

    // Send the full destination sibling order instead of only one position.
    // Discord then has an unambiguous order even when moving across categories.
    const payload=reordered.map((channel,index)=>({
      id:channel.id,
      position:index,
      ...(channel.id===source.id
        ?{parent_id:destinationParent,lock_permissions:false}
        :{})
    }));

    await botJson(env,`/guilds/${guildId}/channels`,{
      method:"PATCH",
      body:JSON.stringify(payload)
    });

    // Read back from Discord and verify the move really stuck before reporting success.
    const confirmed=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
    const confirmedSource=confirmed.find(channel=>channel.id===source.id);
    if(!confirmedSource||(confirmedSource.parent_id??null)!==destinationParent){
      throw new HttpError(502,"Discord側でカテゴリ移動を反映できませんでした");
    }

    const confirmedSiblings=confirmed
      .filter(channel=>channel.type!==4&&(channel.parent_id??null)===destinationParent)
      .sort((a,b)=>(a.position??0)-(b.position??0));
    const actualIndex=confirmedSiblings.findIndex(channel=>channel.id===source.id);
    const expectedPrevious=reordered[destinationIndex-1]?.id??null;
    const expectedNext=reordered[destinationIndex+1]?.id??null;
    const actualPrevious=actualIndex>0?confirmedSiblings[actualIndex-1]?.id??null:null;
    const actualNext=actualIndex>=0?confirmedSiblings[actualIndex+1]?.id??null:null;

    const orderMatches=
      actualIndex>=0&&
      (expectedPrevious===null||actualPrevious===expectedPrevious)&&
      (expectedNext===null||actualNext===expectedNext);

    if(!orderMatches){
      // One retry with a fresh canonical position list handles Discord's occasional
      // position normalization after a parent change.
      const retrySiblings=confirmedSiblings.filter(channel=>channel.id!==source.id);
      const retryIndex=Math.max(0,Math.min(destinationIndex,retrySiblings.length));
      retrySiblings.splice(retryIndex,0,confirmedSource);
      await botJson(env,`/guilds/${guildId}/channels`,{
        method:"PATCH",
        body:JSON.stringify(retrySiblings.map((channel,index)=>({
          id:channel.id,
          position:index,
          ...(channel.id===source.id
            ?{parent_id:destinationParent,lock_permissions:false}
            :{})
        })))
      });
    }

    return json(env,{
      ok:true,
      id:source.id,
      parentId:destinationParent,
      targetId:input.targetId??null,
      placement:input.targetId?(input.placement==="after"?"after":"before"):"start"
    });
  }

  const rolesCollectionMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/roles$/);
  if(rolesCollectionMatch&&request.method==="POST"){
    const guildId=rolesCollectionMatch[1]!;
    await requireGuild(request,env,guildId);
    const input=await bodyObject<{
      name?:string;
      color?:number;
      permissions?:string;
    }>(request);

    const name=String(input.name??"").trim();
    if(!name||name.length>100) throw new HttpError(400,"ロール名が不正です");

    const color=input.color===undefined?0:Number(input.color);
    if(!Number.isInteger(color)||color<0||color>0xFFFFFF){
      throw new HttpError(400,"ロール色が不正です");
    }

    let permissions="0";
    try{
      const parsed=BigInt(input.permissions??"0");
      if(parsed<0n) throw new Error();
      permissions=parsed.toString();
    }catch{
      throw new HttpError(400,"ロール権限が不正です");
    }

    try{
      const role=await botJson<DiscordRole>(env,`/guilds/${guildId}/roles`,{
        method:"POST",
        body:JSON.stringify({name,color,permissions})
      });
      return json(env,{
        id:role.id,
        name:role.name,
        position:role.position,
        color:role.color??0,
        permissions:role.permissions,
        isEveryone:false
      },201);
    }catch(error){
      if(error instanceof DiscordApiError&&error.status===403){
        throw new HttpError(
          403,
          "ロールを追加できません。BOTに「ロールの管理」権限があるか確認してください"
        );
      }
      throw error;
    }
  }

  const roleItemMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/roles\/(\d+)$/);
  if(roleItemMatch){
    const guildId=roleItemMatch[1]!;
    const roleId=roleItemMatch[2]!;
    await requireGuild(request,env,guildId);

    if(request.method==="PATCH"){
      const input=await bodyObject<{
        name?:string;
        color?:number;
        permissions?:string;
      }>(request);

      const payload:Record<string,unknown>={};
      if(input.permissions!==undefined){
        try{
          const parsed=BigInt(input.permissions);
          if(parsed<0n) throw new Error();
          payload.permissions=parsed.toString();
        }catch{
          throw new HttpError(400,"ロール権限が不正です");
        }
      }

      if(roleId===guildId){
        if(input.name!==undefined||input.color!==undefined){
          throw new HttpError(400,"@everyone は名前や色を変更できません");
        }
      }else{
        if(input.name!==undefined){
          const name=String(input.name).trim();
          if(!name||name.length>100) throw new HttpError(400,"ロール名が不正です");
          payload.name=name;
        }
        if(input.color!==undefined){
          const color=Number(input.color);
          if(!Number.isInteger(color)||color<0||color>0xFFFFFF){
            throw new HttpError(400,"ロール色が不正です");
          }
          payload.color=color;
        }
      }

      try{
        const role=await botJson<DiscordRole>(env,`/guilds/${guildId}/roles/${roleId}`,{
          method:"PATCH",
          body:JSON.stringify(payload)
        });
        return json(env,{
          id:role.id,
          name:role.name,
          position:role.position,
          color:role.color??0,
          permissions:role.permissions,
          isEveryone:role.id===guildId
        });
      }catch(error){
        if(error instanceof DiscordApiError&&error.status===403){
          throw new HttpError(
            403,
            "このロールを編集できません。BOTの「ロールの管理」権限、またはBOTより上にあるロールの並び順を確認してください"
          );
        }
        throw error;
      }
    }

    if(request.method==="DELETE"){
      if(roleId===guildId) throw new HttpError(400,"@everyone は削除できません");
      try{
        await botJson<void>(env,`/guilds/${guildId}/roles/${roleId}`,{
          method:"DELETE"
        });
        return json(env,{ok:true});
      }catch(error){
        if(error instanceof DiscordApiError&&error.status===403){
          throw new HttpError(
            403,
            "このロールを削除できません。BOTの「ロールの管理」権限、またはBOTより上にあるロールの並び順を確認してください"
          );
        }
        throw error;
      }
    }
  }

  const bulkChannelPermissionMatch=url.pathname.match(
    /^\/api\/guilds\/(\d+)\/channels\/permissions\/bulk$/
  );
  if(bulkChannelPermissionMatch&&request.method==="PATCH"){
    const guildId=bulkChannelPermissionMatch[1]!;
    await requireGuild(request,env,guildId);
    const input=await bodyObject<{
      channelIds?:string[];
      targetId?:string;
      permissions?:ChannelPermissionPatch;
    }>(request);

    const channelIds=[...new Set(
      (input.channelIds??[])
        .map(id=>String(id).trim())
        .filter(id=>/^\d+$/.test(id))
    )];
    const targetId=String(input.targetId??"").trim();
    const permissions=input.permissions??{};
    if(channelIds.length===0) throw new HttpError(400,"対象チャンネルを選択してください");
    if(channelIds.length>100) throw new HttpError(400,"一度に変更できるのは100チャンネルまでです");
    if(!/^\d+$/.test(targetId)) throw new HttpError(400,"対象ロールが不正です");
    if(Object.keys(permissions).length===0){
      throw new HttpError(400,"変更する権限を選択してください");
    }

    const [channels,roles]=await Promise.all([
      botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`),
      botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`)
    ]);
    if(targetId!==guildId&&!roles.some(role=>role.id===targetId)){
      throw new HttpError(404,"対象ロールが見つかりません");
    }
    const member=await getBotGuildMember(env,guildId,roles);
    const channelById=new Map(channels.map(channel=>[channel.id,channel]));
    const updated:string[]=[];
    const failed:Array<{id:string;name:string;message:string}>=[];

    for(const channelId of channelIds){
      const channel=channelById.get(channelId);
      if(!channel||channel.type===4){
        failed.push({
          id:channelId,
          name:channel?.name??channelId,
          message:"チャンネルが見つかりません"
        });
        continue;
      }
      try{
        await applyChannelRolePermissions(
          env,
          guildId,
          channel,
          targetId,
          roles,
          member,
          permissions
        );
        updated.push(channelId);
      }catch(error){
        failed.push({
          id:channel.id,
          name:channel.name,
          message:error instanceof Error?error.message:String(error)
        });
      }
    }

    const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
    const verify=async(ids:string[])=>{
      let remaining=[...ids];
      let confirmedById=new Map<string,DiscordChannel>();
      for(const delay of [0,180,420]){
        if(delay>0) await sleep(delay);
        const confirmed=await botJson<DiscordChannel[]>(
          env,
          `/guilds/${guildId}/channels`
        );
        confirmedById=new Map(confirmed.map(channel=>[channel.id,channel]));
        remaining=remaining.filter(channelId=>{
          const channel=confirmedById.get(channelId);
          return !channel||!channelPermissionPatchMatches(channel,targetId,permissions);
        });
        if(remaining.length===0) break;
      }
      return {remaining,confirmedById};
    };

    let verification=await verify(updated);
    if(verification.remaining.length>0){
      // Retry only the channels whose overwrite was not visible after the first
      // write. This handles transient Discord propagation without duplicating
      // successful writes across the whole selection.
      for(const channelId of verification.remaining){
        const channel=channelById.get(channelId);
        if(!channel) continue;
        try{
          await applyChannelRolePermissions(
            env,
            guildId,
            channel,
            targetId,
            roles,
            member,
            permissions
          );
        }catch(error){
          failed.push({
            id:channel.id,
            name:channel.name,
            message:"再試行に失敗: "+(error instanceof Error?error.message:String(error))
          });
        }
      }
      verification=await verify(
        verification.remaining.filter(
          id=>!failed.some(failure=>failure.id===id)
        )
      );
    }

    for(const channelId of verification.remaining){
      const original=channelById.get(channelId);
      failed.push({
        id:channelId,
        name:original?.name??channelId,
        message:"Discordから再取得した権限が指定内容と一致しませんでした"
      });
    }

    const failedIds=new Set(failed.map(item=>item.id));
    const updatedIds=updated.filter(id=>!failedIds.has(id));
    const operationId=randomId();

    console.log("bulk channel permissions",{
      operationId,
      guildId,
      targetId,
      requested:channelIds.length,
      updated:updatedIds.length,
      failed:failed.length
    });

    return json(env,{
      ok:failed.length===0,
      operationId,
      targetId,
      requested:channelIds.length,
      updated:updatedIds.length,
      updatedIds,
      failed
    });
  }

  const channelPermissionMatch=url.pathname.match(
    /^\/api\/guilds\/(\d+)\/channels\/(\d+)\/permissions\/(\d+)$/
  );
  if(channelPermissionMatch&&request.method==="PATCH"){
    const guildId=channelPermissionMatch[1]!;
    const channelId=channelPermissionMatch[2]!;
    const targetId=channelPermissionMatch[3]!;

    await sessionFromRequest(request,env);

    const input=await bodyObject<{
      targetType?:"role";
      permissions?:ChannelPermissionPatch;
    }>(request);
    const permissions=input.permissions??{};
    if(Object.keys(permissions).length===0){
      throw new HttpError(400,"変更する権限を選択してください");
    }

    // Get Guild Channels is deliberately used instead of GET /channels/:id.
    // It still lets the dashboard repair a channel the bot cannot directly view.
    const channelsResponse=await botFetchInteractive(
      env,
      `/guilds/${guildId}/channels`
    );
    if(!channelsResponse.ok){
      const detail=await channelsResponse.text().catch(()=>"");
      if(channelsResponse.status===403){
        throw new HttpError(
          403,
          "BOTがサーバーのチャンネル一覧を取得できません。BOTがサーバーに参加しているか確認してください"
        );
      }
      throw new DiscordApiError(
        channelsResponse.status,
        "Discord API "+channelsResponse.status+": "+detail.slice(0,300)
      );
    }

    const channels=await channelsResponse.json() as DiscordChannel[];
    const channel=channels.find(item=>item.id===channelId);
    if(!channel){
      throw new HttpError(
        404,
        "対象チャンネルが見つかりません。サーバー構成を再読み込みしてください"
      );
    }

    const currentTarget=(channel.permission_overwrites??[]).find(
      item=>item.id===targetId&&item.type===0
    );
    let targetAllow=BigInt(currentTarget?.allow??"0");
    let targetDeny=BigInt(currentTarget?.deny??"0");
    const beforeAllow=targetAllow;
    const beforeDeny=targetDeny;

    for(const [rawKey,mode] of Object.entries(permissions)){
      if(!(rawKey in CHANNEL_PERMISSION_BITS)) continue;
      if(mode!=="inherit"&&mode!=="allow"&&mode!=="deny") continue;
      const bit=CHANNEL_PERMISSION_BITS[rawKey as ChannelPermissionKey];
      targetAllow&=~bit;
      targetDeny&=~bit;
      if(mode==="allow") targetAllow|=bit;
      if(mode==="deny") targetDeny|=bit;
    }

    const botId=env.DISCORD_APPLICATION_ID.trim();
    const shouldProtectBot=permissions.view==="deny";
    const currentBot=(channel.permission_overwrites??[]).find(
      item=>item.id===botId&&item.type===1
    );
    let botAllow=BigInt(currentBot?.allow??"0");
    let botDeny=BigInt(currentBot?.deny??"0");
    if(shouldProtectBot){
      botAllow|=BOT_CHANNEL_GUARD_MASK;
      botDeny&=~BOT_CHANNEL_GUARD_MASK;
    }

    // Replace the complete overwrite array atomically. This avoids the old
    // multi-request sequence (guard PUT -> role PUT -> readback -> retry).
    // Every unrelated overwrite is copied byte-for-byte.
    const replacement=(channel.permission_overwrites??[])
      .filter(item=>
        !(item.id===targetId&&item.type===0)&&
        !(shouldProtectBot&&item.id===botId&&item.type===1)
      )
      .map(item=>({
        id:item.id,
        type:item.type,
        allow:item.allow,
        deny:item.deny
      }));

    if(targetAllow!==0n||targetDeny!==0n){
      replacement.push({
        id:targetId,
        type:0,
        allow:targetAllow.toString(),
        deny:targetDeny.toString()
      });
    }
    if(shouldProtectBot){
      replacement.push({
        id:botId,
        type:1,
        allow:botAllow.toString(),
        deny:botDeny.toString()
      });
    }

    const writeResponse=await botFetchInteractive(
      env,
      `/channels/${channelId}`,
      {
        method:"PATCH",
        body:JSON.stringify({permission_overwrites:replacement})
      }
    );
    if(!writeResponse.ok){
      const detail=await writeResponse.text().catch(()=>"");
      if(writeResponse.status===403){
        throw new HttpError(
          403,
          "Discordがチャンネル権限の変更を拒否しました。BOTロールの「チャンネルの管理」と対象チャンネルへのアクセスを確認してください"
        );
      }
      throw new DiscordApiError(
        writeResponse.status,
        "Discord API "+writeResponse.status+": "+detail.slice(0,300)
      );
    }

    // Modify Channel returns the updated channel. Verify that exact response
    // instead of making another Discord request.
    const updated=await writeResponse.json() as DiscordChannel;
    const persisted=(updated.permission_overwrites??[]).find(
      item=>item.id===targetId&&item.type===0
    );
    const actualAllow=persisted?.allow??"0";
    const actualDeny=persisted?.deny??"0";
    if(
      actualAllow!==targetAllow.toString()||
      actualDeny!==targetDeny.toString()
    ){
      console.error("channel permission atomic verification mismatch",{
        guildId,
        channelId,
        targetId,
        expectedAllow:targetAllow.toString(),
        expectedDeny:targetDeny.toString(),
        actualAllow,
        actualDeny
      });
      throw new HttpError(
        502,
        "Discordの更新レスポンスが指定した権限と一致しませんでした。成功扱いにはしていません"
      );
    }

    if(shouldProtectBot){
      const persistedBot=(updated.permission_overwrites??[]).find(
        item=>item.id===botId&&item.type===1
      );
      const persistedBotAllow=BigInt(persistedBot?.allow??"0");
      const persistedBotDeny=BigInt(persistedBot?.deny??"0");
      if(
        (persistedBotAllow&BOT_CHANNEL_GUARD_MASK)!==BOT_CHANNEL_GUARD_MASK||
        (persistedBotDeny&BOT_CHANNEL_GUARD_MASK)!==0n
      ){
        throw new HttpError(
          502,
          "権限自体は更新されましたがBOT保護権限を確認できないため、成功扱いにはしていません"
        );
      }
    }

    const operationId=randomId();
    console.log("channel permissions atomic verified",{
      operationId,
      guildId,
      channelId,
      targetId,
      changed:targetAllow!==beforeAllow||targetDeny!==beforeDeny,
      allow:targetAllow.toString(),
      deny:targetDeny.toString()
    });

    return json(env,{
      ok:true,
      verified:true,
      verification:"modify-channel-response",
      operationId,
      channelId,
      targetId,
      allow:targetAllow.toString(),
      deny:targetDeny.toString(),
      changed:targetAllow!==beforeAllow||targetDeny!==beforeDeny
    });
  }

  const channelItemMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/channels\/(\d+)$/);
  if(channelItemMatch){
    const guildId=channelItemMatch[1]!;
    const channelId=channelItemMatch[2]!;
    await requireGuild(request,env,guildId);

    if(request.method==="PATCH"){
      const input=await bodyObject<{
        name?:string;
        topic?:string|null;
        parentId?:string|null;
      }>(request);
      const payload:Record<string,unknown>={};
      if(input.name!==undefined){
        const name=input.name.trim();
        if(!name||name.length>100) throw new HttpError(400,"チャンネル名が不正です");
        payload.name=name;
      }
      if(input.topic!==undefined) payload.topic=input.topic===null?null:String(input.topic).slice(0,1024);
      if(input.parentId!==undefined) payload.parent_id=input.parentId||null;
      const updated=await botJson<DiscordChannel>(env,`/channels/${channelId}`,{
        method:"PATCH",
        body:JSON.stringify(payload)
      });
      return json(env,{
        id:updated.id,
        name:updated.name,
        parentId:updated.parent_id??null,
        topic:updated.topic??"",
        position:updated.position??0
      });
    }

    if(request.method==="DELETE"){
      const response=await botFetch(env,`/channels/${channelId}`,{method:"DELETE"});
      if(!response.ok) throw new HttpError(response.status,"チャンネルを削除できませんでした");
      return json(env,{ok:true});
    }
  }

  const templateMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/templates\/(community|shop|support)$/);
  if(templateMatch&&request.method==="POST"){
    await requireGuild(request,env,templateMatch[1]!);
    await applyTemplate(env,templateMatch[1]!,templateMatch[2]!);
    return json(env,{ok:true});
  }

  const verifyPanel=url.pathname.match(/^\/api\/guilds\/(\d+)\/verification\/panel$/);
  if(verifyPanel&&request.method==="POST"){
    const guildId=verifyPanel[1]!;
    await requireGuild(request,env,guildId);
    await ensureSchema(env);
    const verificationSettings=await getGuildSettings(env,guildId);
    if(!verificationSettings.verifiedRoleId){
      throw new HttpError(409,"先に「認証後ロール」を設定して保存してください");
    }
    const {channelId}=await bodyObject<{channelId?:string}>(request);
    if(!channelId) throw new HttpError(400,"設置先チャンネルを選択してください");
    await requireMessageChannel(env,guildId,channelId);
    try{
      await publishVerificationPanel(env,guildId,channelId,new URL(request.url).origin);
    }catch(error){
      if(error instanceof DiscordApiError&&error.status===404){
        throw new HttpError(404,"設置先チャンネルが見つかりません。チャンネル一覧を再読み込みしてください");
      }
      if(error instanceof DiscordApiError&&error.status===429){
        throw new HttpError(429,"Discord APIのレート制限中です。少し待ってからもう一度設置してください");
      }
      throw error;
    }
    return json(env,{ok:true,channelId});
  }

  const ticketPanel=url.pathname.match(/^\/api\/guilds\/(\d+)\/tickets\/panel$/);
  if(ticketPanel&&request.method==="POST"){
    const guildId=ticketPanel[1]!;
    await requireGuild(request,env,guildId);
    const {channelId}=await bodyObject<{channelId?:string}>(request);
    if(!channelId) throw new HttpError(400,"設置先チャンネルを選択してください");
    await requireMessageChannel(env,guildId,channelId);
    try{
      await publishTicketPanel(env,guildId,channelId);
    }catch(error){
      if(error instanceof DiscordApiError&&error.status===404){
        throw new HttpError(
          404,
          "設置先チャンネルが見つかりません。チャンネル一覧を再読み込みしてください"
        );
      }
      if(error instanceof DiscordApiError&&error.status===429){
        throw new HttpError(
          429,
          "Discord APIのレート制限中です。少し待ってからもう一度設置してください"
        );
      }
      throw error;
    }
    return json(env,{ok:true,channelId});
  }

  const productsMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/products$/);
  if(productsMatch){
    const guildId=productsMatch[1]!;
    if(request.method==="GET"){
      await sessionFromRequest(request,env);
      return json(env,await listProducts(env,guildId));
    }
    await requireGuild(request,env,guildId);
    if(request.method==="POST"){
      const input=await bodyObject<{
        name:string;description?:string;priceYen:number;
        deliveryType:"role"|"text";roleId?:string|null;deliveryText?:string|null;
      }>(request);
      if(!input.name?.trim()||input.name.length>80) throw new HttpError(400,"商品名が不正です");
      if(!Number.isInteger(input.priceYen)||input.priceYen<1||input.priceYen>1000000){
        throw new HttpError(400,"価格が不正です");
      }
      if(input.deliveryType==="role"&&!input.roleId) throw new HttpError(400,"付与ロールが必要です");
      if(input.deliveryType==="text"&&!input.deliveryText) throw new HttpError(400,"納品内容が必要です");
      const row:ProductRow={
        id:randomId(),guild_id:guildId,name:input.name.trim(),
        description:(input.description||"").slice(0,500),
        price_yen:input.priceYen,active:1,delivery_type:input.deliveryType,
        role_id:input.roleId||null,delivery_text:input.deliveryText||null,created_at:Date.now()
      };
      return json(env,await createProduct(env,row),201);
    }
  }

  const productDelete=url.pathname.match(/^\/api\/guilds\/(\d+)\/products\/([^/]+)$/);
  if(productDelete&&request.method==="DELETE"){
    await requireGuild(request,env,productDelete[1]!);
    if(!(await deleteProduct(env,productDelete[1]!,productDelete[2]!))) throw new HttpError(404,"商品が見つかりません");
    return json(env,{ok:true});
  }

  const productPanel=url.pathname.match(/^\/api\/guilds\/(\d+)\/products\/([^/]+)\/panel$/);
  if(productPanel&&request.method==="POST"){
    await requireGuild(request,env,productPanel[1]!);
    const product=await getProduct(env,productPanel[2]!);
    if(!product||product.guild_id!==productPanel[1]!||!product.active) throw new HttpError(404,"商品が見つかりません");
    const {channelId}=await bodyObject<{channelId:string}>(request);
    await publishProductPanel(env,productPanel[1]!,channelId,product);
    return json(env,{ok:true});
  }

  throw new HttpError(404,"Not found");
}

async function oauthStart(request:Request,env:Env):Promise<Response>{
  const state=randomToken(24);
  await putOAuthState(env,state);
  const origin=new URL(request.url).origin;
  return new Response(null,{
    status:302,
    headers:{
      Location:oauthAuthorizeUrl(env,origin,state),
      "Set-Cookie":`dsm_oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}

async function oauthCallback(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  const code=url.searchParams.get("code");
  const state=url.searchParams.get("state");
  const cookie=parseCookie(request.headers.get("Cookie"),"dsm_oauth_state");
  if(!code||!state||!cookie||cookie!==state||!(await consumeOAuthState(env,state))){
    throw new HttpError(400,"OAuth state mismatch");
  }
  const tokens=await exchangeCode(env,url.origin,code);
  const user=await userJson<DiscordUser>("/users/@me",tokens.access_token);
  const rawSession=randomToken(32);
  await createSession(env,{
    token_hash:await sha256Hex(rawSession),
    user_id:user.id,
    username:user.global_name||user.username,
    avatar:user.avatar||null,
    access_token_enc:await encrypt(env.SESSION_ENCRYPTION_KEY,tokens.access_token),
    refresh_token_enc:await encrypt(env.SESSION_ENCRYPTION_KEY,tokens.refresh_token),
    token_expires_at:Date.now()+tokens.expires_in*1000,
    expires_at:Date.now()+30*24*60*60_000
  });
  return new Response(null,{
    status:302,
    headers:{
      Location:`${env.WEB_PUBLIC_URL.replace(/\/$/,"")}/#session=${encodeURIComponent(rawSession)}`,
      "Set-Cookie":"dsm_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}

async function handlePayPayWebhook(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  let payload:any={};
  try{payload=await request.json();}catch{}
  const merchantId=payload?.merchantPaymentId||payload?.data?.merchantPaymentId;
  if(merchantId){
    ctx.waitUntil((async()=>{
      const payment=await getPaymentByMerchantId(env,String(merchantId));
      if(payment) await confirmAndDeliver(env,payment);
    })().catch(console.error));
  }
  return new Response("OK",{status:200});
}

async function neutralize(env:Env,guildId:string,userId:string,settings:GuildSettings):Promise<void>{
  if(settings.trustedUserIds.includes(userId)) return;
  const guild=await botJson<{owner_id:string}>(env,`/guilds/${guildId}`);
  if(guild.owner_id===userId) return;
  const [member,roles]=await Promise.all([
    botJson<{roles:string[]}>(env,`/guilds/${guildId}/members/${userId}`),
    botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`)
  ]);
  if(member.roles.some(id=>settings.trustedRoleIds.includes(id))) return;
  for(const role of roles){
    if(!member.roles.includes(role.id)||role.managed) continue;
    if((BigInt(role.permissions)&DANGEROUS_PERMISSION_MASK)!==0n){
      await botFetch(env,`/guilds/${guildId}/members/${userId}/roles/${role.id}`,{method:"DELETE"})
        .catch(()=>undefined);
    }
  }
  if(settings.logChannelId){
    await sendMessage(env,settings.logChannelId,{
      content:`⚠️ Anti-Nuke: <@${userId}> から危険権限ロールの解除を試みました。`
    }).catch(()=>undefined);
  }
}

async function auditWatch(env:Env):Promise<void>{
  // Once the independent Security Bot bridge is configured, real-time Gateway
  // protection becomes authoritative. Keep this cron guard only as a legacy
  // fallback for installations that have not completed Security Bot setup.
  if(securityBridgeConfigured(env)) return;
  const guilds=await listAllGuildSettings(env,10);
  for(const row of guilds){
    let settings:GuildSettings;
    try{settings={...DEFAULT_SETTINGS,...JSON.parse(row.config)};}catch{continue;}
    if(!settings.securityEnabled||!settings.antiNuke) continue;
    const payload=await botJson<{audit_log_entries:Array<{
      id:string;action_type:number;user_id?:string|null;
    }> }>(env,`/guilds/${row.guild_id}/audit-logs?limit=30`).catch(()=>null);
    if(!payload?.audit_log_entries?.length) continue;
    const newest=payload.audit_log_entries[0]!.id;
    const cursor=await getAuditCursor(env,row.guild_id);
    if(!cursor){
      await setAuditCursor(env,row.guild_id,newest);
      continue;
    }
    const fresh=[];
    for(const entry of payload.audit_log_entries){
      if(entry.id===cursor) break;
      if(entry.user_id&&[12,22,32].includes(entry.action_type)) fresh.push(entry);
    }
    await setAuditCursor(env,row.guild_id,newest);
    const byUser=new Map<string,number[]>();
    for(const entry of fresh){
      const times=byUser.get(entry.user_id!)??[];
      times.push(snowflakeTime(entry.id));
      byUser.set(entry.user_id!,times);
    }
    const windowMs=settings.nukeWindowSeconds*1000;
    for(const [userId,times] of byUser){
      times.sort((a,b)=>a-b);
      let left=0,hit=false;
      for(let right=0;right<times.length;right++){
        while(times[right]!-times[left]!>windowMs) left++;
        if(right-left+1>=settings.nukeActions){hit=true;break;}
      }
      if(hit) await neutralize(env,row.guild_id,userId,settings).catch(console.error);
    }
  }
}

async function paymentSweep(env:Env):Promise<void>{
  if(!payPayConfigured(env)) return;
  for(const payment of await listPendingPayments(env,8)){
    await confirmAndDeliver(env,payment).catch(console.error);
  }
}

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    try{
      const url=new URL(request.url);

      if(request.method==="OPTIONS"){
        return new Response(null,{status:204,headers:corsHeaders(env)});
      }
      if(url.pathname==="/_diag/guild-root-v2"&&request.method==="GET"){
        await ensureSchema(env);
        const knownIds=await listKnownGuildIds(env).catch(()=>[]);
        const result:any={
          version:"guild-root-v2",
          mainBotId:env.DISCORD_APPLICATION_ID.trim(),
          knownIdCount:knownIds.length,
          guilds:[],
          aggregate:null,
          security:null
        };

        try{
          const response=await botJson<DashboardGuild[]>(
            env,"/users/@me/guilds?limit=200"
          );
          result.aggregate={ok:true,count:response.length};
        }catch(error){
          result.aggregate={
            ok:false,
            status:error instanceof DiscordApiError?error.status:null,
            message:error instanceof Error?error.message:String(error)
          };
        }

        for(const id of knownIds.slice(0,5)){
          const probe:any={};
          for(const [label,path] of [
            ["guild",`/guilds/${id}`],
            ["channels",`/guilds/${id}/channels`],
            ["roles",`/guilds/${id}/roles`],
            ["selfMember",`/guilds/${id}/members/${env.DISCORD_APPLICATION_ID.trim()}`]
          ] as const){
            try{
              const value=await botJson<any>(env,path);
              probe[label]={
                ok:true,
                count:Array.isArray(value)?value.length:undefined
              };
            }catch(error){
              probe[label]={
                ok:false,
                status:error instanceof DiscordApiError?error.status:null,
                message:error instanceof Error?error.message:String(error)
              };
            }
          }
          try{
            const value=await discordMeta(env,id);
            probe.discordMeta={
              ok:true,
              channels:value.channels.length,
              categories:value.categories.length,
              roles:value.roles.length,
              botAdministrator:value.botAdministrator
            };
          }catch(error){
            probe.discordMeta={
              ok:false,
              status:error instanceof HttpError?error.status:
                error instanceof DiscordApiError?error.status:null,
              message:error instanceof Error?error.message:String(error)
            };
          }
          result.guilds.push(probe);
        }

        if(securityBridgeConfigured(env)&&knownIds[0]){
          try{
            const overview=await securityBridgeJson<any>(
              env,
              `/internal/guilds/${knownIds[0]}/overview?limit=50`
            );
            const incidents=Array.isArray(overview?.incidents)?overview.incidents:[];
            result.security={
              installed:Boolean(overview?.installed),
              lockdownActive:Boolean(overview?.lockdown?.active),
              incidents:incidents.slice(0,20).map((incident:any)=>({
                kind:String(incident?.kind??""),
                actionType:typeof incident?.data?.actionType==="number"
                  ?incident.data.actionType:null,
                actorIsMainBot:String(incident?.actorId??"")===
                  env.DISCORD_APPLICATION_ID.trim(),
                targetIsMainBot:String(incident?.data?.targetId??"")===
                  env.DISCORD_APPLICATION_ID.trim(),
                createdAt:typeof incident?.createdAt==="number"
                  ?incident.createdAt:null
              }))
            };
          }catch(error){
            result.security={error:error instanceof Error?error.message:String(error)};
          }
        }

        return json(env,result);
      }

      if(url.pathname==="/"||url.pathname==="/health"){
        let d1Reachable=false;
        let d1Error:string|null=null;
        if(env.DB){
          try{
            await env.DB.prepare("SELECT 1 AS ok").first();
            d1Reachable=true;
          }catch(error){
            d1Error=error instanceof Error?error.message:String(error);
          }
        }
        let d1SchemaReady=false;
        if(d1Reachable){
          try{
            await ensureSchema(env);
            d1SchemaReady=true;
          }catch(error){
            console.error("D1 schema initialization failed",error);
          }
        }
        const dashboardSessionStorage=env.DB
          ?await dashboardSessionStorageReady(env)
          :false;

        let discordApiReachable=false;
        let discordBotId:string|null=null;
        let discordBotUsername:string|null=null;
        let discordGuildCount:number|null=null;
        let discordApplicationMatchesToken:boolean|null=null;
        let discordApiError:string|null=null;
        try{
          const bot=await botJson<{id:string;username:string}>(env,"/users/@me");
          discordApiReachable=true;
          discordBotId=bot.id;
          discordBotUsername=bot.username;
          discordApplicationMatchesToken=bot.id===env.DISCORD_APPLICATION_ID.trim();
          // Do not call /users/@me/guilds from health; dashboard bootstrap owns that request.
          // This prevents health checks from consuming the same Discord REST rate-limit bucket.
          discordGuildCount=null;
        }catch(error){
          discordApiError=error instanceof Error?error.message:String(error);
        }

        return json(env,{
          ok:d1Reachable&&d1SchemaReady&&dashboardSessionStorage&&discordApiReachable,
          version:"guild-diagnostic-v64",
          runtime:"cloudflare-workers",
          discord:{
            applicationId:Boolean(env.DISCORD_APPLICATION_ID),
            publicKey:Boolean(env.DISCORD_PUBLIC_KEY),
            botToken:Boolean(env.DISCORD_BOT_TOKEN),
            clientSecret:Boolean(env.DISCORD_CLIENT_SECRET),
            apiReachable:discordApiReachable,
            botId:discordBotId,
            botUsername:discordBotUsername,
            guildCount:discordGuildCount,
            applicationMatchesToken:discordApplicationMatchesToken,
            apiError:discordApiError
          },
          encryptionKey:Boolean(env.SESSION_ENCRYPTION_KEY),
          dashboardPassword:Boolean(env.DASHBOARD_PASSWORD),
          dashboardSessionStorage,
          d1:{
            bound:Boolean(env.DB),
            reachable:d1Reachable,
            schemaReady:d1SchemaReady,
            error:d1Error
          }
        });
      }
      const recoveryOAuth=await handleRecoveryOAuth(request,env,url);
      if(recoveryOAuth) return recoveryOAuth;

      if(url.pathname==="/interactions"&&request.method==="POST"){
        return await handleInteraction(request,env,ctx);
      }
      if(url.pathname==="/api/login"&&request.method==="POST"){
        return await handleDashboardLogin(request,env);
      }

      // Read-only dashboard bootstrap routes must not depend on the full historical schema.
      // Their only DB dependency is dashboard_sessions, which self-heals in sessionFromRequest().
      if(
        (url.pathname==="/api/status"&&request.method==="GET")||
        (url.pathname==="/api/me"&&request.method==="GET")||
        (url.pathname==="/api/guilds"&&request.method==="GET")||
        (/^\/api\/guilds\/\d+\/meta$/.test(url.pathname)&&request.method==="GET")||
        (/^\/api\/guilds\/\d+\/channels\/reorder$/.test(url.pathname)&&request.method==="PATCH")||
        (/^\/api\/guilds\/\d+\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)&&request.method==="PATCH")||
        (/^\/api\/guilds\/\d+\/channels\/permissions\/bulk$/.test(url.pathname)&&request.method==="PATCH")||
        (/^\/api\/guilds\/\d+\/roles(?:\/\d+)?$/.test(url.pathname)&&["POST","PATCH","DELETE"].includes(request.method))||
        (/^\/api\/guilds\/\d+\/(verification|tickets)\/panel$/.test(url.pathname)&&request.method==="POST")
      ){
        return await handleApi(request,env,url);
      }

      await ensureSchema(env);

      if(url.pathname==="/paypay/webhook"&&request.method==="POST"){
        return handlePayPayWebhook(request,env,ctx);
      }
      if(url.pathname.startsWith("/media/vending/")){
        const mediaResponse=await handleVendingMedia(request,env,url);
        if(mediaResponse) return mediaResponse;
      }
      if(url.pathname.startsWith("/api/")){
        const backupResponse=await handleBackupApi(request,env,url);
        if(backupResponse) return backupResponse;
        const isVendingRoute=
          url.pathname.startsWith("/api/vending/")||
          /^\/api\/guilds\/\d+\/vending(?:\/|$)/.test(url.pathname);
        if(isVendingRoute){
          const vendingResponse=await handleVendingApi(request,env,url);
          if(vendingResponse) return vendingResponse;
        }
        return await handleApi(request,env,url);
      }
      throw new HttpError(404,"Not found");
    }catch(error){
      console.error(error);
      const status=
        error instanceof HttpError?error.status:
        error instanceof VendingHttpError?error.status:
        error instanceof BackupHttpError?error.status:
        error instanceof DiscordApiError?(error.status===429?429:error.status===403?403:502):
        500;
      const message=
        error instanceof DiscordApiError&&error.status===403
          ?error.message.includes('"code":50001')||error.message.includes('"code": 50001')
            ?"BOTが対象にアクセスできません。対象カテゴリ/チャンネルでBOT個別の「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」「ロールの管理」を確認してください。Administratorは必須ではありません"
            :error.message.includes('"code":50013')||error.message.includes('"code": 50013')
              ?"BOTにこの操作の権限がありません。BOTのサーバーロールとロールの並び順、チャンネル個別の権限を確認してください"
              :"DiscordがBOTの操作を拒否しました。BOTのサーバーロールと対象チャンネルの権限を確認してください"
          :error instanceof HttpError||error instanceof VendingHttpError||error instanceof BackupHttpError||error instanceof DiscordApiError
            ?error.message
            :"サーバー処理に失敗しました";
      return json(env,{error:status>=500?"server_error":"request_error",message},status);
    }
  },

  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    await ensureSchema(env);
    ctx.waitUntil(Promise.all([
      cleanExpired(env),
      auditWatch(env),
      paymentSweep(env),
      vendingSweep(env),
      ensureDiscordGateway(env),
      botAccessGuardSweep(env),
      backupRestoreSweep(env)
    ]).then(()=>undefined));
  }
} satisfies ExportedHandler<Env>;
