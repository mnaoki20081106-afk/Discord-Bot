import { FormEvent, useEffect, useMemo, useState } from "react";
import { API_BASE, api, clearSession, currentSession, login } from "./api";
import ServerEditor from "./ServerEditor";
import VendingManager from "./VendingManager";

type User = { id: string; username: string; avatar: string | null };
type Guild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  botInstalled: boolean;
  inviteUrl: string;
};
type Meta = {
  id: string;
  name: string;
  icon: string | null;
  channels: Array<{
    id: string;
    name: string;
    type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
    parentId?: string | null;
    topic?: string;
    position?: number;
  }>;
  categories: Array<{ id: string; name: string; position?: number }>;
  roles: Array<{ id: string; name: string; position: number }>;
};
type Settings = {
  securityEnabled: boolean;
  antiSpam: boolean;
  spamMax: number;
  spamWindowSeconds: number;
  blockInvites: boolean;
  mentionLimit: number;
  antiRaid: boolean;
  raidJoins: number;
  raidWindowSeconds: number;
  antiNuke: boolean;
  nukeActions: number;
  nukeWindowSeconds: number;
  logChannelId: string | null;
  verifiedRoleId: string | null;
  minAccountAgeDays: number;
  trustedUserIds: string[];
  trustedRoleIds: string[];
};
type Product = {
  id: string;
  guild_id: string;
  name: string;
  description: string;
  price_yen: number;
  active: boolean;
  delivery_type: "role" | "text";
  role_id: string | null;
  delivery_text: string | null;
};
type ServiceStatus = {
  discordReady: boolean;
  payPayConfigured: boolean;
  payPayEnvironment: string;
};

const emptyProduct = {
  name: "",
  description: "",
  priceYen: 500,
  deliveryType: "role" as "role" | "text",
  roleId: "",
  deliveryText: ""
};

