import type { Env } from "./types";

// ---- 取引ステータス ---------------------------------------------------------
export const FEE="FEE";                           // 仲介費の負担者選択・支払い待ち
export const FEE_RECEIVING="FEE_RECEIVING";       // 仲介費の受け取り処理中 / スタッフ確認待ち
export const AMOUNT="AMOUNT";                     // 金額合意待ち
export const ROLE="ROLE";                         // 役割選択待ち
export const PAYMENT="PAYMENT";                   // 送金リンク提出待ち
export const CONFIRMING="CONFIRMING";             // 受け取り処理中 / スタッフ確認待ち
export const TRADING="TRADING";                   // 受け渡し中（チャット解放）
export const COMPLETE_PENDING="COMPLETE_PENDING"; // 片方が完了を申請、もう片方の同意待ち
export const DISPUTE="DISPUTE";                   // 通報・凍結中
export const PAYOUT="PAYOUT";                     // 支払い処理中 / スタッフの手動送金待ち
export const PAID="PAID";                         // 支払いリンク発行済み（受取人の受け取り待ち）
export const CLOSED="CLOSED";
export const CANCELLED="CANCELLED";

export const ACTIVE_STATUSES=[FEE,FEE_RECEIVING,AMOUNT,ROLE,PAYMENT,CONFIRMING,TRADING,COMPLETE_PENDING,DISPUTE,PAYOUT,PAID];

export type MediationSettings={
  panelChannelId:string|null;
  panelMessageId:string|null;
  panelTitle:string;
  panelDescription:string;
  feeAmount:number;
  staffRoleIds:string[];
  staffChannelId:string|null;
  categoryId:string|null;
  resultChannelId:string|null;
  resultChannelBase:string;
  resultRenameEnabled:boolean;
  resultPostEnabled:boolean;
  logChannelId:string|null;
  blacklistRoleIds:string[];
  minAccountAgeDays:number;
  minMemberDays:number;
  minAmount:number;
  maxAmount:number;
  autoAgreeHours:number;
  maxOpenTrades:number;
  cancelDeleteSeconds:number;
  closeDeleteMinutes:number;
};

export const DEFAULT_MEDIATION_SETTINGS:MediationSettings={
  panelChannelId:null,
  panelMessageId:null,
  panelTitle:"取引仲介",
  panelDescription:"下のボタンから取引を開始できます。運営が代金を預かり、両者が合意したら売り手へ支払います。",
  feeAmount:200,
  staffRoleIds:[],
  staffChannelId:null,
  categoryId:null,
  resultChannelId:null,
  resultChannelBase:"仲介実績",
  resultRenameEnabled:true,
  resultPostEnabled:true,
  logChannelId:null,
  blacklistRoleIds:[],
  minAccountAgeDays:0,
  minMemberDays:0,
  minAmount:1,
  maxAmount:0,
  autoAgreeHours:24,
  maxOpenTrades:3,
  cancelDeleteSeconds:30,
  closeDeleteMinutes:10
};

const SNOWFLAKE=/^\d{15,22}$/;

function snowflakeOrNull(value:unknown):string|null{
  const v=String(value??"").trim();
  return SNOWFLAKE.test(v)?v:null;
}

function snowflakeList(value:unknown):string[]{
  if(!Array.isArray(value)) return [];
  return [...new Set(value.map(v=>String(v).trim()).filter(v=>SNOWFLAKE.test(v)))].slice(0,25);
}

function clampInt(value:unknown,min:number,max:number,fallback:number):number{
  const n=Number(value);
  if(!Number.isFinite(n)) return fallback;
  return Math.min(max,Math.max(min,Math.trunc(n)));
}

function clampNum(value:unknown,min:number,max:number,fallback:number):number{
  const n=Number(value);
  if(!Number.isFinite(n)) return fallback;
  return Math.min(max,Math.max(min,n));
}

function text(value:unknown,max:number,fallback:string):string{
  if(typeof value!=="string") return fallback;
  return value.trim().slice(0,max);
}

