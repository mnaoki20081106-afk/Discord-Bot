import type { Env, GuildSettings, ProductRow } from "./types";
import { botFetch, botJson, DiscordApiError, syncAutoMod, type DiscordChannel, type DiscordRole } from "./discord";
import { getDashboardSession, getGuildSettings } from "./db";
import { ensureVendingSchema } from "./vending-db";
import { accountCreatedAt, decrypt, encrypt, json, randomId, randomToken, sha256Hex } from "./utils";
import {
  cancelRestoreJob,
  countRecoveryMembers,
  createBackupRecord,
  createRestoreJob,
  deleteBackupRecord,
  ensureBackupSchema,
  getBackupRecord,
  getBackupPayload,
  getRecoveryMember,
  getRestoreJob,
  listBackupRecords,
  listPanelDeployments,
  listRestoreJobs,
  markRecoveryMemberRevoked,
  nextRestoreJob,
  putRecoveryState,
  putRecoveryOAuthState,
  consumeRecoveryOAuthState,
  recordPanelDeployment,
  rotateRecoveryMember,
  updateRestoreJob,
  upsertRecoveryMember,
  type RecoveryMemberRow,
  type RestoreJobRow
} from "./backup-db";

class BackupHttpError extends Error {
  constructor(public status:number,message:string){super(message);}
}
export { BackupHttpError };

type SnapshotRole = {
  id:string;
  name:string;
  color:number;
  hoist:boolean;
  position:number;
  permissions:string;
  managed:boolean;
  mentionable:boolean;
  unicode_emoji?:string|null;
  icon?:string|null;
};

type SnapshotOverwrite = {id:string;type:number;allow:string;deny:string};

type SnapshotChannel = {
  id:string;
  name:string;
  type:number;
  position:number;
  parent_id?:string|null;
  topic?:string|null;
  nsfw?:boolean;
  rate_limit_per_user?:number;
  bitrate?:number;
  user_limit?:number;
  rtc_region?:string|null;
  video_quality_mode?:number;
  default_auto_archive_duration?:number;
  default_thread_rate_limit_per_user?:number;
  default_sort_order?:number|null;
  default_forum_layout?:number;
  available_tags?:unknown[];
  permission_overwrites:SnapshotOverwrite[];
};

type SnapshotMember = {
  user_id:string;
  username:string;
  nick:string|null;
  roles:string[];
  joined_at?:string|null;
  communication_disabled_until?:string|null;
};

type SnapshotBan = {
  user_id:string;
  username:string;
  reason:string|null;
};

type PanelSnapshot = {
  kind:"verification"|"ticket"|"product"|"vending"|"recovery";
  objectId:string;
  channelId:string;
  messageId:string|null;
};

type GuildSnapshot = {
  version:1|2;
  createdAt:number;
  sourceGuild:{
    id:string;
    name:string;
    icon:string|null;
    description?:string|null;
    verification_level?:number;
    default_message_notifications?:number;
    explicit_content_filter?:number;
    afk_timeout?:number;
    afk_channel_id?:string|null;
    system_channel_id?:string|null;
    system_channel_flags?:number;
    rules_channel_id?:string|null;
    public_updates_channel_id?:string|null;
    preferred_locale?:string;
    features?:string[];
  };
  roles:SnapshotRole[];
  channels:SnapshotChannel[];
  members:SnapshotMember[];
  bans?:SnapshotBan[];
  welcomeScreen?:Record<string,unknown>|null;
  widgetSettings?:Record<string,unknown>|null;
  emojis:unknown[];
  stickers:unknown[];
  bot:{
    settings:GuildSettings;
    legacyProducts:Record<string,unknown>[];
    vending:{
      machines:Record<string,unknown>[];
      products:Record<string,unknown>[];
      stock:Record<string,unknown>[];
      coupons:Record<string,unknown>[];
      notifications:Record<string,unknown>[];
      orders:Record<string,unknown>[];
    };
    panels:PanelSnapshot[];
  };
  capture:{
    membersComplete:boolean;
    bansComplete?:boolean;
    panelDiscoveryComplete:boolean;
    warnings:string[];
  };
};

type RestoreStats = {
  rolesCreated:number;
  rolesUpdated:number;
  channelsCreated:number;
  channelsUpdated:number;
  membersAdded:number;
  membersAlreadyPresent:number;
  membersSkippedNoConsent:number;
  membersRevoked:number;
  membersFailed:number;
  memberTimeoutsRestored:number;
  bansRestored:number;
  guildExtrasRestored:number;
  panelsRestored:number;
  productsRestored:number;
  vendingMachinesRestored:number;
  warnings:string[];
};

const EMPTY_STATS:RestoreStats = {
  rolesCreated:0,rolesUpdated:0,channelsCreated:0,channelsUpdated:0,
  membersAdded:0,membersAlreadyPresent:0,membersSkippedNoConsent:0,
  membersRevoked:0,membersFailed:0,memberTimeoutsRestored:0,bansRestored:0,
  guildExtrasRestored:0,panelsRestored:0,productsRestored:0,
  vendingMachinesRestored:0,warnings:[]
};

function parseObject<T extends Record<string,unknown>>(raw:string,fallback:T):T{
  try{
    const parsed=JSON.parse(raw);
    return parsed&&typeof parsed==="object"?parsed as T:fallback;
  }catch{
    return fallback;
  }
}

function parseStats(raw:string):RestoreStats{
  return {...EMPTY_STATS,...parseObject<Partial<RestoreStats>>(raw,{})} as RestoreStats;
}

async function requireDashboard(request:Request,env:Env):Promise<void>{
  const auth=request.headers.get("Authorization");
  if(!auth?.startsWith("Bearer ")) throw new BackupHttpError(401,"ログインが必要です");
  const token=auth.slice(7).trim();
  if(!token) throw new BackupHttpError(401,"ログインが必要です");
  const session=await getDashboardSession(env,await sha256Hex(token));
  if(!session) throw new BackupHttpError(401,"セッションが失効しています");
}

async function queryAll<T=Record<string,unknown>>(
  env:Env,sql:string,bindings:unknown[]=[]
):Promise<T[]>{
  try{
    let statement=env.DB.prepare(sql);
    if(bindings.length) statement=statement.bind(...bindings);
    return (await statement.all<T>()).results;
  }catch{
    return [];
  }
}

async function captureMembers(
  env:Env,guildId:string,warnings:string[]
):Promise<{members:SnapshotMember[];complete:boolean}>{
  const members:SnapshotMember[]=[];
  let after="";
  let complete=true;
  for(let page=0;page<100;page++){
    const path="/guilds/"+guildId+"/members?limit=1000"+(after?"&after="+after:"");
    let chunk:any[];
    try{
      chunk=await botJson<any[]>(env,path);
    }catch(error){
      complete=false;
      warnings.push(
        error instanceof DiscordApiError&&error.status===403
          ?"メンバー一覧を取得できませんでした。Discord Developer PortalでGUILD_MEMBERS Intentを有効にしてください。"
          :"メンバー一覧の取得が途中で失敗しました。取得済み分のみ保存しました。"
      );
      break;
    }
    for(const item of chunk){
      if(item.user?.bot) continue;
      if(!item.user?.id) continue;
      members.push({
        user_id:String(item.user.id),
        username:String(item.user.global_name||item.user.username||item.user.id),
        nick:item.nick??null,
        roles:Array.isArray(item.roles)?item.roles.map(String):[],
        joined_at:item.joined_at??null,
        communication_disabled_until:item.communication_disabled_until??null
      });
    }
    if(chunk.length<1000) break;
    after=String(chunk[chunk.length-1]?.user?.id??"");
    if(!after){complete=false;break;}
    if(page===99){
      complete=false;
      warnings.push("メンバー数が100,000人を超えたため、今回のバックアップでは先頭100,000人まで保存しました。");
    }
  }
  return {members,complete};
}

async function captureBans(
  env:Env,guildId:string,warnings:string[]
):Promise<{bans:SnapshotBan[];complete:boolean}>{
  const bans:SnapshotBan[]=[];
  let after="";
  let complete=true;
  for(let page=0;page<100;page++){
    const path="/guilds/"+guildId+"/bans?limit=1000"+(after?"&after="+after:"");
    let chunk:any[];
    try{
      chunk=await botJson<any[]>(env,path);
    }catch(error){
      complete=false;
      warnings.push(
        error instanceof DiscordApiError&&error.status===403
          ?"BAN一覧を取得できませんでした。BOTに「メンバーをBAN」権限が必要です。"
          :"BAN一覧の取得が途中で失敗しました。取得済み分のみ保存しました。"
      );
      break;
    }
    for(const item of chunk){
      if(!item.user?.id) continue;
      bans.push({
        user_id:String(item.user.id),
        username:String(item.user.global_name||item.user.username||item.user.id),
        reason:item.reason??null
      });
    }
    if(chunk.length<1000) break;
    after=String(chunk[chunk.length-1]?.user?.id??"");
    if(!after){complete=false;break;}
    if(page===99){
      complete=false;
      warnings.push("BAN数が100,000件を超えたため、今回のバックアップでは先頭100,000件まで保存しました。");
    }
  }
  return {bans,complete};
}