function Toggle({
  checked,
  onChange,
  title,
  description
}: {
  checked: boolean;
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
      <span className={`switch ${checked ? "on" : ""}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span />
      </span>
    </label>
  );
}

function Field({
  label,
  children,
  hint
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(Boolean(currentSession()));
  const [me, setMe] = useState<User | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [panelChannel, setPanelChannel] = useState("");
  const [productPanelChannel, setProductPanelChannel] = useState("");
  const [productForm, setProductForm] = useState(emptyProduct);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedGuild = useMemo(
    () => guilds.find((guild) => guild.id === selectedId) ?? null,
    [guilds, selectedId]
  );

  function flash(message: string) {
    setNotice(message);
    setError(null);
    window.setTimeout(() => setNotice(null), 3500);
  }

  function fail(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(message);
    setNotice(null);
    if (!currentSession()) setAuthenticated(false);
  }

  async function loadBase() {
    setBusy(true);
    try {
      const [user, serverList, service] = await Promise.all([
        api<User>("/api/me"),
        api<Guild[]>("/api/guilds"),
        api<ServiceStatus>("/api/status")
      ]);
      setMe(user);
      setGuilds(serverList);
      setStatus(service);
      const firstInstalled = serverList.find((guild) => guild.botInstalled);
      if (!selectedId && firstInstalled) {
        await selectGuild(firstInstalled.id);
      }
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function selectGuild(guildId: string) {
    setSelectedId(guildId);
    setMeta(null);
    setSettings(null);
    setProducts([]);
    setBusy(true);
    try {
      const [serverMeta, serverSettings, serverProducts] = await Promise.all([
        api<Meta>(`/api/guilds/${guildId}/meta`),
        api<Settings>(`/api/guilds/${guildId}/settings`),
        api<Product[]>(`/api/guilds/${guildId}/products`)
      ]);
      setMeta(serverMeta);
      setSettings(serverSettings);
      setProducts(serverProducts);
      setPanelChannel(serverMeta.channels[0]?.id ?? "");
      setProductPanelChannel(serverMeta.channels[0]?.id ?? "");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (authenticated) void loadBase();
  }, [authenticated]);

  async function saveSettings() {
    if (!selectedId || !settings) return;
    setBusy(true);
    try {
      const saved = await api<Settings>(`/api/guilds/${selectedId}/settings`, {
        method: "PUT",
        body: JSON.stringify(settings)
      });
      setSettings(saved);
      flash("セキュリティ設定を保存しました");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function applyTemplate(template: "community" | "shop" | "support") {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${selectedId}/templates/${template}`, {
        method: "POST"
      });
      flash("テンプレートを適用しました");
      await selectGuild(selectedId);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function postPanel(kind: "verification" | "tickets") {
    if (!selectedId || !panelChannel) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${selectedId}/${kind}/panel`, {
        method: "POST",
        body: JSON.stringify({ channelId: panelChannel })
      });
      flash(kind === "verification" ? "認証パネルを設置しました" : "Ticketパネルを設置しました");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    try {
      await api<Product>(`/api/guilds/${selectedId}/products`, {
        method: "POST",
        body: JSON.stringify({
          name: productForm.name,
          description: productForm.description,
          priceYen: Number(productForm.priceYen),
          deliveryType: productForm.deliveryType,
          roleId: productForm.deliveryType === "role" ? productForm.roleId || null : null,
          deliveryText:
            productForm.deliveryType === "text" ? productForm.deliveryText || null : null
        })
      });
      setProductForm(emptyProduct);
      setProducts(await api<Product[]>(`/api/guilds/${selectedId}/products`));
      flash("商品を追加しました");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function removeProduct(id: string) {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${selectedId}/products/${id}`, { method: "DELETE" });
      setProducts((current) => current.filter((product) => product.id !== id));
      flash("商品を削除しました");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function publishProduct(id: string) {
    if (!selectedId || !productPanelChannel) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${selectedId}/products/${id}/panel`, {
        method: "POST",
        body: JSON.stringify({ channelId: productPanelChannel })
      });
      flash("販売パネルをDiscordへ設置しました");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {
      // The local session still gets cleared.
    }
    clearSession();
    setAuthenticated(false);
    setMe(null);
    setGuilds([]);
    setSelectedId(null);
  }

  if (!API_BASE) {
    return (
      <main className="center-screen">
        <section className="login-card">
          <div className="logo-mark">D</div>
          <h1>API URLが未設定です</h1>
          <p>
            GitHub repository variable <code>VITE_API_BASE_URL</code> に
            Cloudflare WorkerのURLを設定して再デプロイしてください。
          </p>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="center-screen">
        <section className="login-card">
          <div className="logo-mark">D</div>
          <span className="eyebrow">Discord Server Manager</span>
          <h1>サーバー管理を、ひとつの画面に。</h1>
          <p>
            サーバー構成、チャンネル編集、セキュリティ、認証、Ticketを
            Discordログインからまとめて管理します。
          </p>
          <button
            className="primary big"
            onClick={() => {
              try {
                login();
              } catch (reason) {
                fail(reason);
              }
            }}
          >
            Discordでログイン
          </button>
          {error && <div className="alert error">{error}</div>}
        </section>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo-mark small">D</div>
          <div>
            <strong>DSM</strong>
            <small>Server Manager</small>
          </div>
        </div>

        <div className="server-list">
          <span className="side-label">SERVERS</span>
          {guilds.map((guild) => (
            <button
              key={guild.id}
              className={`server-button ${selectedId === guild.id ? "active" : ""}`}
              onClick={() => {
                if (guild.botInstalled) void selectGuild(guild.id);
              }}
            >
              {guild.icon ? (
                <img
                  src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=80`}
                  alt=""
                />
              ) : (
                <span className="server-fallback">{guild.name.slice(0, 2).toUpperCase()}</span>
              )}
              <span className="server-copy">
                <strong>{guild.name}</strong>
                <small>{guild.botInstalled ? "管理可能" : "BOT未導入"}</small>
              </span>
              <span className={`dot ${guild.botInstalled ? "online" : ""}`} />
            </button>
          ))}
        </div>

        <div className="account">
          <div className="avatar">{me?.username?.slice(0, 1).toUpperCase() ?? "?"}</div>
          <div>
            <strong>{me?.username ?? "Discord User"}</strong>
            <small>管理者</small>
          </div>
          <button className="icon-button" onClick={() => void logout()} title="ログアウト">
            ↪
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <span className="eyebrow">CONTROL PANEL</span>
            <h1>{selectedGuild?.name ?? "サーバーを選択"}</h1>
          </div>
          <div className="status-row">
            <span className={`status-pill ${status?.discordReady ? "good" : "bad"}`}>
              <i /> BOT {status?.discordReady ? "Online" : "Offline"}
            </span>
            <span className="status-pill good">
              <i /> API Serverless
            </span>
          </div>
        </header>

        {notice && <div className="alert success">{notice}</div>}
        {error && <div className="alert error">{error}</div>}
        {busy && <div className="progress"><span /></div>}

        {!selectedGuild && (
          <section className="empty-state card">
            <h2>管理するサーバーを選んでください</h2>
            <p>左側に、あなたが「サーバー管理」権限を持つDiscordサーバーだけを表示しています。</p>
          </section>
        )}

        {selectedGuild && !selectedGuild.botInstalled && (
          <section className="card install-card">
            <div>
              <span className="eyebrow">BOT REQUIRED</span>
              <h2>まずBOTをこのサーバーへ追加</h2>
              <p>必要な権限だけを要求する招待URLを生成しています。</p>
            </div>
            <a className="primary" href={selectedGuild.inviteUrl} target="_blank" rel="noreferrer">
              BOTを追加
            </a>
          </section>
        )}

        {selectedGuild?.botInstalled && meta && settings && (
          <>
            <ServerEditor
              guildId={selectedId!}
              guildName={meta.name}
              meta={meta}
              onRefresh={async () => {
                const serverMeta = await api<Meta>(`/api/guilds/${selectedId}/meta`);
                setMeta(serverMeta);
                setPanelChannel((current) =>
                  serverMeta.channels.some((channel) => channel.id === current)
                    ? current
                    : serverMeta.channels[0]?.id ?? ""
                );
              }}
              onNotice={flash}
              onError={fail}
            />

            <section className="metric-grid">
              <article className="metric card">
                <span>SECURITY</span>
                <strong>{settings.securityEnabled ? "ACTIVE" : "OFF"}</strong>
                <small>Discord AutoMod + Audit protection</small>
              </article>
              <article className="metric card">
                <span>VERIFICATION</span>
                <strong>{settings.verifiedRoleId ? "READY" : "SETUP"}</strong>
                <small>Challenge + account age</small>
              </article>
              <article className="metric card">
                <span>CHANNELS</span>
                <strong>{meta.channels.length}</strong>
                <small>Text / Voice / Forum</small>
              </article>
              <article className="metric card">
                <span>CATEGORIES</span>
                <strong>{meta.categories.length}</strong>
                <small>Live server structure</small>
              </article>
            </section>

            <section className="two-col">
              <article className="card">
                <div className="section-head">
                  <div>
                    <span className="eyebrow">SECURITY</span>
                    <h2>セキュリティ</h2>
                  </div>
                  <button className="primary" onClick={() => void saveSettings()}>
                    設定を保存
                  </button>
                </div>

                <div className="toggle-stack">
                  <Toggle
                    checked={settings.securityEnabled}
                    onChange={(value) => setSettings({ ...settings, securityEnabled: value })}
                    title="Security Engine"
                    description="全セキュリティ機能のマスタースイッチ"
                  />
                  <Toggle
                    checked={settings.antiSpam}
                    onChange={(value) => setSettings({ ...settings, antiSpam: value })}
                    title="Anti-Spam"
                    description="Discord AutoMod側で24時間スパムをブロック"
                  />
                  <Toggle
                    checked={settings.blockInvites}
                    onChange={(value) => setSettings({ ...settings, blockInvites: value })}
                    title="Invite Guard"
                    description="外部Discord招待リンクをブロック"
                  />
                  <Toggle
                    checked={settings.antiNuke}
                    onChange={(value) => setSettings({ ...settings, antiNuke: value })}
                    title="Anti-Nuke"
                    description="Cloudflare Cronで監査ログを監視し大量破壊を検知"
                  />
                </div>

                <div className="serverless-note">
                  <strong>Anti-Raidについて</strong>
                  <span>
                    常駐Gatewayを使わない0円構成のため、参加イベント監視はDiscord標準の
                    Raid Protectionを使用します。Spam・大量メンション・招待リンクはAutoMod、
                    大量破壊は下のAnti-Nukeで保護します。
                  </span>
                </div>

                <div className="form-grid three">
                  <Field label="メンション上限">
                    <input
                      type="number"
                      value={settings.mentionLimit}
                      onChange={(e) =>
                        setSettings({ ...settings, mentionLimit: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Nuke操作回数">
                    <input
                      type="number"
                      value={settings.nukeActions}
                      onChange={(e) =>
                        setSettings({ ...settings, nukeActions: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>

                <div className="form-grid two">
                  <Field label="セキュリティログ">
                    <select
                      value={settings.logChannelId ?? ""}
                      onChange={(e) =>
                        setSettings({ ...settings, logChannelId: e.target.value || null })
                      }
                    >
                      <option value="">システムチャンネル / 未設定</option>
                      {meta.channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>#{channel.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Nuke監視秒">
                    <input
                      type="number"
                      value={settings.nukeWindowSeconds}
                      onChange={(e) =>
                        setSettings({ ...settings, nukeWindowSeconds: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label="信頼ユーザーID" hint="カンマ区切り">
                    <input
                      value={settings.trustedUserIds.join(",")}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          trustedUserIds: e.target.value.split(",").map((v) => v.trim()).filter(Boolean)
                        })
                      }
                    />
                  </Field>
                  <Field label="信頼ロールID" hint="カンマ区切り">
                    <input
                      value={settings.trustedRoleIds.join(",")}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          trustedRoleIds: e.target.value.split(",").map((v) => v.trim()).filter(Boolean)
                        })
                      }
                    />
                  </Field>
                </div>
              </article>

              <div className="stack">
                <article className="card">
                  <div className="section-head">
                    <div>
                      <span className="eyebrow">VERIFICATION</span>
                      <h2>認証</h2>
                    </div>
                  </div>
                  <div className="form-grid two">
                    <Field label="認証後ロール">
                      <select
                        value={settings.verifiedRoleId ?? ""}
                        onChange={(e) =>
                          setSettings({ ...settings, verifiedRoleId: e.target.value || null })
                        }
                      >
                        <option value="">ロールを選択</option>
                        {meta.roles.map((role) => (
                          <option key={role.id} value={role.id}>@{role.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="最低アカウント日数">
                      <input
                        type="number"
                        value={settings.minAccountAgeDays}
                        onChange={(e) =>
                          setSettings({ ...settings, minAccountAgeDays: Number(e.target.value) })
                        }
                      />
                    </Field>
                  </div>
                  <Field label="パネル設置チャンネル">
                    <select value={panelChannel} onChange={(e) => setPanelChannel(e.target.value)}>
                      {meta.channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>#{channel.name}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="button-row">
                    <button className="primary" onClick={() => void postPanel("verification")}>
                      認証パネルを設置
                    </button>
                    <button className="secondary" onClick={() => void postPanel("tickets")}>
                      Ticketパネルを設置
                    </button>
                  </div>
                </article>

                <article className="card">
                  <span className="eyebrow">QUICK TEMPLATES</span>
                  <h2>一括テンプレート</h2>
                  <p className="muted">必要な時だけ、基本構成を一気に追加できます。</p>
                  <div className="template-grid">
                    <button onClick={() => void applyTemplate("community")}>
                      <strong>Community</strong>
                      <small>Welcome / Rules / General / Staff</small>
                    </button>
                    <button onClick={() => void applyTemplate("shop")}>
                      <strong>Shop</strong>
                      <small>Products / Orders / Support</small>
                    </button>
                    <button onClick={() => void applyTemplate("support")}>
                      <strong>Support</strong>
                      <small>FAQ / Ticket / Staff</small>
                    </button>
                  </div>
                </article>
              </div>
            </section>

            <VendingManager
              guildId={selectedId!}
              channels={meta.channels}
              roles={meta.roles}
              onNotice={flash}
              onError={fail}
            />

          </>
        )}
      </main>
    </div>
  );
}