export function normalizeMediationSettings(raw:any,base:MediationSettings=DEFAULT_MEDIATION_SETTINGS):MediationSettings{
  const r=raw&&typeof raw==="object"?raw:{};
  const has=(k:string)=>Object.prototype.hasOwnProperty.call(r,k);
  const s:MediationSettings={
    panelChannelId:has("panelChannelId")?snowflakeOrNull(r.panelChannelId):base.panelChannelId,
    panelMessageId:has("panelMessageId")?snowflakeOrNull(r.panelMessageId):base.panelMessageId,
    panelTitle:has("panelTitle")?(text(r.panelTitle,256,base.panelTitle)||DEFAULT_MEDIATION_SETTINGS.panelTitle):base.panelTitle,
    panelDescription:has("panelDescription")?text(r.panelDescription,3000,base.panelDescription):base.panelDescription,
    feeAmount:has("feeAmount")?clampInt(r.feeAmount,0,1_000_000,base.feeAmount):base.feeAmount,
    staffRoleIds:has("staffRoleIds")?snowflakeList(r.staffRoleIds):base.staffRoleIds,
    staffChannelId:has("staffChannelId")?snowflakeOrNull(r.staffChannelId):base.staffChannelId,
    categoryId:has("categoryId")?snowflakeOrNull(r.categoryId):base.categoryId,
    resultChannelId:has("resultChannelId")?snowflakeOrNull(r.resultChannelId):base.resultChannelId,
    resultChannelBase:has("resultChannelBase")?(text(r.resultChannelBase,60,base.resultChannelBase)||DEFAULT_MEDIATION_SETTINGS.resultChannelBase):base.resultChannelBase,
    resultRenameEnabled:has("resultRenameEnabled")?Boolean(r.resultRenameEnabled):base.resultRenameEnabled,
    resultPostEnabled:has("resultPostEnabled")?Boolean(r.resultPostEnabled):base.resultPostEnabled,
    logChannelId:has("logChannelId")?snowflakeOrNull(r.logChannelId):base.logChannelId,
    blacklistRoleIds:has("blacklistRoleIds")?snowflakeList(r.blacklistRoleIds):base.blacklistRoleIds,
    minAccountAgeDays:has("minAccountAgeDays")?clampInt(r.minAccountAgeDays,0,3650,base.minAccountAgeDays):base.minAccountAgeDays,
    minMemberDays:has("minMemberDays")?clampInt(r.minMemberDays,0,3650,base.minMemberDays):base.minMemberDays,
    minAmount:has("minAmount")?clampInt(r.minAmount,1,10_000_000,base.minAmount):base.minAmount,
    maxAmount:has("maxAmount")?clampInt(r.maxAmount,0,10_000_000,base.maxAmount):base.maxAmount,
    autoAgreeHours:has("autoAgreeHours")?clampNum(r.autoAgreeHours,0,720,base.autoAgreeHours):base.autoAgreeHours,
    maxOpenTrades:has("maxOpenTrades")?clampInt(r.maxOpenTrades,0,50,base.maxOpenTrades):base.maxOpenTrades,
    cancelDeleteSeconds:has("cancelDeleteSeconds")?clampInt(r.cancelDeleteSeconds,0,86_400,base.cancelDeleteSeconds):base.cancelDeleteSeconds,
    closeDeleteMinutes:has("closeDeleteMinutes")?clampInt(r.closeDeleteMinutes,1,10_080,base.closeDeleteMinutes):base.closeDeleteMinutes
  };
  if(s.maxAmount>0&&s.maxAmount<s.minAmount) s.maxAmount=s.minAmount;
  return s;
}

