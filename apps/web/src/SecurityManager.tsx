import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Channel = {
  id: string;
  name: string;
  type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
  botCanPost?: boolean;
};

type SecurityModules = {
  antiNuke: boolean;
  antiRaid: boolean;
  antiSpam: boolean;
  antiPhishing: boolean;
  dangerousAttachments: boolean;
  botGuard: boolean;
  webhookGuard: boolean;
  roleGuard: boolean;
  permissionGuard: boolean;
  automodGuard: boolean;
  guildGuard: boolean;
  memberGuard: boolean;
};

type Thresholds = {
  actionWindowSeconds: number;
  crossActionWindowSeconds: number;
  crossActionScore: number;
  channelDelete: number;
  channelCreate: number;
  channelUpdate: number;
  channelOverwrite: number;
  roleDelete: number;
  roleCreate: number;
  roleUpdate: number;
  banAdd: number;
  memberPrune: number;
  kick: number;
  webhook: number;
  botAdd: number;
  guildUpdate: number;
  automodChange: number;
  raidJoins: number;
  raidWindowSeconds: number;
  spamMessages: number;
  spamWindowSeconds: number;
  mentionLimit: number;
  linkBurst: number;
  linkWindowSeconds: number;
  severeContentUsers: number;
  severeContentWindowSeconds: number;
  minAccountAgeHours: number;
};

type SecuritySettings = {
  enabled: boolean;
  mode: "audit" | "enforce";
  profile: "balanced" | "strict" | "paranoid";
  modules: SecurityModules;
  thresholds: Thresholds;
  response: {
    stripDangerousRoles: boolean;
    kickMaliciousBots: boolean;
    timeoutMinutes: number;
    autoLockdown: boolean;
    lockdownMinutes: number;
    deleteUnsafeMessages: boolean;
    quarantineRaidJoins: boolean;
  };
  safety: {
    enforceExplicitContentFilter: boolean;
    minimumVerificationLevel: number;
  };
  logChannelId: string | null;
  trustedUserIds: string[];
  trustedRoleIds: string[];
  allowedBotIds: string[];
  allowedDomains: string[];
  blockedDomains: string[];
};

type Overview = {
  configured: boolean;
  installed?: boolean;
  inviteUrl?: string;
  maximumInviteUrl?: string;
  capabilities?: {
    administrator: boolean;
    requiredReady: boolean;
    maximumProtection: boolean;
    roleAboveManagedBots: boolean | null;
    roleAboveDangerousRoles: boolean | null;
    dangerousRolesNotBelow: Array<{
      id: string;
      name: string;
      position: number;
    }>;
    highestRoleName: string | null;
    highestRolePosition: number | null;
    missingPermissions: string[];
  };
  safetyStatus?: {
    explicitContentFilter: number;
    verificationLevel: number;
    mfaLevel: number;
    raidAlertsEnabled: boolean;
    safetyAlertsChannelConfigured: boolean;
    baselineReady: boolean;
  } | null;
  bridgeProtection?: {
    coreLocked: boolean;
    exceptionAdditionsLocked: boolean;
    automaticLockdownUnlockLocked: boolean;
  };
  unreachable?: boolean;
  message?: string;
  settings: SecuritySettings | null;
  status: {
    connected: boolean;
    lastHeartbeatAck: number | null;
    lastEventAt: number | null;
    reconnectAttempts: number;
    botUserId: string | null;
  };
  incidents: Array<{
    id: string;
    actorId: string | null;
    kind: string;
    severity: string;
    summary: string;
    createdAt: number;
  }>;
  lockdown: {
    active: boolean;
    expiresAt: number | null;
    reason: string | null;
    manualUnlockAllowed?: boolean;
  };
};

function Toggle({
  value,
  onChange,
  title,
  description,
  disabled = false
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <span className="toggle-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={`switch ${value ? "on" : ""}`}>
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
        />
        <span />
      </span>
    </label>
  );
}

function lines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