function findCustomIds(message:any):string[]{
  const ids:string[]=[];
  for(const row of Array.isArray(message?.components)?message.components:[]){
    for(const component of Array.isArray(row?.components)?row.components:[]){
      if(typeof component?.custom_id==="string") ids.push(component.custom_id);
    }
  }
  return ids;
}

async function discoverPanels(
  env:Env,guildId:string,channels:SnapshotChannel[],warnings:string[]
):Promise<{panels:PanelSnapshot[];complete:boolean}>{
  const found=new Map<string,PanelSnapshot>();
  let complete=true;

  for(const channel of channels){
    if(![0,5].includes(channel.type)) continue;
    try{
      const messages=await botJson<any[]>(env,"/channels/"+channel.id+"/messages?limit=100");
      for(const message of messages){
        for(const id of findCustomIds(message)){
          let panel:PanelSnapshot|null=null;
          if(id.startsWith("verify:start:")){
            panel={kind:"verification",objectId:"",channelId:channel.id,messageId:String(message.id)};
          }else if(id==="ticket:create"){
            panel={kind:"ticket",objectId:"",channelId:channel.id,messageId:String(message.id)};
          }else if(id.startsWith("buy:")){
            panel={kind:"product",objectId:id.slice(4),channelId:channel.id,messageId:String(message.id)};
          }else if(id.startsWith("vm:buy:")){
            panel={kind:"vending",objectId:id.slice("vm:buy:".length),channelId:channel.id,messageId:String(message.id)};
          }
          if(panel){
            const key=panel.kind+":"+panel.objectId;
            if(!found.has(key)) found.set(key,panel);
          }
        }
      }
    }catch{
      complete=false;
    }
  }

  for(const row of await listPanelDeployments(env,guildId)){
    const kind=row.kind as PanelSnapshot["kind"];
    if(!["verification","ticket","product","vending","recovery"].includes(kind)) continue;
    const key=kind+":"+row.object_id;
    if(!found.has(key)){
      found.set(key,{
        kind,objectId:row.object_id,channelId:row.channel_id,messageId:row.message_id
      });
    }
  }

  if(!complete){
    warnings.push("一部チャンネルの最近のメッセージを確認できなかったため、古いパネル設置位置は完全には特定できない可能性があります。");
  }
  return {panels:[...found.values()],complete};
}

async function captureBotData(env:Env,guildId:string,panels:PanelSnapshot[]){
  await ensureVendingSchema(env).catch(()=>undefined);
  const settings=await getGuildSettings(env,guildId);
  const legacyProducts=await queryAll<Record<string,unknown>>(
    env,"SELECT * FROM products WHERE guild_id=?",[guildId]
  );
  const machines=await queryAll<Record<string,unknown>>(
    env,"SELECT * FROM vending_machines WHERE guild_id=?",[guildId]
  );
  const machineIds=machines.map(row=>String(row.id??"")).filter(Boolean);

  const queryByIds=async(table:string,column:string)=>{
    if(!machineIds.length) return [] as Record<string,unknown>[];
    const placeholders=machineIds.map(()=>"?").join(",");
    return queryAll<Record<string,unknown>>(
      env,`SELECT * FROM ${table} WHERE ${column} IN (${placeholders})`,machineIds
    );
  };

  const vendingProducts=await queryByIds("vending_products","vending_machine_id");
  const productIds=vendingProducts.map(row=>String(row.id??"")).filter(Boolean);
  let stock:Record<string,unknown>[]=[];
  if(productIds.length){
    const placeholders=productIds.map(()=>"?").join(",");
    stock=await queryAll(env,`SELECT * FROM vending_stock WHERE product_id IN (${placeholders})`,productIds);
  }

  const [coupons,notifications,orders]=await Promise.all([
    queryByIds("vending_coupons","vending_machine_id"),
    queryByIds("vending_stock_notifications","vending_machine_id"),
    queryAll<Record<string,unknown>>(env,"SELECT * FROM vending_orders WHERE guild_id=?",[guildId])
  ]);

  return {
    settings,
    legacyProducts,
    vending:{machines,products:vendingProducts,stock,coupons,notifications,orders},
    panels
  };
}

async function createSnapshot(env:Env,guildId:string,label?:string|null){
  await ensureBackupSchema(env);
  const warnings:string[]=[];
  const guild=await botJson<any>(env,"/guilds/"+guildId+"?with_counts=true");
  const [rolesRaw,channelsRaw,emojis,stickers]=await Promise.all([
    botJson<any[]>(env,"/guilds/"+guildId+"/roles"),
    botJson<any[]>(env,"/guilds/"+guildId+"/channels"),
    botJson<any[]>(env,"/guilds/"+guildId+"/emojis").catch(()=>[]),
    botJson<any[]>(env,"/guilds/"+guildId+"/stickers").catch(()=>[])
  ]);

  const roles:SnapshotRole[]=rolesRaw.map(role=>({
    id:String(role.id),
    name:String(role.name),
    color:Number(role.color??0),
    hoist:Boolean(role.hoist),
    position:Number(role.position??0),
    permissions:String(role.permissions??"0"),
    managed:Boolean(role.managed),
    mentionable:Boolean(role.mentionable),
    unicode_emoji:role.unicode_emoji??null,
    icon:role.icon??null
  }));

  const channels:SnapshotChannel[]=channelsRaw
    .filter(channel=>!([10,11,12].includes(Number(channel.type))))
    .map(channel=>({
      id:String(channel.id),
      name:String(channel.name),
      type:Number(channel.type),
      position:Number(channel.position??0),
      parent_id:channel.parent_id??null,
      topic:channel.topic??null,
      nsfw:Boolean(channel.nsfw),
      rate_limit_per_user:Number(channel.rate_limit_per_user??0),
      bitrate:channel.bitrate===undefined?undefined:Number(channel.bitrate),
      user_limit:channel.user_limit===undefined?undefined:Number(channel.user_limit),
      rtc_region:channel.rtc_region??null,
      video_quality_mode:channel.video_quality_mode===undefined?undefined:Number(channel.video_quality_mode),
      default_auto_archive_duration:channel.default_auto_archive_duration===undefined
        ?undefined:Number(channel.default_auto_archive_duration),
      default_thread_rate_limit_per_user:channel.default_thread_rate_limit_per_user===undefined
        ?undefined:Number(channel.default_thread_rate_limit_per_user),
      default_sort_order:channel.default_sort_order??null,
      default_forum_layout:channel.default_forum_layout===undefined?undefined:Number(channel.default_forum_layout),
      available_tags:Array.isArray(channel.available_tags)?channel.available_tags:undefined,
      permission_overwrites:Array.isArray(channel.permission_overwrites)
        ?channel.permission_overwrites.map((ow:any)=>({
          id:String(ow.id),type:Number(ow.type),allow:String(ow.allow??"0"),deny:String(ow.deny??"0")
        }))
        :[]
    }));

  const [memberCapture,banCapture,panelCapture,welcomeScreen,widgetSettings]=await Promise.all([
    captureMembers(env,guildId,warnings),
    captureBans(env,guildId,warnings),
    discoverPanels(env,guildId,channels,warnings),
    botJson<Record<string,unknown>>(env,"/guilds/"+guildId+"/welcome-screen").catch(()=>{
      warnings.push("Welcome Screenを取得できませんでした。BOTの「サーバー管理」権限を確認してください。");
      return null;
    }),
    botJson<Record<string,unknown>>(env,"/guilds/"+guildId+"/widget").catch(()=>{
      warnings.push("Server Widget設定を取得できませんでした。BOTの「サーバー管理」権限を確認してください。");
      return null;
    })
  ]);
  const recoveryMemberCount=await countRecoveryMembers(env,guildId);
  const bot=await captureBotData(env,guildId,panelCapture.panels);

  const snapshot:GuildSnapshot={
    version:2,
    createdAt:Date.now(),
    sourceGuild:{
      id:String(guild.id),
      name:String(guild.name),
      icon:guild.icon??null,
      description:guild.description??null,
      verification_level:guild.verification_level,
      default_message_notifications:guild.default_message_notifications,
      explicit_content_filter:guild.explicit_content_filter,
      afk_timeout:guild.afk_timeout,
      afk_channel_id:guild.afk_channel_id??null,
      system_channel_id:guild.system_channel_id??null,
      system_channel_flags:guild.system_channel_flags,
      rules_channel_id:guild.rules_channel_id??null,
      public_updates_channel_id:guild.public_updates_channel_id??null,
      preferred_locale:guild.preferred_locale,
      features:Array.isArray(guild.features)?guild.features.map(String):[]
    },
    roles,channels,members:memberCapture.members,bans:banCapture.bans,
    welcomeScreen,widgetSettings,emojis,stickers,bot,
    capture:{
      membersComplete:memberCapture.complete,
      bansComplete:banCapture.complete,
      panelDiscoveryComplete:panelCapture.complete,
      warnings
    }
  };

  const payloadEnc=await encrypt(env.SESSION_ENCRYPTION_KEY,JSON.stringify(snapshot));
  const row=await createBackupRecord(env,{
    sourceGuildId:guildId,
    sourceGuildName:String(guild.name),
    label:label?.trim().slice(0,80)||null,
    payloadEnc,
    roleCount:roles.length,
    channelCount:channels.length,
    memberCount:memberCapture.members.length,
    recoveryMemberCount,
    warnings
  });

  return publicBackup(row);
}