export type Trade={
  id:number;
  guild_id:string;
  number:number;
  channel_id:string|null;
  user_a:string;
  user_b:string;
  fee_total:number;
  fee_choice_a:string|null;
  fee_choice_b:string|null;
  fee_link_a_enc:string|null;
  fee_pass_a_enc:string|null;
  fee_link_b_enc:string|null;
  fee_pass_b_enc:string|null;
  fee_paid_a:number|null;
  fee_paid_b:number|null;
  amount_a:number|null;
  amount_b:number|null;
  amount:number|null;
  role_a:string|null;
  role_b:string|null;
  buyer_id:string|null;
  seller_id:string|null;
  paylink_enc:string|null;
  passcode_enc:string|null;
  complete_requester:string|null;
  complete_requested_at:number|null;
  report_by:string|null;
  report_reason:string|null;
  decision:string|null;
  payout_target:string|null;
  payout_amount:number|null;
  payout_link_enc:string|null;
  status:string;
  delete_at:number|null;
  channel_deleted:number;
  transcript_saved:number;
  created_at:number;
  updated_at:number;
};

const schema=[
  "CREATE TABLE IF NOT EXISTS mediation_settings (guild_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL,result_dirty INTEGER NOT NULL DEFAULT 1,result_renamed_at INTEGER NOT NULL DEFAULT 0,result_renamed_name TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mediation_trades (id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,number INTEGER NOT NULL,channel_id TEXT,user_a TEXT NOT NULL,user_b TEXT NOT NULL,fee_total INTEGER NOT NULL DEFAULT 0,fee_choice_a TEXT,fee_choice_b TEXT,fee_link_a_enc TEXT,fee_pass_a_enc TEXT,fee_link_b_enc TEXT,fee_pass_b_enc TEXT,fee_paid_a INTEGER,fee_paid_b INTEGER,amount_a INTEGER,amount_b INTEGER,amount INTEGER,role_a TEXT,role_b TEXT,buyer_id TEXT,seller_id TEXT,paylink_enc TEXT,passcode_enc TEXT,complete_requester TEXT,complete_requested_at INTEGER,report_by TEXT,report_reason TEXT,decision TEXT,payout_target TEXT,payout_amount INTEGER,payout_link_enc TEXT,status TEXT NOT NULL,delete_at INTEGER,channel_deleted INTEGER NOT NULL DEFAULT 0,transcript_saved INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS mediation_trades_channel_idx ON mediation_trades(channel_id)",
  "CREATE INDEX IF NOT EXISTS mediation_trades_guild_idx ON mediation_trades(guild_id,status,created_at)",
  "CREATE INDEX IF NOT EXISTS mediation_trades_delete_idx ON mediation_trades(channel_deleted,delete_at)",
  "CREATE TABLE IF NOT EXISTS mediation_stats (guild_id TEXT NOT NULL,user_id TEXT NOT NULL,buyer_count INTEGER NOT NULL DEFAULT 0,seller_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guild_id,user_id))"
];

let ready=false;
export async function ensureMediationSchema(env:Env){
  if(ready) return;
  for(const sql of schema) await env.DB.prepare(sql).run();
  ready=true;
}

export async function getMediationSettings(env:Env,guildId:string):Promise<MediationSettings>{
  const row=await env.DB.prepare("SELECT settings_json FROM mediation_settings WHERE guild_id=?").bind(guildId).first<{settings_json:string}>();
  if(!row) return {...DEFAULT_MEDIATION_SETTINGS};
  try{ return normalizeMediationSettings(JSON.parse(row.settings_json)); }
  catch{ return {...DEFAULT_MEDIATION_SETTINGS}; }
}

export async function saveMediationSettings(env:Env,guildId:string,settings:MediationSettings){
  await env.DB.prepare("INSERT INTO mediation_settings(guild_id,settings_json,result_dirty,updated_at) VALUES (?,?,1,?) ON CONFLICT(guild_id) DO UPDATE SET settings_json=excluded.settings_json,result_dirty=1,updated_at=excluded.updated_at")
    .bind(guildId,JSON.stringify(settings),Date.now()).run();
}

export async function markResultDirty(env:Env,guildId:string){
  await env.DB.prepare("UPDATE mediation_settings SET result_dirty=1 WHERE guild_id=?").bind(guildId).run();
}