const PRESETS: Record<SecuritySettings["profile"], Partial<Thresholds>> = {
  balanced: {
    crossActionScore: 18,
    channelDelete: 3,
    roleDelete: 3,
    webhook: 3,
    banAdd: 6,
    kick: 7,
    raidJoins: 12,
    raidWindowSeconds: 15,
    severeContentUsers: 5,
    severeContentWindowSeconds: 45
  },
  strict: {
    crossActionScore: 12,
    channelDelete: 2,
    roleDelete: 2,
    webhook: 2,
    banAdd: 4,
    kick: 5,
    raidJoins: 8,
    raidWindowSeconds: 12,
    severeContentUsers: 3,
    severeContentWindowSeconds: 30
  },
  paranoid: {
    crossActionScore: 8,
    channelDelete: 1,
    roleDelete: 1,
    webhook: 1,
    banAdd: 3,
    kick: 3,
    raidJoins: 6,
    raidWindowSeconds: 12,
    severeContentUsers: 2,
    severeContentWindowSeconds: 20
  }
};

export default function SecurityManager({
  guildId,
  channels,
  onNotice,
  onError
}: {
  guildId: string;
  channels: Channel[];
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<SecuritySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [trustedUsers, setTrustedUsers] = useState("");
  const [trustedRoles, setTrustedRoles] = useState("");
  const [allowedBots, setAllowedBots] = useState("");
  const [allowedDomains, setAllowedDomains] = useState("");
  const [blockedDomains, setBlockedDomains] = useState("");

  const logChannels = useMemo(
    () => channels.filter(channel =>
      channel.type === "text" || channel.type === "announcement"
    ),
    [channels]
  );

  async function load() {
    setBusy(true);
    try {
      const data = await api<Overview>(
        `/api/guilds/${guildId}/security-center`,
        {},
        15_000
      );
      setOverview(data);
      setDraft(data.settings);
      if (data.settings) {
        setTrustedUsers(data.settings.trustedUserIds.join("\n"));
        setTrustedRoles(data.settings.trustedRoleIds.join("\n"));
        setAllowedBots(data.settings.allowedBotIds.join("\n"));
        setAllowedDomains(data.settings.allowedDomains.join("\n"));
        setBlockedDomains(data.settings.blockedDomains.join("\n"));
      }
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [guildId]);

  function setModule(key: keyof SecurityModules, value: boolean) {
    if (!draft) return;
    setDraft({
      ...draft,
      modules: { ...draft.modules, [key]: value }
    });
  }

  function applyProfile(profile: SecuritySettings["profile"]) {
    if (!draft) return;
    setDraft({
      ...draft,
      profile,
      thresholds: {
        ...draft.thresholds,
        ...PRESETS[profile]
      }
    });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const body: SecuritySettings = {
        ...draft,
        trustedUserIds: lines(trustedUsers),
        trustedRoleIds: lines(trustedRoles),
        allowedBotIds: lines(allowedBots),
        allowedDomains: lines(allowedDomains),
        blockedDomains: lines(blockedDomains)
      };
      const saved = await api<SecuritySettings>(
        `/api/guilds/${guildId}/security-center`,
        {
          method: "PUT",
          body: JSON.stringify(body)
        },
        15_000
      );
      setDraft(saved);
      onNotice("Security Botの設定を保存しました");
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  async function setLockdown(active: boolean) {
    setBusy(true);
    try {
      await api(
        `/api/guilds/${guildId}/security-lockdown`,
        active
          ? {
              method: "POST",
              body: JSON.stringify({
                minutes: draft?.response.lockdownMinutes ?? 15,
                reason: "manual dashboard lockdown"
              })
            }
          : { method: "DELETE" },
        30_000
      );
      onNotice(active ? "緊急Lockdownを開始しました" : "Lockdownを解除しました");
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  if (!overview) {
    return <article className="card">Security Botの状態を読み込んでいます…</article>;
  }

  if (!overview.configured) {
    return (
      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">SECURITY BOT</span>
            <h2>Security Botを接続してください</h2>
          </div>
        </div>
        <p>
          Main管理画面側の <code>SECURITY_API_BASE_URL</code> と
          <code> SECURITY_BRIDGE_SECRET</code> がまだ設定されていません。
          設定後も、この管理画面をそのまま使用します。
        </p>
      </article>
    );
  }

  if (overview.unreachable || !draft) {
    return (
      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">SECURITY BOT</span>
            <h2>Security Botへ接続できません</h2>
          </div>
          <button type="button" className="secondary" onClick={() => void load()}>
            再確認
          </button>
        </div>
        <p>{overview.message ?? "Security Workerの状態を確認してください。"}</p>
      </article>
    );
  }

  return (
    <div className="security-manager">
      <section className="metric-grid">
        <article className="metric card">
          <span>PROTECTION</span>
          <strong>{draft.enabled && draft.mode === "enforce" ? "ACTIVE" : draft.mode.toUpperCase()}</strong>
          <small>{draft.profile.toUpperCase()} profile</small>
        </article>
        <article className="metric card">
          <span>SECURITY BOT</span>
          <strong>
            {!overview.installed
              ? "NOT INSTALLED"
              : overview.status.connected
                ? "ONLINE"
                : "OFFLINE"}
          </strong>
          <small>
            {!overview.installed
              ? "このサーバーへ追加が必要です"
              : overview.status.lastEventAt
                ? "Last event " + new Date(overview.status.lastEventAt).toLocaleTimeString("ja-JP")
                : "Gateway waiting"}
          </small>
        </article>
        <article className="metric card">
          <span>LOCKDOWN</span>
          <strong>{overview.lockdown.active ? "ACTIVE" : "READY"}</strong>
          <small>{overview.lockdown.reason ?? "Emergency containment"}</small>
        </article>
        <article className="metric card">
          <span>INCIDENTS</span>
          <strong>{overview.incidents.length}</strong>
          <small>直近30件</small>
        </article>
        <article className="metric card">
          <span>DEFENSE LEVEL</span>
          <strong>
            {overview.capabilities?.maximumProtection
              ? "MAXIMUM"
              : overview.capabilities?.requiredReady
                ? "HARDENED"
                : "DEGRADED"}
          </strong>
          <small>
            {overview.capabilities?.maximumProtection
              ? "Administrator overwrite bypass"
              : overview.capabilities?.requiredReady
                ? "必要権限は揃っています"
                : "権限不足を確認してください"}
          </small>
        </article>
      </section>

      {overview.installed && overview.capabilities && (
        !overview.capabilities.requiredReady ||
        overview.capabilities.roleAboveDangerousRoles === false ||
        !overview.capabilities.maximumProtection
      ) && (
        <article className="card serverless-note">
          <strong>
            {overview.capabilities.missingPermissions.length > 0
              ? "Security Botの権限が不足しています"
              : overview.capabilities.roleAboveDangerousRoles === false
                ? "Security Botより上に人間用の危険権限ロールがあります"
                : "現在はHardenedモードです"}
          </strong>
          <span>
            {overview.capabilities.missingPermissions.length > 0
              ? "不足: " + overview.capabilities.missingPermissions.join(" / ")
              : overview.capabilities.roleAboveDangerousRoles === false
                ? "Security Botが剥奪できない人間用の危険ロール: " +
                  overview.capabilities.dangerousRolesNotBelow
                    .map(role => role.name)
                    .join(" / ") +
                  "。Security Botは、Administrator・ロール管理・チャンネル管理・BAN/Kick等を持つ人間用ロールより上へ配置してください。Bot/Integrationのmanagedロールはこの判定から除外されます。"
                : "最大保護ではSecurity BotへAdministratorを付与します。Main Botより上である必要はありません。推奨は Main Bot > Security Bot > その他の人間用管理ロールです。"}
          </span>
          {overview.maximumInviteUrl && !overview.capabilities.maximumProtection && (
            <a
              className="secondary"
              href={overview.maximumInviteUrl}
              target="_blank"
              rel="noreferrer"
            >
              最大保護の権限を付与
            </a>
          )}
        </article>
      )}

      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">SECURITY CENTER</span>
            <h2>リアルタイム防御</h2>
            <p>Main Botとは別Token・別Worker・別Gatewayで稼働します。Main Botを誤検知で自動Kickせず、破壊的挙動は検知・記録し、サーバー全体のLockdownを発動します。</p>
          </div>
          <div className="button-row">
            {!overview.installed && (overview.maximumInviteUrl || overview.inviteUrl) && (
              <>
                <a
                  className="primary"
                  href={overview.maximumInviteUrl || overview.inviteUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  最大保護でSecurity Botを追加
                </a>
                {overview.maximumInviteUrl && overview.inviteUrl && (
                  <a
                    className="secondary"
                    href={overview.inviteUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    最小権限で追加
                  </a>
                )}
              </>
            )}
            <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
              更新
            </button>
            <button
              type="button"
              className={overview.lockdown.active ? "secondary" : "danger"}
              disabled={
                busy ||
                (overview.lockdown.active &&
                  overview.lockdown.manualUnlockAllowed === false)
              }
              onClick={() => void setLockdown(!overview.lockdown.active)}
            >
              {overview.lockdown.active
                ? overview.lockdown.manualUnlockAllowed === false
                  ? "自動Lockdown中"
                  : "Lockdown解除"
                : "緊急Lockdown"}
            </button>
            <button type="button" disabled={busy} onClick={() => void save()}>
              設定を保存
            </button>
          </div>
        </div>

        <p className="serverless-note">
          <strong>Bot共存モード</strong><br />
          推奨ロール順は <strong>Main Bot &gt; Security Bot &gt; 他社製Bot &gt; 人間用の危険権限ロール</strong> です。
          他社製Botの通常設定操作は誤検知でLockdown/Kickしません。
          Securityより上に置いたBotはDiscordのロール階層上Kickできないため、必要な場合を除きSecurityより下に置いてください。
        </p>

        {overview.bridgeProtection?.coreLocked && (
          <p className="serverless-note">
            <strong>Core Protection Locked</strong><br />
            Main Workerが侵害されてもSecurity Botを無効化できないよう、
            Enforce・破壊対策Guard・Auto Lockdown・Safety BaselineはSecurity側で最低防御を強制します。
            Trusted/Allow例外はMain管理画面から新規追加できず、既存例外の削除だけ可能です。
          </p>
        )}

        {overview.lockdown.active &&
          overview.lockdown.manualUnlockAllowed === false && (
          <p className="serverless-note">
            このLockdownは自動防御で発動したためMain Botからは解除できません。
            {overview.lockdown.expiresAt
              ? " 自動復旧予定: " +
                new Date(overview.lockdown.expiresAt).toLocaleString("ja-JP")
              : ""}
          </p>
        )}

        <div className="form-grid">
          <label className="field">
            <span>動作モード</span>
            <select
              value={draft.mode}
              disabled={overview.bridgeProtection?.coreLocked}
              onChange={event => setDraft({
                ...draft,
                mode: event.target.value as SecuritySettings["mode"]
              })}
            >
              <option value="enforce">Enforce（検知して防御）</option>
              <option value="audit">Audit only（記録のみ）</option>
            </select>
          </label>
          <label className="field">
            <span>防御プロファイル</span>
            <select
              value={draft.profile}
              onChange={event =>
                applyProfile(event.target.value as SecuritySettings["profile"])
              }
            >
              <option value="balanced">Balanced</option>
              <option value="strict">Strict（推奨）</option>
              <option value="paranoid">Paranoid</option>
            </select>
          </label>
          <label className="field">
            <span>Security Log</span>
            <select
              value={draft.logChannelId ?? ""}
              onChange={event => setDraft({
                ...draft,
                logChannelId: event.target.value || null
              })}
            >
              <option value="">未設定</option>
              {logChannels.map(channel => (
                <option value={channel.id} key={channel.id}>#{channel.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="toggle-stack">
          <Toggle
            value={draft.enabled}
            onChange={enabled => setDraft({ ...draft, enabled })}
            title="Security Engine"
            description="独立防御のため常時ONです"
            disabled={overview.bridgeProtection?.coreLocked}
          />
          <Toggle value={draft.modules.antiNuke} onChange={v => setModule("antiNuke", v)}
            title="Anti-Nuke" description="Channel破壊と複合攻撃をGatewayでリアルタイム検知" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.antiRaid} onChange={v => setModule("antiRaid", v)}
            title="Anti-Raid" description="短時間の大量参加を検知してLockdown・隔離" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.antiSpam} onChange={v => setModule("antiSpam", v)}
            title="Anti-Spam / Mention Flood" description="連投と大量メンションをリアルタイム遮断" />
          <Toggle value={draft.modules.antiPhishing} onChange={v => setModule("antiPhishing", v)}
            title="Scam / Phishing Guard" description="危険URL・偽ログイン誘導を遮断" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.dangerousAttachments} onChange={v => setModule("dangerousAttachments", v)}
            title="Dangerous Attachment Guard" description="実行ファイル・スクリプト系添付を遮断" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.botGuard} onChange={v => setModule("botGuard", v)}
            title="Bot Guard" description="Bot追加を監査。権限が強いだけでは即Kickせず、追加後の破壊挙動を監視" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.webhookGuard} onChange={v => setModule("webhookGuard", v)}
            title="Webhook Guard" description="Webhookを悪用した攻撃を検知" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.roleGuard} onChange={v => setModule("roleGuard", v)}
            title="Role Guard" description="Role作成・変更・削除の異常操作を監視" disabled={overview.bridgeProtection?.coreLocked} />
                    <Toggle value={draft.modules.permissionGuard} onChange={v => setModule("permissionGuard", v)}
            title="Permission Guard" description="Administrator等の危険権限付与を即時ロールバック" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.memberGuard} onChange={v => setModule("memberGuard", v)}
            title="Member Guard" description="短時間の大量Kick・Banを検知" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.guildGuard} onChange={v => setModule("guildGuard", v)}
            title="Server / Integration Guard" description="サーバー設定・Integrationの異常変更を監視" disabled={overview.bridgeProtection?.coreLocked} />
          <Toggle value={draft.modules.automodGuard} onChange={v => setModule("automodGuard", v)}
            title="AutoMod Guard" description="AutoModの無断変更・削除を監視" disabled={overview.bridgeProtection?.coreLocked} />
        </div>
      </article>

      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">SERVER SAFETY</span>
            <h2>Discord Safety Baseline</h2>
            <p>Security Botとは別に、Discord標準の安全フィルターも強制維持します。</p>
          </div>
          <strong>
            {overview.safetyStatus?.baselineReady ? "READY" : "CHECK"}
          </strong>
        </div>

        <div className="toggle-stack">
          <Toggle
            value={draft.safety.enforceExplicitContentFilter}
            onChange={value => setDraft({
              ...draft,
              safety: { ...draft.safety, enforceExplicitContentFilter: value }
            })}
            title="Explicit Content Filter: ALL MEMBERS"
            description="独立防御の最低ラインとして常時有効です"
            disabled={overview.bridgeProtection?.coreLocked}
          />
        </div>

        <div className="form-grid">
          <label className="field">
            <span>最低Verification Level</span>
            <select
              value={draft.safety.minimumVerificationLevel}
              onChange={event => setDraft({
                ...draft,
                safety: {
                  ...draft.safety,
                  minimumVerificationLevel: Number(event.target.value)
                }
              })}
            >
              <option value={0} disabled>None</option>
              <option value={1} disabled>Low（メール認証）</option>
              <option value={2}>Medium（推奨最低値）</option>
              <option value={3}>High</option>
              <option value={4}>Very High（電話番号認証）</option>
            </select>
          </label>
          <label className="field">
            <span>現在のExplicit Filter</span>
            <input
              value={
                overview.safetyStatus
                  ? overview.safetyStatus.explicitContentFilter === 2
                    ? "ALL MEMBERS"
                    : overview.safetyStatus.explicitContentFilter === 1
                      ? "MEMBERS WITHOUT ROLES"
                      : "DISABLED"
                  : "取得待ち"
              }
              readOnly
            />
          </label>
          <label className="field">
            <span>Server 2FA</span>
            <input
              value={overview.safetyStatus?.mfaLevel === 1 ? "ENABLED" : "DISABLED"}
              readOnly
            />
          </label>
          <label className="field">
            <span>Raid Alerts</span>
            <input
              value={overview.safetyStatus?.raidAlertsEnabled ? "ENABLED" : "DISABLED / UNKNOWN"}
              readOnly
            />
          </label>
        </div>

        {overview.safetyStatus?.mfaLevel === 0 && (
          <p className="serverless-note">
            管理操作の2FA必須化はDiscord側のSafety Setupから有効にしてください。
            Security Botから勝手に変更せず、状態だけ監視します。
          </p>
        )}
      </article>

      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">CONTAINMENT</span>
            <h2>攻撃時の自動対応</h2>
          </div>
        </div>
        <div className="toggle-stack">
          <Toggle
            value={draft.response.stripDangerousRoles}
            onChange={value => setDraft({
              ...draft,
              response: { ...draft.response, stripDangerousRoles: value }
            })}
            title="危険権限ロールを剥奪"
            description="攻撃者から管理系権限を持つロールを除去"
            disabled={overview.bridgeProtection?.coreLocked}
          />
          <Toggle
            value={draft.response.kickMaliciousBots}
            onChange={value => setDraft({
              ...draft,
              response: { ...draft.response, kickMaliciousBots: value }
            })}
            title="攻撃BotをKick"
            description="Main/管理対象Botは自動Kickしません。その他Botも極端な破壊操作が確認された場合だけ対象にします"
            disabled={overview.bridgeProtection?.coreLocked}
          />
          <Toggle
            value={draft.response.autoLockdown}
            onChange={value => setDraft({
              ...draft,
              response: { ...draft.response, autoLockdown: value }
            })}
            title="Auto Lockdown"
            description="重大攻撃時に@everyoneの送信・通話・Thread作成を一時停止"
            disabled={overview.bridgeProtection?.coreLocked}
          />
        </div>
        <div className="form-grid">
          <label className="field">
            <span>攻撃者Timeout（分）</span>
            <input
              type="number"
              min={1}
              max={40320}
              value={draft.response.timeoutMinutes}
              onChange={event => setDraft({
                ...draft,
                response: {
                  ...draft.response,
                  timeoutMinutes: Number(event.target.value)
                }
              })}
            />
          </label>
          <label className="field">
            <span>Lockdown（分）</span>
            <input
              type="number"
              min={1}
              max={180}
              value={draft.response.lockdownMinutes}
              onChange={event => setDraft({
                ...draft,
                response: {
                  ...draft.response,
                  lockdownMinutes: Number(event.target.value)
                }
              })}
            />
          </label>
        </div>
      </article>

      <article className="card">
        <details>
          <summary><strong>詳細設定・例外</strong></summary>
          <div className="form-grid security-advanced">
            <label className="field">
              <span>Trusted User IDs</span>
              <textarea value={trustedUsers} onChange={event => setTrustedUsers(event.target.value)} />
              <small>既存例外の削除のみ可能です。Main管理画面から新規追加はできません。</small>
            </label>
            <label className="field">
              <span>Trusted Role IDs</span>
              <textarea value={trustedRoles} onChange={event => setTrustedRoles(event.target.value)} />
              <small>既存例外の削除のみ可能です。新規Trusted Role追加はSecurity側で拒否します。</small>
            </label>
            <label className="field">
              <span>追加を許可するBot IDs</span>
              <textarea value={allowedBots} onChange={event => setAllowedBots(event.target.value)} />
              <small>通常の連携Botは登録不要です。既存の明示保護IDは削除のみ可能で、新規例外はMain経由では追加できません。</small>
            </label>
            <label className="field">
              <span>許可ドメイン</span>
              <textarea value={allowedDomains} onChange={event => setAllowedDomains(event.target.value)} />
              <small>既存許可の削除のみ可能です。新規Allowlist追加はMain経由では拒否します。</small>
            </label>
            <label className="field">
              <span>強制ブロックドメイン</span>
              <textarea value={blockedDomains} onChange={event => setBlockedDomains(event.target.value)} />
            </label>
            <label className="field">
              <span>Cross-action Risk閾値</span>
              <input
                type="number"
                min={4}
                max={20}
                value={draft.thresholds.crossActionScore}
                onChange={event => setDraft({
                  ...draft,
                  thresholds: {
                    ...draft.thresholds,
                    crossActionScore: Number(event.target.value)
                  }
                })}
              />
            </label>
            <label className="field">
              <span>Raid人数</span>
              <input
                type="number"
                min={2}
                max={20}
                value={draft.thresholds.raidJoins}
                onChange={event => setDraft({
                  ...draft,
                  thresholds: {
                    ...draft.thresholds,
                    raidJoins: Number(event.target.value)
                  }
                })}
              />
            </label>
            <label className="field">
              <span>Raid判定秒数</span>
              <input
                type="number"
                min={2}
                max={300}
                value={draft.thresholds.raidWindowSeconds}
                onChange={event => setDraft({
                  ...draft,
                  thresholds: {
                    ...draft.thresholds,
                    raidWindowSeconds: Number(event.target.value)
                  }
                })}
              />
            </label>
            <label className="field">
              <span>1投稿のメンション上限</span>
              <input
                type="number"
                min={2}
                max={100}
                value={draft.thresholds.mentionLimit}
                onChange={event => setDraft({
                  ...draft,
                  thresholds: {
                    ...draft.thresholds,
                    mentionLimit: Number(event.target.value)
                  }
                })}
              />
            </label>
            <label className="field">
              <span>重大投稿の複数ユーザー閾値</span>
              <input
                type="number"
                min={2}
                max={6}
                value={draft.thresholds.severeContentUsers}
                onChange={event => setDraft({
                  ...draft,
                  thresholds: {
                    ...draft.thresholds,
                    severeContentUsers: Number(event.target.value)
                  }
                })}
              />
              <small>Phishing / 危険添付を短時間に投稿した異なるユーザー数です。</small>
            </label>
            <label className="field">
              <span>重大投稿の監視秒数</span>
              <input
                type="number"
                min={5}
                max={300}
                value={draft.thresholds.severeContentWindowSeconds}
                onChange={event => setDraft({
                  ...draft,
                  thresholds: {
                    ...draft.thresholds,
                    severeContentWindowSeconds: Number(event.target.value)
                  }
                })}
              />
              <small>閾値到達時は自動Lockdown設定に従って封じ込めます。</small>
            </label>
          </div>
        </details>
      </article>

      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">INCIDENTS</span>
            <h2>Security Log</h2>
          </div>
        </div>
        {overview.incidents.length === 0 ? (
          <p>記録されたインシデントはありません。</p>
        ) : (
          <div className="security-incidents">
            {overview.incidents.map(incident => (
              <div className="security-incident" key={incident.id}>
                <div>
                  <strong>{incident.kind}</strong>
                  <span className={`security-severity ${incident.severity}`}>
                    {incident.severity.toUpperCase()}
                  </span>
                </div>
                <p>{incident.summary}</p>
                <small>
                  {new Date(incident.createdAt).toLocaleString("ja-JP")}
                  {incident.actorId ? " / Actor " + incident.actorId : ""}
                </small>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
