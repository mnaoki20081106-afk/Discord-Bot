import { useEffect, useMemo, useState } from "react";
import { API_BASE, api } from "./api";

type Backup = {
  id:string;
  sourceGuildId:string;
  sourceGuildName:string;
  label:string|null;
  createdAt:number;
  schemaVersion:number;
  roleCount:number;
  channelCount:number;
  memberCount:number;
  recoveryMemberCount:number;
  warnings:string[];
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
  panelsRestored:number;
  productsRestored:number;
  vendingMachinesRestored:number;
  warnings:string[];
};

type RestoreJob = {
  id:string;
  backupId:string;
  targetGuildId:string;
  status:"queued"|"running"|"completed"|"failed"|"cancelled";
  phase:string;
  cursor:number;
  result:RestoreStats;
  error:string|null;
  createdAt:number;
  updatedAt:number;
};

type Preview = {
  source:{id:string;name:string};
  target:{id:string;name:string};
  counts:{
    roles:number;
    missingRoles:number;
    channels:number;
    missingChannels:number;
    members:number;
    bans:number;
    recoveryRegistered:number;
    botPanels:number;
    vendingMachines:number;
  };
  behavior:{
    destructive:boolean;
    deletesExisting:boolean;
    reusesMatching:boolean;
    memberRestoreRequiresPriorConsent:boolean;
  };
  warnings:string[];
};

type RecoveryStatus = {
  registered:number;
  authorizePath:string;
  redirectPath:string;
};

type Props = {
  guildId:string;
  channels:Array<{id:string;name:string;type?:string;botCanPost?:boolean}>;
  onNotice:(message:string)=>void;
  onError:(message:string)=>void;
};

function formatDate(value:number){
  return new Intl.DateTimeFormat("ja-JP",{
    year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit"
  }).format(new Date(value));
}

function phaseLabel(phase:string){
  const labels:Record<string,string>={
    preflight:"事前確認",
    roles:"ロール",
    categories:"カテゴリ",
    channels:"チャンネル",
    positions:"配置・サーバー設定",
    "guild-extras":"Welcome/Widget",
    bans:"BAN一覧",
    "bot-settings":"BOT設定",
    "legacy-products":"商品",
    vending:"自販機",
    panels:"パネル",
    members:"メンバー",
    done:"完了"
  };
  return labels[phase]??phase;
}