export async function listDirtyResultGuilds(env:Env){
  return (await env.DB.prepare("SELECT guild_id,settings_json,result_renamed_at,result_renamed_name FROM mediation_settings WHERE result_dirty=1 LIMIT 10")
    .all<{guild_id:string;settings_json:string;result_renamed_at:number;result_renamed_name:string|null}>()).results;
}

export async function setResultRenameState(env:Env,guildId:string,state:{dirty:boolean;renamedAt?:number;name?:string|null}){
  if(state.renamedAt!==undefined){
    await env.DB.prepare("UPDATE mediation_settings SET result_dirty=?,result_renamed_at=?,result_renamed_name=? WHERE guild_id=?")
      .bind(state.dirty?1:0,state.renamedAt,state.name??null,guildId).run();
  }else{
    await env.DB.prepare("UPDATE mediation_settings SET result_dirty=? WHERE guild_id=?").bind(state.dirty?1:0,guildId).run();
  }
}

export async function createTrade(env:Env,guildId:string,userA:string,userB:string,feeTotal:number,status:string):Promise<Trade>{
  const now=Date.now();
  const row=await env.DB.prepare(
    "INSERT INTO mediation_trades(guild_id,number,user_a,user_b,fee_total,status,created_at,updated_at) SELECT ?,COALESCE(MAX(number),0)+1,?,?,?,?,?,? FROM mediation_trades WHERE guild_id=? RETURNING *"
  ).bind(guildId,userA,userB,feeTotal,status,now,now,guildId).first<Trade>();
  if(!row) throw new Error("trade insert failed");
  return row;
}

export async function getTrade(env:Env,id:number):Promise<Trade|null>{
  return env.DB.prepare("SELECT * FROM mediation_trades WHERE id=?").bind(id).first<Trade>();
}

export async function tradeByChannel(env:Env,channelId:string):Promise<Trade|null>{
  return env.DB.prepare("SELECT * FROM mediation_trades WHERE channel_id=? ORDER BY id DESC LIMIT 1").bind(channelId).first<Trade>();
}

const UPDATABLE=new Set([
  "channel_id","fee_choice_a","fee_choice_b","fee_link_a_enc","fee_pass_a_enc","fee_link_b_enc","fee_pass_b_enc",
  "fee_paid_a","fee_paid_b","amount_a","amount_b","amount","role_a","role_b","buyer_id","seller_id","paylink_enc",
  "passcode_enc","complete_requester","complete_requested_at","report_by","report_reason","decision","payout_target",
  "payout_amount","payout_link_enc","status","delete_at","channel_deleted","transcript_saved"
]);

export async function updateTrade(env:Env,id:number,fields:Partial<Trade>){
  const keys=Object.keys(fields).filter(k=>UPDATABLE.has(k));
  if(!keys.length) return;
  const values=keys.map(k=>(fields as any)[k]??null);
  await env.DB.prepare(`UPDATE mediation_trades SET ${keys.map(k=>k+"=?").join(",")},updated_at=? WHERE id=?`)
    .bind(...values,Date.now(),id).run();
}

/** ステータスが from のどれかなら to に変える（二重押し対策）。変えられたら true */
export async function transition(env:Env,id:number,from:string[],to:string,fields:Partial<Trade>={}):Promise<boolean>{
  const keys=Object.keys(fields).filter(k=>UPDATABLE.has(k)&&k!=="status");
  const values=keys.map(k=>(fields as any)[k]??null);
  const sets=["status=?",...keys.map(k=>k+"=?"),"updated_at=?"].join(",");
  const result=await env.DB.prepare(
    `UPDATE mediation_trades SET ${sets} WHERE id=? AND status IN (${from.map(()=>"?").join(",")})`
  ).bind(to,...values,Date.now(),id,...from).run();
  return (result.meta?.changes??0)===1;
}