function publicBackup(row:any){
  return {
    id:row.id,
    sourceGuildId:row.source_guild_id,
    sourceGuildName:row.source_guild_name,
    label:row.label,
    createdAt:row.created_at,
    schemaVersion:row.schema_version,
    roleCount:row.role_count,
    channelCount:row.channel_count,
    memberCount:row.member_count,
    recoveryMemberCount:row.recovery_member_count,
    warnings:(()=>{try{return JSON.parse(row.warnings_json||"[]")}catch{return []}})()
  };
}

function publicJob(row:RestoreJobRow){
  return {
    id:row.id,
    backupId:row.backup_id,
    targetGuildId:row.target_guild_id,
    status:row.status,
    phase:row.phase,
    cursor:row.cursor,
    result:parseStats(row.result_json),
    error:row.error,
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
}

async function loadSnapshot(env:Env,backupId:string):Promise<GuildSnapshot>{
  const row=await getBackupRecord(env,backupId);
  if(!row) throw new BackupHttpError(404,"バックアップが見つかりません");
  try{
    return JSON.parse(
      await decrypt(env.SESSION_ENCRYPTION_KEY,await getBackupPayload(env,row))
    ) as GuildSnapshot;
  }catch(error){
    console.error("backup decrypt failed",error);
    throw new BackupHttpError(500,"バックアップの復号に失敗しました。暗号化キーが一致しているか確認してください");
  }
}

function mapOverwrite(
  overwrite:SnapshotOverwrite,
  sourceGuildId:string,
  targetGuildId:string,
  roleMap:Record<string,string>
):SnapshotOverwrite|null{
  if(overwrite.type===0){
    const id=overwrite.id===sourceGuildId?targetGuildId:roleMap[overwrite.id];
    if(!id) return null;
    return {...overwrite,id};
  }
  return overwrite;
}

function channelPayload(
  channel:SnapshotChannel,
  sourceGuildId:string,
  targetGuildId:string,
  roleMap:Record<string,string>,
  channelMap:Record<string,string>
):Record<string,unknown>{
  const payload:Record<string,unknown>={
    name:channel.name,
    type:channel.type,
    position:channel.position,
    permission_overwrites:channel.permission_overwrites
      .map(item=>mapOverwrite(item,sourceGuildId,targetGuildId,roleMap))
      .filter(Boolean)
  };
  const parent=channel.parent_id?channelMap[channel.parent_id]:null;
  if(parent) payload.parent_id=parent;

  if([0,5,15,16].includes(channel.type)){
    payload.topic=channel.topic??null;
    payload.nsfw=Boolean(channel.nsfw);
    payload.rate_limit_per_user=channel.rate_limit_per_user??0;
    if(channel.default_auto_archive_duration) payload.default_auto_archive_duration=channel.default_auto_archive_duration;
  }
  if([2,13].includes(channel.type)){
    if(channel.bitrate) payload.bitrate=channel.bitrate;
    payload.user_limit=channel.user_limit??0;
    if(channel.rtc_region!==undefined) payload.rtc_region=channel.rtc_region;
    if(channel.video_quality_mode) payload.video_quality_mode=channel.video_quality_mode;
  }
  if(channel.type===15){
    if(channel.default_thread_rate_limit_per_user!==undefined){
      payload.default_thread_rate_limit_per_user=channel.default_thread_rate_limit_per_user;
    }
    if(channel.default_sort_order!==undefined) payload.default_sort_order=channel.default_sort_order;
    if(channel.default_forum_layout!==undefined) payload.default_forum_layout=channel.default_forum_layout;
    if(channel.available_tags) payload.available_tags=channel.available_tags;
  }
  return payload;
}

async function restoreRoleBatch(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot,batch=6
):Promise<void>{
  const editable=snapshot.roles
    .filter(role=>!role.managed&&role.id!==snapshot.sourceGuild.id)
    .sort((a,b)=>a.position-b.position);
  const roleMap=parseObject<Record<string,string>>(job.role_map_json,{});
  roleMap[snapshot.sourceGuild.id]=job.target_guild_id;
  const stats=parseStats(job.result_json);
  const targetRoles=await botJson<any[]>(env,"/guilds/"+job.target_guild_id+"/roles");

  if(job.cursor===0){
    const sourceEveryone=snapshot.roles.find(role=>role.id===snapshot.sourceGuild.id);
    if(sourceEveryone){
      await botJson(env,"/guilds/"+job.target_guild_id+"/roles/"+job.target_guild_id,{
        method:"PATCH",
        body:JSON.stringify({permissions:sourceEveryone.permissions})
      });
    }
  }

  let cursor=job.cursor;
  for(let processed=0;processed<batch&&cursor<editable.length;processed++,cursor++){
    const source=editable[cursor]!;
    let targetId=roleMap[source.id];
    let target=targetId?targetRoles.find(role=>role.id===targetId):undefined;
    if(!target){
      target=targetRoles.find(role=>!role.managed&&role.id!==job.target_guild_id&&role.name===source.name);
    }
    const body={
      name:source.name,
      permissions:source.permissions,
      color:source.color,
      hoist:source.hoist,
      mentionable:source.mentionable
    };
    if(!target){
      target=await botJson<any>(env,"/guilds/"+job.target_guild_id+"/roles",{
        method:"POST",body:JSON.stringify(body)
      });
      targetRoles.push(target);
      stats.rolesCreated++;
    }else{
      await botJson(env,"/guilds/"+job.target_guild_id+"/roles/"+target.id,{
        method:"PATCH",body:JSON.stringify(body)
      });
      stats.rolesUpdated++;
    }
    roleMap[source.id]=String(target.id);
  }

  if(cursor>=editable.length){
    const positions=editable
      .map(role=>roleMap[role.id]?{id:roleMap[role.id],position:role.position}:null)
      .filter(Boolean);
    if(positions.length){
      await botJson(env,"/guilds/"+job.target_guild_id+"/roles",{
        method:"PATCH",body:JSON.stringify(positions)
      }).catch(()=>undefined);
    }
    await updateRestoreJob(env,job.id,{
      phase:"categories",cursor:0,role_map_json:JSON.stringify(roleMap),
      result_json:JSON.stringify(stats),status:"running",error:null
    });
  }else{
    await updateRestoreJob(env,job.id,{
      cursor,role_map_json:JSON.stringify(roleMap),result_json:JSON.stringify(stats),
      status:"running",error:null
    });
  }
}

async function restoreChannelBatch(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot,categories:boolean,batch=5
):Promise<void>{
  const list=snapshot.channels
    .filter(channel=>categories?channel.type===4:channel.type!==4)
    .sort((a,b)=>a.position-b.position);
  const roleMap=parseObject<Record<string,string>>(job.role_map_json,{});
  const channelMap=parseObject<Record<string,string>>(job.channel_map_json,{});
  const stats=parseStats(job.result_json);
  const targetChannels=await botJson<any[]>(env,"/guilds/"+job.target_guild_id+"/channels");

  let cursor=job.cursor;
  for(let processed=0;processed<batch&&cursor<list.length;processed++,cursor++){
    const source=list[cursor]!;
    let targetId=channelMap[source.id];
    let target=targetId?targetChannels.find(channel=>channel.id===targetId):undefined;
    const mappedParent=source.parent_id?channelMap[source.parent_id]??null:null;

    if(!target){
      target=targetChannels.find(channel=>
        Number(channel.type)===source.type&&
        String(channel.name)===source.name&&
        (categories||(channel.parent_id??null)===mappedParent)
      );
    }

    const payload=channelPayload(
      source,snapshot.sourceGuild.id,job.target_guild_id,roleMap,channelMap
    );
    if(!target){
      target=await botJson<any>(env,"/guilds/"+job.target_guild_id+"/channels",{
        method:"POST",body:JSON.stringify(payload)
      });
      targetChannels.push(target);
      stats.channelsCreated++;
    }else{
      const editPayload={...payload};
      delete (editPayload as any).type;
      await botJson(env,"/channels/"+target.id,{
        method:"PATCH",body:JSON.stringify(editPayload)
      });
      stats.channelsUpdated++;
    }
    channelMap[source.id]=String(target.id);
  }

  if(cursor>=list.length){
    await updateRestoreJob(env,job.id,{
      phase:categories?"channels":"positions",
      cursor:0,
      channel_map_json:JSON.stringify(channelMap),
      result_json:JSON.stringify(stats),
      status:"running",error:null
    });
  }else{
    await updateRestoreJob(env,job.id,{
      cursor,channel_map_json:JSON.stringify(channelMap),
      result_json:JSON.stringify(stats),status:"running",error:null
    });
  }
}

async function applyPositionsAndGuild(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot
):Promise<void>{
  const channelMap=parseObject<Record<string,string>>(job.channel_map_json,{});
  const payload=snapshot.channels
    .map(channel=>channelMap[channel.id]
      ?{
        id:channelMap[channel.id],
        position:channel.position,
        ...(channel.parent_id&&channelMap[channel.parent_id]
          ?{parent_id:channelMap[channel.parent_id]}
          :{})
      }
      :null
    ).filter(Boolean);
  if(payload.length){
    await botJson(env,"/guilds/"+job.target_guild_id+"/channels",{
      method:"PATCH",body:JSON.stringify(payload)
    }).catch(()=>undefined);
  }

  const guildPatch:Record<string,unknown>={
    name:snapshot.sourceGuild.name,
    verification_level:snapshot.sourceGuild.verification_level,
    default_message_notifications:snapshot.sourceGuild.default_message_notifications,
    explicit_content_filter:snapshot.sourceGuild.explicit_content_filter,
    afk_timeout:snapshot.sourceGuild.afk_timeout,
    system_channel_flags:snapshot.sourceGuild.system_channel_flags,
    preferred_locale:snapshot.sourceGuild.preferred_locale
  };
  if(snapshot.sourceGuild.afk_channel_id&&channelMap[snapshot.sourceGuild.afk_channel_id]){
    guildPatch.afk_channel_id=channelMap[snapshot.sourceGuild.afk_channel_id];
  }
  if(snapshot.sourceGuild.system_channel_id&&channelMap[snapshot.sourceGuild.system_channel_id]){
    guildPatch.system_channel_id=channelMap[snapshot.sourceGuild.system_channel_id];
  }
  if(snapshot.sourceGuild.rules_channel_id&&channelMap[snapshot.sourceGuild.rules_channel_id]){
    guildPatch.rules_channel_id=channelMap[snapshot.sourceGuild.rules_channel_id];
  }
  if(snapshot.sourceGuild.public_updates_channel_id&&channelMap[snapshot.sourceGuild.public_updates_channel_id]){
    guildPatch.public_updates_channel_id=channelMap[snapshot.sourceGuild.public_updates_channel_id];
  }
  for(const key of Object.keys(guildPatch)){
    if(guildPatch[key]===undefined) delete guildPatch[key];
  }
  await botJson(env,"/guilds/"+job.target_guild_id,{
    method:"PATCH",body:JSON.stringify(guildPatch)
  }).catch(error=>{
    const stats=parseStats(job.result_json);
    stats.warnings.push("サーバー名・基本設定の一部はDiscord側の制約により復元できませんでした。");
    return updateRestoreJob(env,job.id,{result_json:JSON.stringify(stats)});
  });

  await updateRestoreJob(env,job.id,{phase:"guild-extras",cursor:0,status:"running",error:null});
}

async function restoreGuildExtras(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot
):Promise<void>{
  const channelMap=parseObject<Record<string,string>>(job.channel_map_json,{});
  const stats=parseStats(job.result_json);

  if(snapshot.widgetSettings){
    try{
      const source=snapshot.widgetSettings as any;
      await botJson(env,"/guilds/"+job.target_guild_id+"/widget",{
        method:"PATCH",
        body:JSON.stringify({
          enabled:Boolean(source.enabled),
          channel_id:source.channel_id?channelMap[String(source.channel_id)]??null:null
        })
      });
      stats.guildExtrasRestored++;
    }catch(error){
      stats.warnings.push(
        "Server Widget設定の復元に失敗しました: "+
        String((error as Error)?.message??error).slice(0,140)
      );
    }
  }

  if(snapshot.welcomeScreen){
    try{
      const source=snapshot.welcomeScreen as any;
      const welcomeChannels=(Array.isArray(source.welcome_channels)?source.welcome_channels:[])
        .map((item:any)=>{
          const mapped=channelMap[String(item.channel_id??"")];
          if(!mapped) return null;
          return {
            channel_id:mapped,
            description:String(item.description??"").slice(0,140),
            emoji_id:null,
            emoji_name:item.emoji_id?null:(item.emoji_name??null)
          };
        })
        .filter(Boolean);
      await botJson(env,"/guilds/"+job.target_guild_id+"/welcome-screen",{
        method:"PATCH",
        body:JSON.stringify({
          enabled:Array.isArray(snapshot.sourceGuild.features)
            ?snapshot.sourceGuild.features.includes("WELCOME_SCREEN_ENABLED")
            :undefined,
          description:source.description??null,
          welcome_channels:welcomeChannels
        })
      });
      stats.guildExtrasRestored++;
    }catch(error){
      stats.warnings.push(
        "Welcome Screenの復元に失敗しました: "+
        String((error as Error)?.message??error).slice(0,140)
      );
    }
  }

  await updateRestoreJob(env,job.id,{
    phase:"bans",cursor:0,result_json:JSON.stringify(stats),status:"running",error:null
  });
}

async function restoreBanBatch(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot,batch=10
):Promise<void>{
  const bans=snapshot.bans??[];
  const stats=parseStats(job.result_json);
  if(job.cursor>=bans.length){
    await updateRestoreJob(env,job.id,{
      phase:"bot-settings",cursor:0,result_json:JSON.stringify(stats),status:"running",error:null
    });
    return;
  }

  let cursor=job.cursor;
  const stop=Math.min(bans.length,cursor+batch);
  while(cursor<stop){
    const ban=bans[cursor]!;
    try{
      const reason=ban.reason?.trim()
        ?encodeURIComponent(("バックアップ復元: "+ban.reason).slice(0,480))
        :encodeURIComponent("バックアップからBAN状態を復元");
      await botJson(env,"/guilds/"+job.target_guild_id+"/bans/"+ban.user_id,{
        method:"PUT",
        headers:{"X-Audit-Log-Reason":reason},
        body:JSON.stringify({delete_message_seconds:0})
      });
      stats.bansRestored++;
    }catch(error){
      stats.warnings.push(
        "BAN復元失敗 "+ban.user_id+": "+
        String((error as Error)?.message??error).slice(0,120)
      );
    }
    cursor++;
    if(cursor<stop) await new Promise(resolve=>setTimeout(resolve,350));
  }

  await updateRestoreJob(env,job.id,{
    cursor,
    ...(cursor>=bans.length?{phase:"bot-settings",cursor:0}:{}),
    result_json:JSON.stringify(stats),status:"running",error:null
  });
}

function mapId(id:string|null|undefined,map:Record<string,string>):string|null{
  if(!id) return null;
  return map[id]??null;
}

async function restoreBotSettings(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot
):Promise<void>{
  const roleMap=parseObject<Record<string,string>>(job.role_map_json,{});
  const channelMap=parseObject<Record<string,string>>(job.channel_map_json,{});
  const source=snapshot.bot.settings;
  const mapped:GuildSettings={
    ...source,
    logChannelId:mapId(source.logChannelId,channelMap),
    verifiedRoleId:mapId(source.verifiedRoleId,roleMap),
    ticketSupportRoleIds:source.ticketSupportRoleIds.map(id=>roleMap[id]).filter(Boolean) as string[],
    trustedRoleIds:source.trustedRoleIds.map(id=>roleMap[id]).filter(Boolean) as string[]
  };

  await env.DB.prepare(`
    INSERT INTO guild_settings(guild_id,config,updated_at) VALUES (?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at
  `).bind(job.target_guild_id,JSON.stringify(mapped),Date.now()).run();
  await syncAutoMod(env,job.target_guild_id,mapped).catch(()=>undefined);

  await updateRestoreJob(env,job.id,{phase:"legacy-products",cursor:0,status:"running",error:null});
}

async function restoreLegacyProducts(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot
):Promise<void>{
  const roleMap=parseObject<Record<string,string>>(job.role_map_json,{});
  const productMap=parseObject<Record<string,string>>(job.product_map_json,{});
  const stats=parseStats(job.result_json);

  for(const row of snapshot.bot.legacyProducts){
    const oldId=String(row.id??"");
    const name=String(row.name??"");
    if(!name) continue;

    const existing=await env.DB.prepare(
      "SELECT id FROM products WHERE guild_id=? AND name=? AND active=1 LIMIT 1"
    ).bind(job.target_guild_id,name).first<{id:string}>();
    if(existing){
      if(oldId) productMap[oldId]=existing.id;
      continue;
    }

    const stableKey=oldId||name;
    const id=(await sha256Hex(
      "restore:legacy-product:"+job.target_guild_id+":"+stableKey
    )).slice(0,32);
    const roleId=row.role_id?roleMap[String(row.role_id)]??null:null;
    const result=await env.DB.prepare(`
      INSERT OR IGNORE INTO products(
        id,guild_id,name,description,price_yen,active,delivery_type,role_id,delivery_text,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id,job.target_guild_id,name,String(row.description??""),
      Number(row.price_yen??1),Number(row.active??1),String(row.delivery_type??"text"),
      roleId,row.delivery_text??null,Date.now()
    ).run();
    if(oldId) productMap[oldId]=id;
    if((result.meta.changes??0)>0) stats.productsRestored++;
  }

  await updateRestoreJob(env,job.id,{
    phase:"vending",cursor:0,product_map_json:JSON.stringify(productMap),
    result_json:JSON.stringify(stats),status:"running",error:null
  });
}

async function restoreVending(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot
):Promise<void>{
  await ensureVendingSchema(env);
  const channelMap=parseObject<Record<string,string>>(job.channel_map_json,{});
  const roleMap=parseObject<Record<string,string>>(job.role_map_json,{});
  const vmMap=parseObject<Record<string,string>>(job.vm_map_json,{});
  const productMap=parseObject<Record<string,string>>(job.product_map_json,{});
  const stats=parseStats(job.result_json);

  for(const row of snapshot.bot.vending.machines){
    const oldId=String(row.id??"");
    const name=String(row.name??"自販機");
    if(!oldId) continue;
    if(vmMap[oldId]) continue;

    const existing=await env.DB.prepare(
      "SELECT id FROM vending_machines WHERE guild_id=? AND name=? AND active=1 LIMIT 1"
    ).bind(job.target_guild_id,name).first<{id:string}>();
    if(existing){
      vmMap[oldId]=existing.id;
      continue;
    }

    const id=(await sha256Hex(
      "restore:vending-machine:"+job.target_guild_id+":"+oldId
    )).slice(0,32);
    const result=await env.DB.prepare(`
      INSERT OR IGNORE INTO vending_machines(
        id,guild_id,owner_id,name,public_log_channel_id,local_log_channel_id,
        private_log_channel_id,role_id,panel_title,panel_description,panel_image_url,
        active,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id,job.target_guild_id,String(row.owner_id??"shared-dashboard"),name,
      mapId(row.public_log_channel_id as string|null,channelMap),
      mapId(row.local_log_channel_id as string|null,channelMap),
      mapId(row.private_log_channel_id as string|null,channelMap),
      mapId(row.role_id as string|null,roleMap),
      row.panel_title??null,row.panel_description??null,row.panel_image_url??null,
      Number(row.active??1),Date.now(),Date.now()
    ).run();
    vmMap[oldId]=id;
    if((result.meta.changes??0)>0) stats.vendingMachinesRestored++;
  }

  for(const row of snapshot.bot.vending.products){
    const oldId=String(row.id??"");
    const vmId=vmMap[String(row.vending_machine_id??"")];
    const name=String(row.name??"商品");
    if(!oldId||!vmId||productMap[oldId]) continue;

    const existing=await env.DB.prepare(
      "SELECT id FROM vending_products WHERE vending_machine_id=? AND name=? AND active=1 LIMIT 1"
    ).bind(vmId,name).first<{id:string}>();
    if(existing){
      productMap[oldId]=existing.id;
      continue;
    }

    const id=(await sha256Hex(
      "restore:vending-product:"+job.target_guild_id+":"+oldId
    )).slice(0,32);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO vending_products(
        id,vending_machine_id,name,description,price_paypay,price_kyash,emoji,
        infinite_stock,infinite_content,sales_count,active,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id,vmId,name,String(row.description??""),
      Number(row.price_paypay??0),Number(row.price_kyash??0),row.emoji??null,
      Number(row.infinite_stock??0),row.infinite_content??null,Number(row.sales_count??0),
      Number(row.active??1),Date.now(),Date.now()
    ).run();
    productMap[oldId]=id;
  }

  for(const row of snapshot.bot.vending.stock){
    if(String(row.state??"available")!=="available") continue;
    const oldStockId=String(row.id??"");
    const productId=productMap[String(row.product_id??"")];
    if(!oldStockId||!productId) continue;
    const id=(await sha256Hex(
      "restore:vending-stock:"+job.target_guild_id+":"+oldStockId
    )).slice(0,32);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO vending_stock(
        id,product_id,content,state,order_id,reserved_until,created_at,sold_at
      ) VALUES (?,?,?,'available',NULL,NULL,?,NULL)
    `).bind(id,productId,String(row.content??""),Date.now()).run();
  }

  for(const row of snapshot.bot.vending.coupons){
    const vmId=vmMap[String(row.vending_machine_id??"")];
    if(!vmId||Number(row.active??1)!==1) continue;
    const code=String(row.code??"");
    if(!code) continue;
    const existing=await env.DB.prepare(
      "SELECT vending_machine_id FROM vending_coupons WHERE code=?"
    ).bind(code).first<{vending_machine_id:string}>();
    if(existing){
      if(existing.vending_machine_id!==vmId){
        stats.warnings.push(
          "クーポン "+code+" は既存の別自販機で使用中のため、重複防止のため復元をスキップしました。"
        );
      }
      continue;
    }
    await env.DB.prepare(`
      INSERT INTO vending_coupons(code,vending_machine_id,owner_id,discount,active,created_at)
      VALUES (?,?,?,?,1,?)
    `).bind(code,vmId,String(row.owner_id??"shared-dashboard"),Number(row.discount??0),Date.now()).run();
  }

  for(const row of snapshot.bot.vending.notifications){
    const vmId=vmMap[String(row.vending_machine_id??"")];
    const channelId=mapId(row.channel_id as string|null,channelMap);
    const roleId=mapId(row.role_id as string|null,roleMap);
    if(!vmId||!channelId||!roleId) continue;
    await env.DB.prepare(`
      INSERT INTO vending_stock_notifications(vending_machine_id,guild_id,channel_id,role_id,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(vending_machine_id) DO UPDATE SET
        guild_id=excluded.guild_id,channel_id=excluded.channel_id,
        role_id=excluded.role_id,updated_at=excluded.updated_at
    `).bind(vmId,job.target_guild_id,channelId,roleId,Date.now()).run();
  }

  if(snapshot.bot.vending.orders.length){
    stats.warnings.push(
      "自販機の過去注文履歴はバックアップ内に保持していますが、二重配送防止のため稼働DBには再投入していません。"
    );
  }

  await updateRestoreJob(env,job.id,{
    phase:"panels",cursor:0,vm_map_json:JSON.stringify(vmMap),
    product_map_json:JSON.stringify(productMap),result_json:JSON.stringify(stats),
    status:"running",error:null
  });
}

async function postMessage(env:Env,channelId:string,payload:unknown):Promise<{id?:string}>{
  return botJson<{id?:string}>(env,"/channels/"+channelId+"/messages",{
    method:"POST",body:JSON.stringify(payload)
  });
}

async function restorePanels(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot
):Promise<void>{
  const channelMap=parseObject<Record<string,string>>(job.channel_map_json,{});
  const vmMap=parseObject<Record<string,string>>(job.vm_map_json,{});
  const productMap=parseObject<Record<string,string>>(job.product_map_json,{});
  const stats=parseStats(job.result_json);
  const existingDeployments=await listPanelDeployments(env,job.target_guild_id);

  for(const panel of snapshot.bot.panels){
    const channelId=channelMap[panel.channelId];
    if(!channelId) continue;
    try{
      let payload:unknown|null=null;
      let objectId=panel.objectId;
      if(panel.kind==="verification"){
        objectId="";
        payload={
          embeds:[{title:"サーバー認証",description:"下のボタンから認証を完了してください。",color:5793266}],
          components:[{type:1,components:[{
            type:2,custom_id:"verify:start:"+job.target_guild_id,label:"認証する",style:3
          }]}]
        };
      }else if(panel.kind==="ticket"){
        objectId="";
        payload={
          embeds:[{title:"サポート",description:"問い合わせ用チケットを作成します。",color:5793266}],
          components:[{type:1,components:[{
            type:2,custom_id:"ticket:create",label:"チケットを作成",style:1
          }]}]
        };
      }else if(panel.kind==="product"){
        const newProductId=productMap[panel.objectId]??panel.objectId;
        const row=await env.DB.prepare("SELECT * FROM products WHERE id=?")
          .bind(newProductId).first<any>();
        if(row){
          objectId=newProductId;
          payload={
            embeds:[{
              title:row.name,
              description:row.description||"購入ボタンからPayPay決済へ進めます。",
              color:443221,
              fields:[{name:"価格",value:"¥"+Number(row.price_yen).toLocaleString("ja-JP")}]
            }],
            components:[{type:1,components:[{
              type:2,custom_id:"buy:"+newProductId,label:"PayPayで購入",style:3
            }]}]
          };
        }
      }else if(panel.kind==="recovery"){
        stats.warnings.push("復旧登録パネルは復元先で新しいWorker URLを埋め込む必要があるため、管理画面から再設置してください。");
        continue;
      }else if(panel.kind==="vending"){
        const newVmId=vmMap[panel.objectId];
        if(newVmId){
          objectId=newVmId;
          const vm=await env.DB.prepare("SELECT * FROM vending_machines WHERE id=?").bind(newVmId).first<any>();
          const products=(await env.DB.prepare(
            "SELECT * FROM vending_products WHERE vending_machine_id=? AND active=1 ORDER BY created_at ASC"
          ).bind(newVmId).all<any>()).results;
          if(vm){
            const lines=products.map((p:any)=>"**"+p.name+"**\nPayPay: "+p.price_paypay+"円 / Kyash: "+p.price_kyash+"円");
            payload={
              embeds:[{
                title:vm.panel_title||vm.name||"自販機",
                description:(vm.panel_description||"購入したい商品を下のボタンから選択してください。")+
                  (lines.length?"\n\n"+lines.join("\n\n"):"\n\n現在販売中の商品はありません。"),
                color:5763719,
                ...(vm.panel_image_url?{image:{url:vm.panel_image_url}}:{})
              }],
              components:[{type:1,components:[
                {type:2,style:3,label:"購入する",emoji:{name:"🛒"},custom_id:"vm:buy:"+newVmId},
                {type:2,style:1,label:"在庫・販売数",emoji:{name:"📦"},custom_id:"vm:stock:"+newVmId}
              ]}]
            };
          }
        }
      }
      if(!payload) continue;

      const prior=existingDeployments.find(row=>
        row.kind===panel.kind&&row.object_id===objectId&&row.channel_id===channelId
      );
      if(prior?.message_id){
        try{
          await botJson(env,"/channels/"+channelId+"/messages/"+prior.message_id);
          continue;
        }catch{
          // The recorded panel is gone; recreate it below.
        }
      }

      const message=await postMessage(env,channelId,payload);
      await recordPanelDeployment(env,{
        guildId:job.target_guild_id,kind:panel.kind,objectId,channelId,messageId:message.id??null
      });
      stats.panelsRestored++;
    }catch(error){
      stats.warnings.push("パネル復元に失敗: "+panel.kind+" / "+String((error as Error)?.message??error).slice(0,120));
    }
  }

  await updateRestoreJob(env,job.id,{
    phase:"members",cursor:0,result_json:JSON.stringify(stats),status:"running",error:null
  });
}

function basicAuth(env:Env):string{
  return btoa(env.DISCORD_APPLICATION_ID+":"+env.DISCORD_CLIENT_SECRET);
}

async function oauthTokenRequest(
  env:Env,params:URLSearchParams
):Promise<{access_token:string;refresh_token:string;expires_in:number}>{
  const response=await fetch("https://discord.com/api/v10/oauth2/token",{
    method:"POST",
    headers:{
      Authorization:"Basic "+basicAuth(env),
      "Content-Type":"application/x-www-form-urlencoded"
    },
    body:params
  });
  const text=await response.text();
  if(!response.ok){
    let code="";
    try{code=String((JSON.parse(text) as any).error??"")}catch{}
    if(code==="invalid_grant") throw new BackupHttpError(410,"invalid_grant");
    if(code==="invalid_client") throw new BackupHttpError(500,"Discord Client Secretが一致しません。メンバー復元を停止しました。");
    if(response.status===429||response.status>=500) throw new BackupHttpError(503,"Discord OAuthが一時的に利用できません");
    throw new BackupHttpError(502,"Discord OAuth "+response.status+": "+text.slice(0,160));
  }
  return JSON.parse(text);
}

async function accessTokenForRecoveryMember(
  env:Env,sourceGuildId:string,row:RecoveryMemberRow
):Promise<string>{
  if(row.token_expires_at>Date.now()+60*60_000){
    return decrypt(env.SESSION_ENCRYPTION_KEY,row.access_token_enc);
  }
  let refreshed;
  try{
    refreshed=await oauthTokenRequest(env,new URLSearchParams({
      grant_type:"refresh_token",
      refresh_token:await decrypt(env.SESSION_ENCRYPTION_KEY,row.refresh_token_enc)
    }));
  }catch(error){
    if(error instanceof BackupHttpError&&error.status===410){
      await markRecoveryMemberRevoked(env,sourceGuildId,row.user_id);
    }
    throw error;
  }
  const accessEnc=await encrypt(env.SESSION_ENCRYPTION_KEY,refreshed.access_token);
  const refreshEnc=await encrypt(env.SESSION_ENCRYPTION_KEY,refreshed.refresh_token);
  const expiresAt=Date.now()+Number(refreshed.expires_in)*1000;
  await rotateRecoveryMember(
    env,sourceGuildId,row.user_id,accessEnc,refreshEnc,expiresAt
  );
  return refreshed.access_token;
}

async function addGuildMember(
  env:Env,targetGuildId:string,userId:string,accessToken:string
):Promise<"added"|"already">{
  const response=await botFetch(env,"/guilds/"+targetGuildId+"/members/"+userId,{
    method:"PUT",body:JSON.stringify({access_token:accessToken})
  });
  if(response.status===201) return "added";
  if(response.status===204) return "already";
  const text=await response.text().catch(()=>"");
  if(response.status===403){
    throw new BackupHttpError(403,"メンバー復元をDiscordが拒否しました。BOTの権限と対象サーバーを確認してください: "+text.slice(0,120));
  }
  if(response.status===429||response.status>=500){
    throw new BackupHttpError(503,"Discord APIが一時的にメンバー追加を受け付けませんでした");
  }
  throw new BackupHttpError(502,"メンバー追加失敗 "+response.status+": "+text.slice(0,120));
}

async function restoreOneMember(
  env:Env,job:RestoreJobRow,snapshot:GuildSnapshot,index:number
):Promise<void>{
  const member=snapshot.members[index];
  if(!member) return;
  const stats=parseStats(job.result_json);
  const roleMap=parseObject<Record<string,string>>(job.role_map_json,{});
  const recovery=await getRecoveryMember(env,snapshot.sourceGuild.id,member.user_id);
  if(!recovery||recovery.revoked_at){
    stats.membersSkippedNoConsent++;
    await updateRestoreJob(env,job.id,{result_json:JSON.stringify(stats)});
    return;
  }

  try{
    const token=await accessTokenForRecoveryMember(env,snapshot.sourceGuild.id,recovery);
    const result=await addGuildMember(env,job.target_guild_id,member.user_id,token);
    if(result==="added") stats.membersAdded++;
    else stats.membersAlreadyPresent++;

    for(const oldRoleId of member.roles){
      const newRoleId=roleMap[oldRoleId];
      if(!newRoleId||newRoleId===job.target_guild_id) continue;
      await botJson(env,
        "/guilds/"+job.target_guild_id+"/members/"+member.user_id+"/roles/"+newRoleId,
        {method:"PUT"}
      ).catch(()=>undefined);
    }
    if(member.nick){
      await botJson(env,"/guilds/"+job.target_guild_id+"/members/"+member.user_id,{
        method:"PATCH",body:JSON.stringify({nick:member.nick})
      }).catch(()=>undefined);
    }
    if(member.communication_disabled_until){
      const timeoutAt=Date.parse(member.communication_disabled_until);
      if(Number.isFinite(timeoutAt)&&timeoutAt>Date.now()){
        try{
          await botJson(env,"/guilds/"+job.target_guild_id+"/members/"+member.user_id,{
            method:"PATCH",
            body:JSON.stringify({communication_disabled_until:member.communication_disabled_until})
          });
          stats.memberTimeoutsRestored++;
        }catch{
          stats.warnings.push("メンバー "+member.user_id+" のタイムアウト状態を復元できませんでした。");
        }
      }
    }
  }catch(error){
    if(error instanceof BackupHttpError&&error.status===410){
      stats.membersRevoked++;
    }else if(error instanceof BackupHttpError&&error.status===403){
      throw error;
    }else{
      stats.membersFailed++;
      stats.warnings.push("メンバー "+member.user_id+" の復元を後で再試行できます。");
    }
  }
  await updateRestoreJob(env,job.id,{result_json:JSON.stringify(stats)});
}

async function processRestoreJob(env:Env,job:RestoreJobRow):Promise<void>{
  const snapshot=await loadSnapshot(env,job.backup_id);

  if(job.phase==="preflight"){
    await botJson(env,"/guilds/"+job.target_guild_id);
    const existing=await botJson<any[]>(env,"/guilds/"+job.target_guild_id+"/channels");
    if(existing.length>8){
      const stats=parseStats(job.result_json);
      stats.warnings.push(
        "復元先には既存チャンネルがあります。削除は行わず、名前・種類・親カテゴリが一致するものを再利用し、不足分だけ追加します。"
      );
      await updateRestoreJob(env,job.id,{result_json:JSON.stringify(stats)});
    }
    await updateRestoreJob(env,job.id,{
      status:"running",phase:"roles",cursor:0,error:null
    });
    return;
  }
  if(job.phase==="roles") return restoreRoleBatch(env,job,snapshot);
  if(job.phase==="categories") return restoreChannelBatch(env,job,snapshot,true);
  if(job.phase==="channels") return restoreChannelBatch(env,job,snapshot,false);
  if(job.phase==="positions") return applyPositionsAndGuild(env,job,snapshot);
  if(job.phase==="guild-extras") return restoreGuildExtras(env,job,snapshot);
  if(job.phase==="bans") return restoreBanBatch(env,job,snapshot);
  if(job.phase==="bot-settings") return restoreBotSettings(env,job,snapshot);
  if(job.phase==="legacy-products") return restoreLegacyProducts(env,job,snapshot);
  if(job.phase==="vending") return restoreVending(env,job,snapshot);
  if(job.phase==="panels") return restorePanels(env,job,snapshot);
  if(job.phase==="members"){
    if(job.cursor>=snapshot.members.length){
      await updateRestoreJob(env,job.id,{
        status:"completed",phase:"done",cursor:snapshot.members.length,error:null
      });
      return;
    }

    let current:RestoreJobRow=job;
    let cursor=job.cursor;
    const stop=Math.min(snapshot.members.length,cursor+10);
    while(cursor<stop){
      await restoreOneMember(env,current,snapshot,cursor);
      cursor++;
      const refreshed=await getRestoreJob(env,job.id);
      if(refreshed) current=refreshed;
      if(cursor<stop){
        await new Promise(resolve=>setTimeout(resolve,900));
      }
    }
    await updateRestoreJob(env,job.id,{cursor,status:"running",error:null});
    return;
  }
  await updateRestoreJob(env,job.id,{
    status:"failed",error:"不明な復元フェーズです: "+job.phase
  });
}

export async function backupRestoreSweep(env:Env):Promise<void>{
  await ensureBackupSchema(env);
  const job=await nextRestoreJob(env);
  if(job){
    try{
      await processRestoreJob(env,job);
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      const fatal=
        error instanceof BackupHttpError&&[400,401,403,404,500].includes(error.status);
      await updateRestoreJob(env,job.id,{
        status:fatal?"failed":"queued",
        error:message.slice(0,500)
      });
    }
    return;
  }

  // With the worker cron running every minute, create at most one stale guild snapshot
  // per tick. Manual snapshots also postpone the next automatic snapshot for 24 hours.
  let guilds:any[]=[];
  try{
    guilds=await botJson<any[]>(env,"/users/@me/guilds?limit=200");
  }catch{
    return;
  }
  for(const guild of guilds){
    const guildId=String(guild.id??"");
    if(!guildId) continue;
    const rows=await listBackupRecords(env,guildId);
    const latest=rows[0];
    if(latest&&Date.now()-latest.created_at<24*60*60_000) continue;
    try{
      await createSnapshot(env,guildId,"自動バックアップ");
      const updated=await listBackupRecords(env,guildId);
      const automatic=updated.filter(row=>row.label==="自動バックアップ");
      for(const stale of automatic.slice(14)){
        await deleteBackupRecord(env,stale.id);
      }
    }catch(error){
      console.error("automatic guild backup failed",guildId,error);
    }
    return;
  }
}

async function restorePreview(env:Env,backupId:string,targetGuildId:string){
  const snapshot=await loadSnapshot(env,backupId);
  const [targetRoles,targetChannels,targetGuild,recoveryCount]=await Promise.all([
    botJson<any[]>(env,"/guilds/"+targetGuildId+"/roles"),
    botJson<any[]>(env,"/guilds/"+targetGuildId+"/channels"),
    botJson<any>(env,"/guilds/"+targetGuildId),
    countRecoveryMembers(env,snapshot.sourceGuild.id)
  ]);
  const editableRoles=snapshot.roles.filter(role=>!role.managed&&role.id!==snapshot.sourceGuild.id);
  const missingRoles=editableRoles.filter(
    role=>!targetRoles.some(item=>!item.managed&&item.name===role.name)
  ).length;
  const missingChannels=snapshot.channels.filter(source=>{
    if(source.type===4){
      return !targetChannels.some(item=>Number(item.type)===4&&item.name===source.name);
    }
    return !targetChannels.some(item=>Number(item.type)===source.type&&item.name===source.name);
  }).length;
  const recoverableMembers=snapshot.members.filter(member=>member.user_id).length;
  return {
    source:{id:snapshot.sourceGuild.id,name:snapshot.sourceGuild.name},
    target:{id:targetGuildId,name:targetGuild.name},
    counts:{
      roles:snapshot.roles.length,
      missingRoles,
      channels:snapshot.channels.length,
      missingChannels,
      members:snapshot.members.length,
      bans:(snapshot.bans??[]).length,
      recoveryRegistered:recoveryCount,
      botPanels:snapshot.bot.panels.length,
      vendingMachines:snapshot.bot.vending.machines.length
    },
    behavior:{
      destructive:false,
      deletesExisting:false,
      reusesMatching:true,
      memberRestoreRequiresPriorConsent:true
    },
    warnings:snapshot.capture.warnings
  };
}

export async function handleBackupApi(
  request:Request,env:Env,url:URL
):Promise<Response|null>{
  await ensureBackupSchema(env);

  if(url.pathname==="/api/backups"&&request.method==="GET"){
    await requireDashboard(request,env);
    const sourceGuildId=url.searchParams.get("sourceGuildId")??undefined;
    return json(env,(await listBackupRecords(env,sourceGuildId)).map(publicBackup));
  }

  const create=url.pathname.match(/^\/api\/guilds\/(\d+)\/backups$/);
  if(create&&request.method==="POST"){
    await requireDashboard(request,env);
    await botJson(env,"/guilds/"+create[1]);
    const body=await request.json().catch(()=>({})) as {label?:string};
    return json(env,await createSnapshot(env,create[1]!,body.label),201);
  }

  const recoveryStatus=url.pathname.match(/^\/api\/guilds\/(\d+)\/recovery\/status$/);
  if(recoveryStatus&&request.method==="GET"){
    await requireDashboard(request,env);
    await botJson(env,"/guilds/"+recoveryStatus[1]);
    return json(env,{
      registered:await countRecoveryMembers(env,recoveryStatus[1]!),
      authorizePath:"/auth/recovery/start?guild_id="+encodeURIComponent(recoveryStatus[1]!),
      redirectPath:"/auth/discord/callback"
    });
  }

  const recoveryPanel=url.pathname.match(/^\/api\/guilds\/(\d+)\/recovery\/panel$/);
  if(recoveryPanel&&request.method==="POST"){
    await requireDashboard(request,env);
    const guildId=recoveryPanel[1]!;
    await botJson(env,"/guilds/"+guildId);
    const body=await request.json() as {channelId?:string};
    const channelId=String(body.channelId??"");
    if(!/^\d+$/.test(channelId)) throw new BackupHttpError(400,"設置先チャンネルが不正です");
    const channel=await botJson<any>(env,"/channels/"+channelId);
    if(String(channel.guild_id??"")!==guildId||![0,5].includes(Number(channel.type))){
      throw new BackupHttpError(400,"復旧登録パネルはこのサーバーのテキストチャンネルに設置してください");
    }
    const message=await postMessage(env,channelId,{
      embeds:[{
        title:"サーバー復旧登録",
        description:"万が一サーバーが失われた時に、Discord公式OAuthを使ってこのアカウントを復旧先へ再参加できるよう登録します。登録はいつでもDiscord側から取り消せます。",
        color:5793266
      }],
      components:[{type:1,components:[{
        type:2,style:5,label:"復旧登録する",
        url:url.origin+"/auth/recovery/start?guild_id="+encodeURIComponent(guildId)
      }]}]
    });
    await recordPanelDeployment(env,{
      guildId,kind:"recovery",channelId,messageId:message.id??null
    });
    return json(env,{ok:true,channelId,messageId:message.id??null});
  }

  const backupMatch=url.pathname.match(/^\/api\/backups\/([^/]+)$/);
  if(backupMatch&&request.method==="GET"){
    await requireDashboard(request,env);
    const row=await getBackupRecord(env,backupMatch[1]!);
    if(!row) throw new BackupHttpError(404,"バックアップが見つかりません");
    return json(env,publicBackup(row));
  }
  if(backupMatch&&request.method==="DELETE"){
    await requireDashboard(request,env);
    if(!(await deleteBackupRecord(env,backupMatch[1]!))){
      throw new BackupHttpError(404,"バックアップが見つかりません");
    }
    return json(env,{ok:true});
  }

  const preview=url.pathname.match(/^\/api\/backups\/([^/]+)\/restore\/preview$/);
  if(preview&&request.method==="POST"){
    await requireDashboard(request,env);
    const body=await request.json() as {targetGuildId?:string};
    const target=String(body.targetGuildId??"");
    if(!/^\d+$/.test(target)) throw new BackupHttpError(400,"復元先サーバーが不正です");
    return json(env,await restorePreview(env,preview[1]!,target));
  }

  const restore=url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
  if(restore&&request.method==="POST"){
    await requireDashboard(request,env);
    const body=await request.json() as {targetGuildId?:string};
    const target=String(body.targetGuildId??"");
    if(!/^\d+$/.test(target)) throw new BackupHttpError(400,"復元先サーバーが不正です");
    await restorePreview(env,restore[1]!,target);
    return json(env,publicJob(await createRestoreJob(env,restore[1]!,target)),202);
  }

  if(url.pathname==="/api/restore-jobs"&&request.method==="GET"){
    await requireDashboard(request,env);
    const targetGuildId=url.searchParams.get("targetGuildId")??undefined;
    return json(env,(await listRestoreJobs(env,targetGuildId)).map(publicJob));
  }

  const jobMatch=url.pathname.match(/^\/api\/restore-jobs\/([^/]+)$/);
  if(jobMatch&&request.method==="GET"){
    await requireDashboard(request,env);
    const row=await getRestoreJob(env,jobMatch[1]!);
    if(!row) throw new BackupHttpError(404,"復元ジョブが見つかりません");
    return json(env,publicJob(row));
  }
  if(jobMatch&&request.method==="DELETE"){
    await requireDashboard(request,env);
    if(!(await cancelRestoreJob(env,jobMatch[1]!))){
      throw new BackupHttpError(409,"この復元ジョブは停止できません");
    }
    return json(env,{ok:true});
  }

  return null;
}

function recoveryAuthorizeUrl(
  env:Env,origin:string,state:string,forceConsent=true
):string{
  const params=new URLSearchParams({
    client_id:env.DISCORD_APPLICATION_ID,
    response_type:"code",
    redirect_uri:origin+"/auth/discord/callback",
    scope:"identify guilds.join",
    state
  });
  if(forceConsent) params.set("prompt","consent");
  return "https://discord.com/oauth2/authorize?"+params.toString();
}

export async function createVerificationRecoveryAuthorizeUrl(
  env:Env,
  origin:string,
  guildId:string,
  userId:string
):Promise<string>{
  if(!/^\d+$/.test(guildId)||!/^\d+$/.test(userId)){
    throw new BackupHttpError(400,"認証情報が不正です");
  }
  const state=randomToken(24);
  await putRecoveryOAuthState(env,state,guildId,{
    expectedUserId:userId,
    purpose:"verification"
  });
  return recoveryAuthorizeUrl(env,origin,state,false);
}

async function grantVerifiedRoleAfterOAuth(
  env:Env,guildId:string,userId:string
):Promise<string>{
  const settings=await getGuildSettings(env,guildId);
  if(!settings.verifiedRoleId){
    throw new BackupHttpError(409,"認証ロールが設定されていません");
  }
  const roles=await botJson<any[]>(env,"/guilds/"+guildId+"/roles");
  const target=roles.find(role=>String(role.id)===settings.verifiedRoleId);
  if(!target||String(target.id)===guildId||target.managed){
    throw new BackupHttpError(
      409,
      "認証ロールが無効です。管理画面で通常ロールを設定し直してください"
    );
  }
  const member=await botJson<any>(env,"/guilds/"+guildId+"/members/"+userId);
  const assigned=Array.isArray(member.roles)&&member.roles.map(String).includes(String(target.id));
  if(!assigned){
    try{
      await botJson(env,"/guilds/"+guildId+"/members/"+userId+"/roles/"+target.id,{
        method:"PUT"
      });
    }catch(error){
      if(error instanceof DiscordApiError&&error.status===403){
        throw new BackupHttpError(
          403,
          "復旧登録は保存できましたが認証ロールを付与できませんでした。BOTのロール管理権限とロール順序を確認してください。"
        );
      }
      throw error;
    }
  }
  return String(target.name??"認証済み");
}

export async function handleRecoveryOAuth(
  request:Request,env:Env,url:URL
):Promise<Response|null>{
  if(url.pathname==="/auth/verification/start"&&request.method==="GET"){
    const guildId=String(url.searchParams.get("guild_id")??"");
    if(!/^\d+$/.test(guildId)) throw new BackupHttpError(400,"サーバーIDが不正です");
    await botJson(env,"/guilds/"+guildId);
    const state=randomToken(24);
    await putRecoveryOAuthState(env,state,guildId,{purpose:"verification"});
    return Response.redirect(recoveryAuthorizeUrl(env,url.origin,state,false),302);
  }

  if(url.pathname==="/auth/recovery/start"&&request.method==="GET"){
    const guildId=String(url.searchParams.get("guild_id")??"");
    if(!/^\d+$/.test(guildId)) throw new BackupHttpError(400,"サーバーIDが不正です");
    await botJson(env,"/guilds/"+guildId);
    const state=randomToken(24);
    await putRecoveryState(env,state,guildId);
    return Response.redirect(recoveryAuthorizeUrl(env,url.origin,state),302);
  }

  if(url.pathname==="/auth/discord/callback"&&request.method==="GET"){
    const code=url.searchParams.get("code");
    const state=url.searchParams.get("state");
    if(!code||!state) return null;
    const recoveryState=await consumeRecoveryOAuthState(env,state);
    if(!recoveryState) return null;
    const guildId=recoveryState.guildId;

    const tokens=await oauthTokenRequest(env,new URLSearchParams({
      grant_type:"authorization_code",
      code,
      redirect_uri:url.origin+"/auth/discord/callback"
    }));
    const userResponse=await fetch("https://discord.com/api/v10/users/@me",{
      headers:{Authorization:"Bearer "+tokens.access_token}
    });
    if(!userResponse.ok) throw new BackupHttpError(502,"Discordユーザー情報を取得できませんでした");
    const user=await userResponse.json() as any;
    const userId=String(user.id??"");
    if(recoveryState.expectedUserId&&userId!==recoveryState.expectedUserId){
      throw new BackupHttpError(
        403,
        "Discord認証に使ったアカウントが、認証ボタンを押したアカウントと一致しません。元のアカウントでやり直してください。"
      );
    }

    if(recoveryState.purpose==="verification"){
      const settings=await getGuildSettings(env,guildId);
      if(!settings.verifiedRoleId){
        throw new BackupHttpError(409,"認証ロールが設定されていません");
      }
      const minAccountAgeDays=Math.max(
        0,
        Math.min(36500,Math.trunc(Number(settings.minAccountAgeDays)||0))
      );
      if(Date.now()-accountCreatedAt(userId)<minAccountAgeDays*86400000){
        throw new BackupHttpError(
          403,
          "このサーバーの認証条件を満たしていません。アカウント作成から"+
          minAccountAgeDays+"日以上必要です。"
        );
      }
    }

    try{
      await botJson(env,"/guilds/"+guildId+"/members/"+user.id);
    }catch(error){
      if(error instanceof DiscordApiError&&error.status===404){
        throw new BackupHttpError(403,"この復旧登録は現在サーバーに参加しているメンバーだけ利用できます");
      }
      throw error;
    }

    await upsertRecoveryMember(env,{
      guildId,
      userId,
      username:String(user.global_name||user.username||user.id),
      accessTokenEnc:await encrypt(env.SESSION_ENCRYPTION_KEY,tokens.access_token),
      refreshTokenEnc:await encrypt(env.SESSION_ENCRYPTION_KEY,tokens.refresh_token),
      tokenExpiresAt:Date.now()+Number(tokens.expires_in)*1000
    });

    let title="復旧登録完了";
    let heading="復旧登録が完了しました";
    let detail="このサーバーが失われた場合、管理者が復元を開始するとDiscordの公式OAuth権限を使って再参加できます。";
    if(recoveryState.purpose==="verification"){
      const roleName=await grantVerifiedRoleAfterOAuth(env,guildId,userId);
      title="認証完了";
      heading="認証が完了しました";
      detail="認証ロール @"+roleName+" を付与し、同時にサーバー復旧対象メンバーとして登録しました。";
    }

    return new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"+
      "<title>"+title+"</title><body style='font-family:system-ui;background:#070b14;color:#eef3ff;padding:40px'>"+
      "<main style='max-width:560px;margin:auto;background:#10172a;border:1px solid #202943;border-radius:20px;padding:28px'>"+
      "<h1>"+heading+"</h1><p>"+detail+"</p>"+
      "<p>このページは閉じて大丈夫です。</p></main></body>",
      {headers:{"Content-Type":"text/html; charset=utf-8"}}
    );
  }

  return null;
}