export default function BackupManager({
  guildId,channels,onNotice,onError
}:Props){
  const [backups,setBackups]=useState<Backup[]>([]);
  const [jobs,setJobs]=useState<RestoreJob[]>([]);
  const [recovery,setRecovery]=useState<RecoveryStatus|null>(null);
  const [label,setLabel]=useState("");
  const [panelChannel,setPanelChannel]=useState("");
  const [busy,setBusy]=useState<string|null>(null);
  const [preview,setPreview]=useState<{backup:Backup;data:Preview}|null>(null);
  const [confirmText,setConfirmText]=useState("");

  const postableChannels=useMemo(
    ()=>channels.filter(channel=>
      (channel.type==="text"||channel.type==="announcement")&&channel.botCanPost!==false
    ),
    [channels]
  );

  const apiOrigin=useMemo(()=>{
    try{
      return new URL(API_BASE||location.origin,location.href).origin;
    }catch{
      return location.origin;
    }
  },[]);

  const callbackUrl=apiOrigin+(recovery?.redirectPath??"/auth/discord/callback");
  const selfRegisterUrl=recovery
    ?apiOrigin+recovery.authorizePath
    :"";

  async function load(){
    try{
      const [backupRows,jobRows,recoveryRow]=await Promise.all([
        api<Backup[]>("/api/backups"),
        api<RestoreJob[]>("/api/restore-jobs?targetGuildId="+encodeURIComponent(guildId)),
        api<RecoveryStatus>("/api/guilds/"+guildId+"/recovery/status")
      ]);
      setBackups(backupRows);
      setJobs(jobRows);
      setRecovery(recoveryRow);
      setPanelChannel(current=>
        postableChannels.some(channel=>channel.id===current)
          ?current
          :postableChannels[0]?.id??""
      );
    }catch(reason){
      onError(reason instanceof Error?reason.message:String(reason));
    }
  }

  useEffect(()=>{
    void load();
  },[guildId]);

  useEffect(()=>{
    const active=jobs.some(job=>job.status==="queued"||job.status==="running");
    if(!active) return;
    const timer=window.setInterval(()=>void load(),8000);
    return ()=>window.clearInterval(timer);
  },[jobs,guildId]);

  async function createBackup(){
    setBusy("create");
    try{
      const created=await api<Backup>("/api/guilds/"+guildId+"/backups",{
        method:"POST",
        body:JSON.stringify({label:label.trim()||undefined})
      },120_000);
      setLabel("");
      onNotice(
        "バックアップを作成しました。"+
        ` ロール${created.roleCount} / チャンネル${created.channelCount} / メンバー${created.memberCount}`
      );
      await load();
    }catch(reason){
      onError(reason instanceof Error?reason.message:String(reason));
    }finally{
      setBusy(null);
    }
  }

  async function showPreview(backup:Backup){
    setBusy("preview:"+backup.id);
    try{
      const data=await api<Preview>("/api/backups/"+backup.id+"/restore/preview",{
        method:"POST",
        body:JSON.stringify({targetGuildId:guildId})
      },45_000);
      setPreview({backup,data});
      setConfirmText("");
    }catch(reason){
      onError(reason instanceof Error?reason.message:String(reason));
    }finally{
      setBusy(null);
    }
  }

  async function startRestore(){
    if(!preview||confirmText!=="復元") return;
    const id=preview.backup.id;
    setBusy("restore:"+id);
    try{
      const job=await api<RestoreJob>("/api/backups/"+id+"/restore",{
        method:"POST",
        body:JSON.stringify({targetGuildId:guildId})
      },45_000);
      setPreview(null);
      setConfirmText("");
      onNotice("復元ジョブを開始しました。Discord APIの制限を避けながら段階的に復元します。");
      setJobs(current=>[job,...current.filter(item=>item.id!==job.id)]);
      await load();
    }catch(reason){
      onError(reason instanceof Error?reason.message:String(reason));
    }finally{
      setBusy(null);
    }
  }

  async function deleteBackup(backup:Backup){
    if(!window.confirm(
      `「${backup.label||backup.sourceGuildName}」のバックアップを削除します。復元できなくなります。よろしいですか？`
    )) return;
    setBusy("delete:"+backup.id);
    try{
      await api("/api/backups/"+backup.id,{method:"DELETE"});
      onNotice("バックアップを削除しました");
      await load();
    }catch(reason){
      onError(reason instanceof Error?reason.message:String(reason));
    }finally{
      setBusy(null);
    }
  }

  async function installRecoveryPanel(){
    if(!panelChannel) return;
    setBusy("panel");
    try{
      await api("/api/guilds/"+guildId+"/recovery/panel",{
        method:"POST",
        body:JSON.stringify({channelId:panelChannel})
      });
      onNotice("メンバー復旧登録パネルを設置しました");
    }catch(reason){
      onError(reason instanceof Error?reason.message:String(reason));
    }finally{
      setBusy(null);
    }
  }

  async function cancelJob(job:RestoreJob){
    setBusy("cancel:"+job.id);
    try{
      await api("/api/restore-jobs/"+job.id,{method:"DELETE"});
      onNotice("復元ジョブを停止しました");
      await load();
    }catch(reason){
      onError(reason instanceof Error?reason.message:String(reason));
    }finally{
      setBusy(null);
    }
  }

  return (
    <section className="backup-manager">
      <div className="backup-hero card">
        <div>
          <span className="eyebrow">DISASTER RECOVERY</span>
          <h2>バックアップ管理</h2>
          <p className="muted">
            Discord上の構成・権限・メンバー情報と、認証・商品・自販機などDSM側の設定を
            暗号化して保存します。復元は既存項目を削除せず、差分を段階的に合わせます。
          </p>
        </div>
        <button className="secondary" onClick={()=>void load()} disabled={busy!==null}>
          再読み込み
        </button>
      </div>

      <div className="backup-grid">
        <article className="card">
          <div className="section-head">
            <div>
              <span className="eyebrow">SNAPSHOT</span>
              <h3>新しいバックアップ</h3>
            </div>
          </div>
          <label className="field">
            <span>メモ / 名前</span>
            <input
              value={label}
              onChange={event=>setLabel(event.target.value)}
              placeholder="例: 大規模変更の前"
              maxLength={80}
            />
          </label>
          <div className="backup-callout">
            <strong>自動保護</strong>
            <span>
              手動バックアップに加えて、24時間以上新しいバックアップが無いサーバーは自動取得します。
              自動バックアップは各サーバー14世代を保持します。
            </span>
          </div>
          <div className="backup-callout">
            <strong>取得対象</strong>
            <span>
              サーバー基本設定、ロール・権限・並び順、カテゴリ/チャンネル、
              メンバーID・ロール・タイムアウト、BAN一覧、Welcome Screen / Widget、絵文字/ステッカー情報、認証設定、商品、自販機、
              在庫、クーポン、パネル設置情報。
            </span>
          </div>
          <button
            className="primary"
            onClick={()=>void createBackup()}
            disabled={busy!==null}
          >
            {busy==="create"?"取得中...":"今すぐバックアップを作成"}
          </button>
        </article>

        <article className="card">
          <div className="section-head">
            <div>
              <span className="eyebrow">MEMBER RECOVERY</span>
              <h3>メンバー自動復元の準備</h3>
            </div>
            <span className="backup-count">{recovery?.registered??0} 登録</span>
          </div>
          <p className="muted">
            Discordの仕様上、メンバー本人が事前に公式OAuthで
            <code>guilds.join</code> を許可した場合のみ自動再参加できます。
            復旧登録済みのメンバーは、復元ジョブで自動追加されます。
          </p>
          <label className="field">
            <span>復旧登録パネル設置先</span>
            <select value={panelChannel} onChange={event=>setPanelChannel(event.target.value)}>
              {postableChannels.map(channel=>(
                <option key={channel.id} value={channel.id}>#{channel.name}</option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button
              className="primary"
              onClick={()=>void installRecoveryPanel()}
              disabled={busy!==null||!panelChannel}
            >
              {busy==="panel"?"設置中...":"復旧登録パネルを設置"}
            </button>
            {selfRegisterUrl&&(
              <a className="secondary" href={selfRegisterUrl} target="_blank" rel="noreferrer">
                自分で登録テスト
              </a>
            )}
          </div>
          <div className="backup-callback">
            <small>Discord Developer Portal の Redirect URI</small>
            <code>{callbackUrl}</code>
            <button
              type="button"
              className="text-button"
              onClick={()=>void navigator.clipboard?.writeText(callbackUrl)}
            >
              コピー
            </button>
          </div>
        </article>
      </div>

      {jobs.length>0&&(
        <article className="card backup-jobs">
          <div className="section-head">
            <div>
              <span className="eyebrow">RESTORE JOBS</span>
              <h3>復元状況</h3>
            </div>
          </div>
          <div className="backup-job-list">
            {jobs.map(job=>{
              const active=job.status==="queued"||job.status==="running";
              return (
                <div className={"backup-job "+job.status} key={job.id}>
                  <div>
                    <strong>
                      {job.status==="completed"?"復元完了":
                        job.status==="failed"?"復元失敗":
                        job.status==="cancelled"?"停止済み":"復元中"}
                    </strong>
                    <small>
                      {phaseLabel(job.phase)} · 更新 {formatDate(job.updatedAt)}
                    </small>
                  </div>
                  <div className="backup-job-stats">
                    <span>ロール +{job.result.rolesCreated}</span>
                    <span>チャンネル +{job.result.channelsCreated}</span>
                    <span>メンバー +{job.result.membersAdded}</span>
                    <span>BAN +{job.result.bansRestored||0}</span>
                    <span>タイムアウト +{job.result.memberTimeoutsRestored||0}</span>
                    <span>パネル +{job.result.panelsRestored}</span>
                  </div>
                  {job.error&&<div className="backup-job-error">{job.error}</div>}
                  {job.result.warnings?.length>0&&(
                    <details>
                      <summary>注意 {job.result.warnings.length}件</summary>
                      <ul>{job.result.warnings.slice(-8).map((item,index)=><li key={index}>{item}</li>)}</ul>
                    </details>
                  )}
                  {active&&(
                    <button
                      className="danger subtle"
                      onClick={()=>void cancelJob(job)}
                      disabled={busy!==null}
                    >
                      復元を停止
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </article>
      )}

      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">ARCHIVES</span>
            <h3>保存済みバックアップ</h3>
          </div>
          <span className="backup-count">{backups.length} 件</span>
        </div>
        {backups.length===0?(
          <div className="backup-empty">まだバックアップはありません。</div>
        ):(
          <div className="backup-list">
            {backups.map(backup=>(
              <div className="backup-row" key={backup.id}>
                <div className="backup-main">
                  <strong>{backup.label||backup.sourceGuildName}</strong>
                  <span>{backup.sourceGuildName}</span>
                  <small>{formatDate(backup.createdAt)}</small>
                </div>
                <div className="backup-stats">
                  <span><b>{backup.roleCount}</b> ロール</span>
                  <span><b>{backup.channelCount}</b> チャンネル</span>
                  <span><b>{backup.memberCount}</b> メンバー</span>
                  <span><b>{backup.recoveryMemberCount}</b> 自動復元登録</span>
                </div>
                {backup.warnings?.length>0&&(
                  <details className="backup-warning">
                    <summary>取得時の注意 {backup.warnings.length}件</summary>
                    <ul>{backup.warnings.map((item,index)=><li key={index}>{item}</li>)}</ul>
                  </details>
                )}
                <div className="button-row">
                  <button
                    className="primary"
                    onClick={()=>void showPreview(backup)}
                    disabled={busy!==null}
                  >
                    {busy==="preview:"+backup.id?"確認中...":"このサーバーへ復元"}
                  </button>
                  <button
                    className="danger subtle"
                    onClick={()=>void deleteBackup(backup)}
                    disabled={busy!==null}
                  >
                    削除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </article>

      {preview&&(
        <div className="backup-modal-backdrop" role="presentation">
          <div className="backup-modal card" role="dialog" aria-modal="true">
            <span className="eyebrow">RESTORE PREVIEW</span>
            <h2>復元内容を確認</h2>
            <p>
              <strong>{preview.data.source.name}</strong> のバックアップを
              <strong> {preview.data.target.name}</strong> に復元します。
            </p>
            <div className="preview-metrics">
              <span>ロール <b>{preview.data.counts.roles}</b> / 新規見込み {preview.data.counts.missingRoles}</span>
              <span>チャンネル <b>{preview.data.counts.channels}</b> / 新規見込み {preview.data.counts.missingChannels}</span>
              <span>メンバー <b>{preview.data.counts.members}</b></span>
              <span>BAN <b>{preview.data.counts.bans}</b></span>
              <span>復旧登録 <b>{preview.data.counts.recoveryRegistered}</b></span>
              <span>パネル <b>{preview.data.counts.botPanels}</b></span>
              <span>自販機 <b>{preview.data.counts.vendingMachines}</b></span>
            </div>
            <div className="backup-safe">
              <strong>安全モード</strong>
              <span>既存チャンネル/ロールは削除しません。一致するものを再利用し、不足分を追加します。</span>
            </div>
            {preview.data.warnings.length>0&&(
              <div className="alert error">
                {preview.data.warnings.map((warning,index)=><div key={index}>{warning}</div>)}
              </div>
            )}
            <label className="field">
              <span>開始するには「復元」と入力</span>
              <input
                value={confirmText}
                onChange={event=>setConfirmText(event.target.value)}
                placeholder="復元"
                autoComplete="off"
              />
            </label>
            <div className="button-row">
              <button className="secondary" onClick={()=>setPreview(null)} disabled={busy!==null}>
                キャンセル
              </button>
              <button
                className="primary"
                onClick={()=>void startRestore()}
                disabled={busy!==null||confirmText!=="復元"}
              >
                {busy?.startsWith("restore:")?"開始中...":"復元ジョブを開始"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