export async function countOpenTrades(env:Env,guildId:string,userId:string):Promise<number>{
  const row=await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM mediation_trades WHERE guild_id=? AND (user_a=? OR user_b=?) AND status IN (${ACTIVE_STATUSES.map(()=>"?").join(",")})`
  ).bind(guildId,userId,userId,...ACTIVE_STATUSES).first<{n:number}>();
  return Number(row?.n??0);
}

export async function addRecord(env:Env,guildId:string,buyerId:string,sellerId:string){
  await env.DB.batch([
    env.DB.prepare("INSERT INTO mediation_stats(guild_id,user_id,buyer_count) VALUES (?,?,1) ON CONFLICT(guild_id,user_id) DO UPDATE SET buyer_count=buyer_count+1").bind(guildId,buyerId),
    env.DB.prepare("INSERT INTO mediation_stats(guild_id,user_id,seller_count) VALUES (?,?,1) ON CONFLICT(guild_id,user_id) DO UPDATE SET seller_count=seller_count+1").bind(guildId,sellerId)
  ]);
}

export async function getStats(env:Env,guildId:string,userId:string):Promise<{buyer:number;seller:number}>{
  const row=await env.DB.prepare("SELECT buyer_count,seller_count FROM mediation_stats WHERE guild_id=? AND user_id=?").bind(guildId,userId).first<{buyer_count:number;seller_count:number}>();
  return {buyer:row?.buyer_count??0,seller:row?.seller_count??0};
}

/** 両者合意で正常に完了した取引の総数（運営の実績） */
export async function completedCount(env:Env,guildId:string):Promise<number>{
  const row=await env.DB.prepare("SELECT COUNT(*) AS n FROM mediation_trades WHERE guild_id=? AND decision IN ('両者合意','自動同意')").bind(guildId).first<{n:number}>();
  return Number(row?.n??0);
}

export async function guildSummary(env:Env,guildId:string){
  const rows=(await env.DB.prepare("SELECT status,COUNT(*) AS n,COALESCE(SUM(amount),0) AS total FROM mediation_trades WHERE guild_id=? GROUP BY status").bind(guildId).all<{status:string;n:number;total:number}>()).results;
  const byStatus:Record<string,number>={};
  for(const r of rows) byStatus[r.status]=Number(r.n);
  const fee=await env.DB.prepare("SELECT COALESCE(SUM(COALESCE(fee_paid_a,0)+COALESCE(fee_paid_b,0)),0) AS fee FROM mediation_trades WHERE guild_id=?").bind(guildId).first<{fee:number}>();
  const volume=await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM mediation_trades WHERE guild_id=? AND decision IN ('両者合意','自動同意')").bind(guildId).first<{v:number}>();
  return {
    completed:await completedCount(env,guildId),
    active:ACTIVE_STATUSES.reduce((sum,s)=>sum+(byStatus[s]??0),0),
    disputes:byStatus[DISPUTE]??0,
    manualPayouts:byStatus[PAYOUT]??0,
    cancelled:byStatus[CANCELLED]??0,
    feeCollected:Number(fee?.fee??0),
    volume:Number(volume?.v??0)
  };
}

export async function listRecentTrades(env:Env,guildId:string,limit=30){
  return (await env.DB.prepare(
    "SELECT id,number,channel_id,user_a,user_b,buyer_id,seller_id,amount,fee_total,status,decision,report_reason,created_at,updated_at,channel_deleted FROM mediation_trades WHERE guild_id=? ORDER BY id DESC LIMIT ?"
  ).bind(guildId,limit).all()).results;
}

export async function listAutoAgreeCandidates(env:Env){
  return (await env.DB.prepare("SELECT * FROM mediation_trades WHERE status=? AND complete_requested_at IS NOT NULL ORDER BY complete_requested_at ASC LIMIT 25").bind(COMPLETE_PENDING).all<Trade>()).results;
}

export async function listDueDeletions(env:Env,now:number){
  return (await env.DB.prepare("SELECT * FROM mediation_trades WHERE channel_deleted=0 AND channel_id IS NOT NULL AND delete_at IS NOT NULL AND delete_at<=? ORDER BY delete_at ASC LIMIT 5").bind(now).all<Trade>()).results;
}
