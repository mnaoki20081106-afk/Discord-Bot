import type { Env } from "./types";
import { randomId } from "./utils";

export type BackupRow = {
  id:string;
  source_guild_id:string;
  source_guild_name:string;
  label:string|null;
  created_at:number;
  schema_version:number;
  payload_enc:string;
  role_count:number;
  channel_count:number;
  member_count:number;
  recovery_member_count:number;
  warnings_json:string;
};

export type RestoreJobRow = {
  id:string;
  backup_id:string;
  target_guild_id:string;
  status:"queued"|"running"|"completed"|"failed"|"cancelled";
  phase:string;
  cursor:number;
  role_map_json:string;
  channel_map_json:string;
  vm_map_json:string;
  product_map_json:string;
  result_json:string;
  error:string|null;
  created_at:number;
  updated_at:number;
};

export type RecoveryMemberRow = {
  guild_id:string;
  user_id:string;
  username:string;
  access_token_enc:string;
  refresh_token_enc:string;
  token_expires_at:number;
  revoked_at:number|null;
  created_at:number;
  updated_at:number;
};

export type PanelDeploymentRow = {
  guild_id:string;
  kind:string;
  object_id:string;
  channel_id:string;
  message_id:string|null;
  created_at:number;
  updated_at:number;
};

const schema = [
  `CREATE TABLE IF NOT EXISTS guild_backups (
    id TEXT PRIMARY KEY,
    source_guild_id TEXT NOT NULL,
    source_guild_name TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    payload_enc TEXT NOT NULL,
    role_count INTEGER NOT NULL DEFAULT 0,
    channel_count INTEGER NOT NULL DEFAULT 0,
    member_count INTEGER NOT NULL DEFAULT 0,
    recovery_member_count INTEGER NOT NULL DEFAULT 0,
    warnings_json TEXT NOT NULL DEFAULT '[]'
  )`,
  "CREATE INDEX IF NOT EXISTS guild_backups_source_idx ON guild_backups(source_guild_id,created_at DESC)",
  `CREATE TABLE IF NOT EXISTS guild_backup_chunks (
    backup_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    payload_chunk TEXT NOT NULL,
    PRIMARY KEY(backup_id,chunk_index)
  )`,
  "CREATE INDEX IF NOT EXISTS guild_backup_chunks_backup_idx ON guild_backup_chunks(backup_id,chunk_index)",
  `CREATE TABLE IF NOT EXISTS guild_restore_jobs (
    id TEXT PRIMARY KEY,
    backup_id TEXT NOT NULL,
    target_guild_id TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,
    role_map_json TEXT NOT NULL DEFAULT '{}',
    channel_map_json TEXT NOT NULL DEFAULT '{}',
    vm_map_json TEXT NOT NULL DEFAULT '{}',
    product_map_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS guild_restore_jobs_status_idx ON guild_restore_jobs(status,updated_at)",
  `CREATE TABLE IF NOT EXISTS member_recovery_states (
    state TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS member_recovery_tokens (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    token_expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(guild_id,user_id)
  )`,
  "CREATE INDEX IF NOT EXISTS member_recovery_tokens_guild_idx ON member_recovery_tokens(guild_id,revoked_at)",
  `CREATE TABLE IF NOT EXISTS panel_deployments (
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    object_id TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(guild_id,kind,object_id)
  )`
];

const initializations = new WeakMap<D1Database,Promise<void>>();

export async function ensureBackupSchema(env:Env):Promise<void>{
  let pending=initializations.get(env.DB);
  if(!pending){
    pending=(async()=>{
      for(const sql of schema) await env.DB.prepare(sql).run();
    })();
    initializations.set(env.DB,pending);
    pending.catch(()=>initializations.delete(env.DB));
  }
  await pending;
}

export async function createBackupRecord(
  env:Env,
  input:{
    sourceGuildId:string;
    sourceGuildName:string;
    label?:string|null;
    payloadEnc:string;
    roleCount:number;
    channelCount:number;
    memberCount:number;
    recoveryMemberCount:number;
    warnings:string[];
  }
):Promise<BackupRow>{
  await ensureBackupSchema(env);
  const id=randomId();
  const now=Date.now();
  const marker="chunked:v1";
  await env.DB.prepare(`
    INSERT INTO guild_backups(
      id,source_guild_id,source_guild_name,label,created_at,schema_version,payload_enc,
      role_count,channel_count,member_count,recovery_member_count,warnings_json
    ) VALUES (?,?,?,?,?,1,?,?,?,?,?,?)
  `).bind(
    id,input.sourceGuildId,input.sourceGuildName,input.label??null,now,marker,
    input.roleCount,input.channelCount,input.memberCount,input.recoveryMemberCount,
    JSON.stringify(input.warnings)
  ).run();

  try{
    const chunkSize=120_000;
    for(let offset=0,index=0;offset<input.payloadEnc.length;offset+=chunkSize,index++){
      await env.DB.prepare(
        "INSERT INTO guild_backup_chunks(backup_id,chunk_index,payload_chunk) VALUES (?,?,?)"
      ).bind(id,index,input.payloadEnc.slice(offset,offset+chunkSize)).run();
    }
  }catch(error){
    await env.DB.prepare("DELETE FROM guild_backup_chunks WHERE backup_id=?").bind(id).run().catch(()=>undefined);
    await env.DB.prepare("DELETE FROM guild_backups WHERE id=?").bind(id).run().catch(()=>undefined);
    throw error;
  }

  return (await getBackupRecord(env,id))!;
}

export async function getBackupPayload(env:Env,row:BackupRow):Promise<string>{
  await ensureBackupSchema(env);
  if(row.payload_enc!=="chunked:v1") return row.payload_enc;
  const chunks=(await env.DB.prepare(
    "SELECT payload_chunk FROM guild_backup_chunks WHERE backup_id=? ORDER BY chunk_index ASC"
  ).bind(row.id).all<{payload_chunk:string}>()).results;
  if(!chunks.length) throw new Error("Backup payload chunks are missing");
  return chunks.map(chunk=>chunk.payload_chunk).join("");
}

export async function listBackupRecords(env:Env,guildId?:string):Promise<BackupRow[]>{
  await ensureBackupSchema(env);
  if(guildId){
    return (await env.DB.prepare(
      "SELECT * FROM guild_backups WHERE source_guild_id=? ORDER BY created_at DESC LIMIT 100"
    ).bind(guildId).all<BackupRow>()).results;
  }
  return (await env.DB.prepare(
    "SELECT * FROM guild_backups ORDER BY created_at DESC LIMIT 200"
  ).all<BackupRow>()).results;
}

export async function getBackupRecord(env:Env,id:string):Promise<BackupRow|null>{
  await ensureBackupSchema(env);
  return await env.DB.prepare("SELECT * FROM guild_backups WHERE id=?")
    .bind(id).first<BackupRow>()??null;
}

export async function deleteBackupRecord(env:Env,id:string):Promise<boolean>{
  await ensureBackupSchema(env);
  await env.DB.prepare("DELETE FROM guild_backup_chunks WHERE backup_id=?").bind(id).run();
  const result=await env.DB.prepare("DELETE FROM guild_backups WHERE id=?").bind(id).run();
  return (result.meta.changes??0)>0;
}

export async function putRecoveryState(env:Env,state:string,guildId:string):Promise<void>{
  await ensureBackupSchema(env);
  await env.DB.prepare(
    "INSERT INTO member_recovery_states(state,guild_id,expires_at) VALUES (?,?,?)"
  ).bind(state,guildId,Date.now()+10*60_000).run();
}

export async function consumeRecoveryState(env:Env,state:string):Promise<string|null>{
  await ensureBackupSchema(env);
  const row=await env.DB.prepare(
    "SELECT guild_id FROM member_recovery_states WHERE state=? AND expires_at>?"
  ).bind(state,Date.now()).first<{guild_id:string}>();
  if(!row) return null;
  await env.DB.prepare("DELETE FROM member_recovery_states WHERE state=?").bind(state).run();
  return row.guild_id;
}

export async function upsertRecoveryMember(
  env:Env,
  row:{
    guildId:string;
    userId:string;
    username:string;
    accessTokenEnc:string;
    refreshTokenEnc:string;
    tokenExpiresAt:number;
  }
):Promise<void>{
  await ensureBackupSchema(env);
  const now=Date.now();
  await env.DB.prepare(`
    INSERT INTO member_recovery_tokens(
      guild_id,user_id,username,access_token_enc,refresh_token_enc,token_expires_at,
      revoked_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,NULL,?,?)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET
      username=excluded.username,
      access_token_enc=excluded.access_token_enc,
      refresh_token_enc=excluded.refresh_token_enc,
      token_expires_at=excluded.token_expires_at,
      revoked_at=NULL,
      updated_at=excluded.updated_at
  `).bind(
    row.guildId,row.userId,row.username,row.accessTokenEnc,row.refreshTokenEnc,
    row.tokenExpiresAt,now,now
  ).run();
}

export async function getRecoveryMember(
  env:Env,guildId:string,userId:string
):Promise<RecoveryMemberRow|null>{
  await ensureBackupSchema(env);
  return await env.DB.prepare(
    "SELECT * FROM member_recovery_tokens WHERE guild_id=? AND user_id=?"
  ).bind(guildId,userId).first<RecoveryMemberRow>()??null;
}

export async function listRecoveryMembers(
  env:Env,guildId:string,afterUserId?:string,limit=25
):Promise<RecoveryMemberRow[]>{
  await ensureBackupSchema(env);
  if(afterUserId){
    return (await env.DB.prepare(`
      SELECT * FROM member_recovery_tokens
      WHERE guild_id=? AND revoked_at IS NULL AND user_id>?
      ORDER BY user_id ASC LIMIT ?
    `).bind(guildId,afterUserId,limit).all<RecoveryMemberRow>()).results;
  }
  return (await env.DB.prepare(`
    SELECT * FROM member_recovery_tokens
    WHERE guild_id=? AND revoked_at IS NULL
    ORDER BY user_id ASC LIMIT ?
  `).bind(guildId,limit).all<RecoveryMemberRow>()).results;
}

export async function countRecoveryMembers(env:Env,guildId:string):Promise<number>{
  await ensureBackupSchema(env);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM member_recovery_tokens WHERE guild_id=? AND revoked_at IS NULL"
  ).bind(guildId).first<{count:number}>();
  return Number(row?.count??0);
}

export async function rotateRecoveryMember(
  env:Env,
  guildId:string,
  userId:string,
  accessTokenEnc:string,
  refreshTokenEnc:string,
  tokenExpiresAt:number
):Promise<void>{
  await ensureBackupSchema(env);
  await env.DB.prepare(`
    UPDATE member_recovery_tokens SET
      access_token_enc=?,refresh_token_enc=?,token_expires_at=?,revoked_at=NULL,updated_at=?
    WHERE guild_id=? AND user_id=?
  `).bind(
    accessTokenEnc,refreshTokenEnc,tokenExpiresAt,Date.now(),guildId,userId
  ).run();
}

export async function markRecoveryMemberRevoked(
  env:Env,guildId:string,userId:string
):Promise<void>{
  await ensureBackupSchema(env);
  await env.DB.prepare(
    "UPDATE member_recovery_tokens SET revoked_at=?,updated_at=? WHERE guild_id=? AND user_id=?"
  ).bind(Date.now(),Date.now(),guildId,userId).run();
}

export async function createRestoreJob(
  env:Env,backupId:string,targetGuildId:string
):Promise<RestoreJobRow>{
  await ensureBackupSchema(env);
  const existing=await env.DB.prepare(`
    SELECT * FROM guild_restore_jobs
    WHERE target_guild_id=? AND status IN ('queued','running')
    ORDER BY created_at DESC LIMIT 1
  `).bind(targetGuildId).first<RestoreJobRow>();
  if(existing) return existing;

  const id=randomId(),now=Date.now();
  await env.DB.prepare(`
    INSERT INTO guild_restore_jobs(
      id,backup_id,target_guild_id,status,phase,cursor,role_map_json,channel_map_json,
      vm_map_json,product_map_json,result_json,error,created_at,updated_at
    ) VALUES (?,?,?,'queued','preflight',0,'{}','{}','{}','{}','{}',NULL,?,?)
  `).bind(id,backupId,targetGuildId,now,now).run();
  return (await getRestoreJob(env,id))!;
}

export async function getRestoreJob(env:Env,id:string):Promise<RestoreJobRow|null>{
  await ensureBackupSchema(env);
  return await env.DB.prepare("SELECT * FROM guild_restore_jobs WHERE id=?")
    .bind(id).first<RestoreJobRow>()??null;
}

export async function listRestoreJobs(env:Env,targetGuildId?:string):Promise<RestoreJobRow[]>{
  await ensureBackupSchema(env);
  if(targetGuildId){
    return (await env.DB.prepare(
      "SELECT * FROM guild_restore_jobs WHERE target_guild_id=? ORDER BY created_at DESC LIMIT 20"
    ).bind(targetGuildId).all<RestoreJobRow>()).results;
  }
  return (await env.DB.prepare(
    "SELECT * FROM guild_restore_jobs ORDER BY created_at DESC LIMIT 50"
  ).all<RestoreJobRow>()).results;
}

export async function nextRestoreJob(env:Env):Promise<RestoreJobRow|null>{
  await ensureBackupSchema(env);
  return await env.DB.prepare(`
    SELECT * FROM guild_restore_jobs
    WHERE status IN ('queued','running')
    ORDER BY created_at ASC LIMIT 1
  `).first<RestoreJobRow>()??null;
}

export async function updateRestoreJob(
  env:Env,
  id:string,
  patch:Partial<Pick<
    RestoreJobRow,
    "status"|"phase"|"cursor"|"role_map_json"|"channel_map_json"|
    "vm_map_json"|"product_map_json"|"result_json"|"error"
  >>
):Promise<void>{
  await ensureBackupSchema(env);
  const current=await getRestoreJob(env,id);
  if(!current) return;
  await env.DB.prepare(`
    UPDATE guild_restore_jobs SET
      status=?,phase=?,cursor=?,role_map_json=?,channel_map_json=?,
      vm_map_json=?,product_map_json=?,result_json=?,error=?,updated_at=?
    WHERE id=?
  `).bind(
    patch.status??current.status,
    patch.phase??current.phase,
    patch.cursor??current.cursor,
    patch.role_map_json??current.role_map_json,
    patch.channel_map_json??current.channel_map_json,
    patch.vm_map_json??current.vm_map_json,
    patch.product_map_json??current.product_map_json,
    patch.result_json??current.result_json,
    patch.error===undefined?current.error:patch.error,
    Date.now(),id
  ).run();
}

export async function cancelRestoreJob(env:Env,id:string):Promise<boolean>{
  await ensureBackupSchema(env);
  const result=await env.DB.prepare(`
    UPDATE guild_restore_jobs
    SET status='cancelled',updated_at=?
    WHERE id=? AND status IN ('queued','running')
  `).bind(Date.now(),id).run();
  return (result.meta.changes??0)>0;
}

export async function recordPanelDeployment(
  env:Env,
  input:{guildId:string;kind:string;objectId?:string;channelId:string;messageId?:string|null}
):Promise<void>{
  await ensureBackupSchema(env);
  const now=Date.now();
  await env.DB.prepare(`
    INSERT INTO panel_deployments(
      guild_id,kind,object_id,channel_id,message_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(guild_id,kind,object_id) DO UPDATE SET
      channel_id=excluded.channel_id,
      message_id=excluded.message_id,
      updated_at=excluded.updated_at
  `).bind(
    input.guildId,input.kind,input.objectId??"",input.channelId,input.messageId??null,now,now
  ).run();
}

export async function listPanelDeployments(
  env:Env,guildId:string
):Promise<PanelDeploymentRow[]>{
  await ensureBackupSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM panel_deployments WHERE guild_id=? ORDER BY created_at ASC"
  ).bind(guildId).all<PanelDeploymentRow>()).results;
}
