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
  roleDelete: number;
  roleCreate: number;
  roleUpdate: number;
  banAdd: number;
  kick: number;
  webhook: number;
  botAdd: number;
  guildUpdate: number;
  automodChange: number;
  raidJoins: number;
  raidWindowSeconds: number;
  spamMessages: number;
  spamWindowSeconds: number;
  linkBurst: number;
  linkWindowSeconds: number;
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
  logChannelId: string | null;
  trustedUserIds: string[];
  trustedRoleIds: string[];
  allowedBotIds: string[];
  allowedDomains: string[];
  blockedDomains: string[];
};

type Overview = {
  configured: boolean;
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
  };
};

function Toggle({
  value,
  onChange,
  title,
  description
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="toggle-row">
      <span className="toggle-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={`switch ${value ? "on" : ""}`}>
        <input
          type="checkbox"
          checked={value}
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
    raidWindowSeconds: 15
  },
  strict: {
    crossActionScore: 12,
    channelDelete: 2,
    roleDelete: 2,
    webhook: 2,
    banAdd: 4,
    kick: 5,
    raidJoins: 8,
    raidWindowSeconds: 12
  },
  paranoid: {
    crossActionScore: 8,
    channelDelete: 1,
    roleDelete: 1,
    webhook: 1,
    banAdd: 3,
    kick: 3,
    raidJoins: 6,
    raidWindowSeconds: 12
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
          <strong>{overview.status.connected ? "ONLINE" : "OFFLINE"}</strong>
          <small>
            {overview.status.lastEventAt
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
      </section>

      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">SECURITY CENTER</span>
            <h2>リアルタイム防御</h2>
            <p>Main Botとは別Token・別Worker・別Gatewayで稼働します。</p>
          </div>
          <div className="button-row">
            <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
              更新
            </button>
            <button
              type="button"
              className={overview.lockdown.active ? "secondary" : "danger"}
              disabled={busy}
              onClick={() => void setLockdown(!overview.lockdown.active)}
            >
              {overview.lockdown.active ? "Lockdown解除" : "緊急Lockdown"}
            </button>
            <button type="button" disabled={busy} onClick={() => void save()}>
              設定を保存
            </button>
          </div>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>動作モード</span>
            <select
              value={draft.mode}
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
            description="Security Botのマスタースイッチ"
          />
          <Toggle value={draft.modules.antiNuke} onChange={v => setModule("antiNuke", v)}
            title="Anti-Nuke" description="Role/Channelの大量破壊をGatewayでリアルタイム検知" />
          <Toggle value={draft.modules.antiRaid} onChange={v => setModule("antiRaid", v)}
            title="Anti-Raid" description="短時間の大量参加を検知してLockdown・隔離" />
          <Toggle value={draft.modules.antiPhishing} onChange={v => setModule("antiPhishing", v)}
            title="Scam / Phishing Guard" description="危険URL・偽ログイン誘導を遮断" />
          <Toggle value={draft.modules.dangerousAttachments} onChange={v => setModule("dangerousAttachments", v)}
            title="Dangerous Attachment Guard" description="実行ファイル・スクリプト系添付を遮断" />
          <Toggle value={draft.modules.botGuard} onChange={v => setModule("botGuard", v)}
            title="Bot Guard" description="未許可Bot追加を即時検知・除去" />
          <Toggle value={draft.modules.webhookGuard} onChange={v => setModule("webhookGuard", v)}
            title="Webhook Guard" description="Webhookを悪用した攻撃を検知" />
          <Toggle value={draft.modules.permissionGuard} onChange={v => setModule("permissionGuard", v)}
            title="Permission Guard" description="Administrator等の危険権限付与を即時ロールバック" />
          <Toggle value={draft.modules.automodGuard} onChange={v => setModule("automodGuard", v)}
            title="AutoMod Guard" description="AutoModの無断変更・削除を監視" />
        </div>
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
          />
          <Toggle
            value={draft.response.kickMaliciousBots}
            onChange={value => setDraft({
              ...draft,
              response: { ...draft.response, kickMaliciousBots: value }
            })}
            title="攻撃BotをKick"
            description="Main Botも永久ホワイトリストにはしません。正規操作時だけ短期Leaseを使います"
          />
          <Toggle
            value={draft.response.autoLockdown}
            onChange={value => setDraft({
              ...draft,
              response: { ...draft.response, autoLockdown: value }
            })}
            title="Auto Lockdown"
            description="重大攻撃時に@everyoneの送信・通話・Thread作成を一時停止"
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
              <small>完全な例外です。必要最小限にしてください。</small>
            </label>
            <label className="field">
              <span>Trusted Role IDs</span>
              <textarea value={trustedRoles} onChange={event => setTrustedRoles(event.target.value)} />
              <small>このRoleを持つ全員が防御対象外になります。</small>
            </label>
            <label className="field">
              <span>追加を許可するBot IDs</span>
              <textarea value={allowedBots} onChange={event => setAllowedBots(event.target.value)} />
              <small>Bot追加イベント用。Bot自身の危険操作を恒久的に免除する設定ではありません。</small>
            </label>
            <label className="field">
              <span>許可ドメイン</span>
              <textarea value={allowedDomains} onChange={event => setAllowedDomains(event.target.value)} />
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
                max={100}
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
                max={1000}
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
