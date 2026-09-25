import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, api, clearSession, currentSession, login } from "./api";
import ServerEditor from "./ServerEditor";
import RoleManager from "./RoleManager";
import VendingManager from "./VendingManager";
import BackupManager from "./BackupManager";
import MemberActivityManager from "./MemberActivityManager";

type User = { id: string; username: string; avatar: string | null };
type Guild = {
  id: string;
  name: string;
  icon: string | null;
  botInstalled: true;
};
type Meta = {
  id: string;
  name: string;
  icon: string | null;
  botAdministrator?: boolean;
  botAccessRepair?: {
    administrator: boolean;
    checked: number;
    repaired: number;
    failed: Array<{ id: string; name: string; status: number }>;
  };
  channels: Array<{
    id: string;
    name: string;
    type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
    parentId?: string | null;
    topic?: string;
    position?: number;
    botCanView?: boolean;
    botCanPost?: boolean;
    permissionOverwrites?: Array<{
      id: string;
      type: number;
      allow: string;
      deny: string;
    }>;
  }>;
  categories: Array<{ id: string; name: string; position?: number }>;
  roles: Array<{
    id: string;
    name: string;
    position: number;
    color: number;
    permissions: string;
    isEveryone: boolean;
  }>;
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
  ticketSupportRoleIds: string[];
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
  discordUser?: string | null;
  discordError?: string | null;
  guildCount?: number | null;
  dashboardPasswordConfigured: boolean;
  payPayConfigured: boolean;
  payPayEnvironment: string;
  inviteUrl: string;
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
  const [password, setPassword] = useState("");
  const [me, setMe] = useState<User | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"server" | "members" | "verification" | "tickets" | "vending" | "backup">("server");
  const [meta, setMeta] = useState<Meta | null>(null);
  const selectedGuildRef = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const savingSettings = useRef(false);
  const [trustedUsersText,setTrustedUsersText] = useState("");
  const [trustedRolesText,setTrustedRolesText] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [verificationPanelChannel, setVerificationPanelChannel] = useState("");
  const [ticketPanelChannel, setTicketPanelChannel] = useState("");
  const [productPanelChannel, setProductPanelChannel] = useState("");
  const [productForm, setProductForm] = useState(emptyProduct);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelAction, setPanelAction] = useState<"verification" | "tickets" | null>(null);
  const [verificationPanelFeedback, setVerificationPanelFeedback] = useState<{
    kind: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [ticketPanelFeedback, setTicketPanelFeedback] = useState<{
    kind: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const selectedGuild = useMemo(
    () => guilds.find((guild) => guild.id === selectedId) ?? null,
    [guilds, selectedId]
  );

  const selectedVerificationChannel = useMemo(
    () => meta?.channels.find((channel) => channel.id === verificationPanelChannel) ?? null,
    [meta, verificationPanelChannel]
  );

  const selectedTicketChannel = useMemo(
    () => meta?.channels.find((channel) => channel.id === ticketPanelChannel) ?? null,
    [meta, ticketPanelChannel]
  );

  const botAuthorizeUrl = useMemo(() => {
    if (!status?.inviteUrl) return "";
    if (!selectedId) return status.inviteUrl;
    const separator = status.inviteUrl.includes("?") ? "&" : "?";
    return (
      status.inviteUrl +
      separator +
      "guild_id=" +
      encodeURIComponent(selectedId) +
      "&disable_guild_select=true"
    );
  }, [status?.inviteUrl, selectedId]);

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
    setError(null);
    try {
      const service = await api<ServiceStatus>("/api/status");
      setStatus(service);

      const user = await api<User>("/api/me");
      setMe(user);

      try {
        const serverList = await api<Guild[]>("/api/guilds");
        setGuilds(serverList);
        const firstGuild = serverList[0];
        if (!selectedId && firstGuild) {
          await selectGuild(firstGuild.id);
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setGuilds([]);
        setError("BOT参加サーバー一覧の取得に失敗しました: " + message);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError("管理画面の初期化に失敗しました: " + message);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function selectGuild(guildId: string) {
    const sequence=++loadSequence.current;
    selectedGuildRef.current=guildId;
    setSelectedId(guildId);
    setMeta(null);
    setSettings(null);
    setProducts([]);
    setVerificationPanelFeedback(null);
    setTicketPanelFeedback(null);
    setPanelAction(null);
    setBusy(true);
    setError(null);
    try {
      let serverMeta: Meta;
      try {
        serverMeta = await api<Meta>(`/api/guilds/${guildId}/meta`);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        throw new Error("サーバー構造の取得に失敗しました: " + message);
      }

      let serverSettings: Settings;
      try {
        serverSettings = await api<Settings>(`/api/guilds/${guildId}/settings`);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        throw new Error("サーバー設定の取得に失敗しました: " + message);
      }

      if(sequence!==loadSequence.current) return;
      setMeta(serverMeta);
      setSettings(serverSettings);
      setTrustedUsersText(serverSettings.trustedUserIds.join(","));
      setTrustedRolesText(serverSettings.trustedRoleIds.join(","));
      if (serverMeta.botAccessRepair && !serverMeta.botAccessRepair.administrator) {
        const repair = serverMeta.botAccessRepair;
        if (repair.failed.length > 0) {
          setError(
            `BOTアクセス保護を${repair.failed.length}件のチャンネル/カテゴリへ適用できませんでした。Discord側でBOTの「チャンネルを見る」を許可し、BOTロールの「チャンネルの管理」「ロールの管理」を確認してから再読み込みしてください。`
          );
        } else if (repair.repaired > 0) {
          setNotice(
            `BOTアクセス保護を${repair.repaired}件へ自動適用しました。@everyoneを制限してもBOTアクセスを維持します。`
          );
        }
      }
      const messageChannels = serverMeta.channels.filter(
        (channel) =>
          channel.type === "text" || channel.type === "announcement"
      );
      const firstPanelChannel =
        messageChannels.find((channel) => channel.botCanPost !== false)?.id ?? "";
      const firstMessageChannel = messageChannels[0]?.id ?? "";
      setVerificationPanelChannel(firstPanelChannel);
      setTicketPanelChannel(firstPanelChannel);
      setProductPanelChannel(firstMessageChannel);

      try {
        const rows=await api<Product[]>(`/api/guilds/${guildId}/products`);
        if(sequence===loadSequence.current) setProducts(rows);
      } catch (reason) {
        if(sequence!==loadSequence.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setProducts([]);
        setError("販売データの取得に失敗しました: " + message);
      }
    } catch (reason) {
      if(sequence===loadSequence.current) fail(reason);
    } finally {
      if(sequence===loadSequence.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (authenticated) void loadBase();
  }, [authenticated]);

  async function saveSettings(successMessage = "サーバー設定を保存しました") {
    if (!selectedId || !settings || savingSettings.current) return;
    const guildId=selectedId;
    const sequence=loadSequence.current;
    const submitted=settings;
    const payload={...settings,
      trustedUserIds:trustedUsersText.split(/[,、\s]+/).filter(Boolean),
      trustedRoleIds:trustedRolesText.split(/[,、\s]+/).filter(Boolean)
    };
    savingSettings.current=true;
    setBusy(true);
    try {
      const {applyWarnings=[],...saved} = await api<Settings & {applyWarnings?:string[]}>(`/api/guilds/${guildId}/settings`, {
        method: "PUT", body: JSON.stringify(payload)
      },60_000);
      if(selectedGuildRef.current!==guildId||sequence!==loadSequence.current) return;
      // Preserve edits made while the request was in flight.
      setSettings(current=>{
        if(!current) return current;
        const newer=Object.fromEntries(Object.entries(current).filter(([key,value])=>
          JSON.stringify(value)!==JSON.stringify(submitted[key as keyof Settings])
        ));
        return {...saved,...newer} as Settings;
      });
      if(applyWarnings.length) fail(applyWarnings.join("\n"));
      else flash(successMessage);
    } catch (reason) {
      if(selectedGuildRef.current===guildId&&sequence===loadSequence.current) fail(reason);
    } finally {
      savingSettings.current=false;
      if(selectedGuildRef.current===guildId&&sequence===loadSequence.current) setBusy(false);
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
    const label = kind === "verification" ? "認証パネル" : "Ticketパネル";
    const channelId =
      kind === "verification" ? verificationPanelChannel : ticketPanelChannel;
    const setFeedback =
      kind === "verification" ? setVerificationPanelFeedback : setTicketPanelFeedback;

    if (!selectedId) {
      setFeedback({ kind: "error", message: "サーバーを選択してください" });
      return;
    }
    if (!channelId) {
      setFeedback({
        kind: "error",
        message:
          "BOTが投稿できるテキストチャンネルがありません。BOT権限を更新してください"
      });
      return;
    }

    const selectedPanelChannel =
      meta?.channels.find((channel) => channel.id === channelId) ?? null;
    if (selectedPanelChannel?.botCanPost === false) {
      setFeedback({
        kind: "error",
        message:
          "このチャンネルではBOTの閲覧・送信・埋め込み権限が拒否されています。BOT権限を更新するか、投稿可能なチャンネルを選択してください"
      });
      return;
    }

    setBusy(true);
    setPanelAction(kind);
    setFeedback({ kind: "info", message: label + "をDiscordへ送信中..." });
    setError(null);
    try {
      await api(`/api/guilds/${selectedId}/${kind}/panel`, {
        method: "POST",
        body: JSON.stringify({ channelId })
      });
      const channelName =
        meta?.channels.find((channel) => channel.id === channelId)?.name ?? channelId;
      setFeedback({
        kind: "success",
        message: label + "を #" + channelName + " に設置しました"
      });
      flash(label + "を設置しました");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setFeedback({
        kind: "error",
        message: label + "の設置に失敗しました: " + message
      });
    } finally {
      setPanelAction(null);
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
          <h1>管理パスワードでアクセス</h1>
          <p>
            共同編集者は同じ管理パスワードでログインできます。
            BOTが参加しているDiscordサーバーだけが管理画面に表示されます。
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await login(password);
                setPassword("");
                setAuthenticated(true);
              } catch (reason) {
                const message = reason instanceof Error ? reason.message : String(reason);
                setError("ログインに失敗しました: " + message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="管理パスワード"
              autoComplete="current-password"
              required
            />
            <button className="primary big" type="submit" disabled={busy}>
              {busy ? "確認中..." : "管理画面へ"}
            </button>
          </form>
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
              onClick={() => void selectGuild(guild.id)}
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
                <small>BOT導入済み</small>
              </span>
              <span className="dot online" />
            </button>
          ))}
        </div>

        <div className="account">
          <div className="avatar">{me?.username?.slice(0, 1).toUpperCase() ?? "?"}</div>
          <div>
            <strong>{me?.username ?? "共同管理者"}</strong>
            <small>共同編集</small>
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
            {status?.inviteUrl && (
              <a className="primary" href={botAuthorizeUrl} target="_blank" rel="noreferrer">
                {selectedGuild ? "BOT権限を更新" : "BOTをサーバーへ追加"}
              </a>
            )}
            <span
              className={`status-pill ${status?.discordReady ? "good" : "bad"}`}
              title={status?.discordError ?? undefined}
            >
              <i /> BOT {status?.discordReady ? "Online" : "Offline"}
              {status?.discordReady && typeof status.guildCount === "number"
                ? ` · ${status.guildCount} server${status.guildCount === 1 ? "" : "s"}`
                : ""}
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
            <p>BOTを追加すると、参加済みサーバーがここに自動表示されます。</p>
            {status?.discordError && (
              <div className="alert error">
                Discord API: {status.discordError}
              </div>
            )}
            <button className="primary" onClick={() => void loadBase()} disabled={busy}>
              サーバー一覧を再読み込み
            </button>
          </section>
        )}

        {selectedGuild && meta && (
          <>
            <nav className="page-tabs" role="tablist" aria-label="管理機能">
              <button
                type="button"
                id="admin-tab-server"
                role="tab"
                aria-controls="admin-panel-server"
                aria-selected={activeView === "server"}
                className={activeView === "server" ? "active" : ""}
                onClick={() => setActiveView("server")}
              >
                サーバー管理
              </button>
              <button
                type="button"
                id="admin-tab-members"
                role="tab"
                aria-controls="admin-panel-members"
                aria-selected={activeView === "members"}
                className={activeView === "members" ? "active" : ""}
                onClick={() => setActiveView("members")}
              >
                入室管理
              </button>
              <button
                type="button"
                id="admin-tab-verification"
                role="tab"
                aria-controls="admin-panel-verification"
                aria-selected={activeView === "verification"}
                className={activeView === "verification" ? "active" : ""}
                onClick={() => setActiveView("verification")}
              >
                認証
              </button>
              <button
                type="button"
                id="admin-tab-tickets"
                role="tab"
                aria-controls="admin-panel-tickets"
                aria-selected={activeView === "tickets"}
                className={activeView === "tickets" ? "active" : ""}
                onClick={() => setActiveView("tickets")}
              >
                Ticket
              </button>
              <button
                type="button"
                id="admin-tab-vending"
                role="tab"
                aria-controls="admin-panel-vending"
                aria-selected={activeView === "vending"}
                className={activeView === "vending" ? "active" : ""}
                onClick={() => setActiveView("vending")}
              >
                自販機
              </button>
              <button
                type="button"
                id="admin-tab-backup"
                role="tab"
                aria-controls="admin-panel-backup"
                aria-selected={activeView === "backup"}
                className={activeView === "backup" ? "active" : ""}
                onClick={() => setActiveView("backup")}
              >
                バックアップ管理
              </button>
            </nav>

            {settings && (
              <>
                <section
                  id="admin-panel-server"
                  className="admin-tab-panel"
                  role="tabpanel"
                  aria-labelledby="admin-tab-server"
                  hidden={activeView !== "server"}
                >
                  <ServerEditor
                  key={"ServerEditor:"+selectedId}
                  guildId={selectedId!}
                  guildName={meta.name}
                  meta={meta}
                  onRefresh={async () => {
                  const serverMeta = await api<Meta>(`/api/guilds/${selectedId}/meta`);
                  if(selectedGuildRef.current!==selectedId) return;
                  setMeta(serverMeta);
                  const messageChannels = serverMeta.channels.filter((channel) =>
                  channel.type === "text" || channel.type === "announcement"
                  );
                  const postableChannels = messageChannels.filter(
                  (channel) => channel.botCanPost !== false
                  );
                  const keepOrFirst = (current: string) =>
                  postableChannels.some((channel) => channel.id === current)
                  ? current
                  : postableChannels[0]?.id ?? "";
                  setVerificationPanelChannel(keepOrFirst);
                  setTicketPanelChannel(keepOrFirst);
                  }}
                  onNotice={flash}
                  onError={fail}
                  />

                  <RoleManager
                  key={"RoleManager:"+selectedId}
                  guildId={selectedId!}
                  roles={meta.roles}
                  onRefresh={async () => {
                  const serverMeta = await api<Meta>(`/api/guilds/${selectedId}/meta`);
                  if(selectedGuildRef.current!==selectedId) return;
                  setMeta(serverMeta);
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
                  <small>Discord OAuth + account age + recovery</small>
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
                    <button className="primary" onClick={() => void saveSettings()} disabled={busy}>
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
                    value={trustedUsersText}
                    onChange={(e) => setTrustedUsersText(e.target.value)}
                    />
                    </Field>
                    <Field label="信頼ロールID" hint="カンマ区切り">
                    <input
                    value={trustedRolesText}
                    onChange={(e) => setTrustedRolesText(e.target.value)}
                    />
                    </Field>
                    </div>
                    </article>
                    <div className="stack">
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
                </section>

                <section
                  id="admin-panel-members"
                  className="admin-tab-panel"
                  role="tabpanel"
                  aria-labelledby="admin-tab-members"
                  hidden={activeView !== "members"}
                >
                  <MemberActivityManager
                    key={"MemberActivityManager:"+selectedId}
                    guildId={selectedId!}
                    channels={meta.channels}
                    onNotice={flash}
                    onError={fail}
                  />
                </section>

                <section
                  id="admin-panel-verification"
                  className="admin-tab-panel admin-focus-panel"
                  role="tabpanel"
                  aria-labelledby="admin-tab-verification"
                  hidden={activeView !== "verification"}
                >
                  <article className="card">
                  <div className="section-head">
                  <div>
                  <span className="eyebrow">VERIFICATION</span>
                  <h2>認証</h2>
                  </div>
                  <button
                  type="button"
                  className="secondary"
                  onClick={() => void saveSettings("認証設定を保存しました")}
                  disabled={busy}
                  >
                  認証設定を保存
                  </button>
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
                  <Field
                  label="認証パネル設置チャンネル"
                  hint="テキスト / アナウンスチャンネルに設置できます"
                  >
                  <select
                  value={verificationPanelChannel}
                  onChange={(e) => setVerificationPanelChannel(e.target.value)}
                  >
                  {meta.channels
                  .filter((channel) =>
                  channel.type === "text" || channel.type === "announcement"
                  )
                  .map((channel) => (
                  <option
                  key={channel.id}
                  value={channel.id}
                  disabled={channel.botCanPost === false}
                  >
                  #{channel.name}{channel.botCanPost === false ? " — BOTアクセス不可" : ""}
                  </option>
                  ))}
                  </select>
                  </Field>
                  <div className="button-row">
                  <button
                  type="button"
                  className="primary"
                  disabled={
                  panelAction !== null ||
                  !verificationPanelChannel ||
                  selectedVerificationChannel?.botCanPost === false
                  }
                  onClick={() => void postPanel("verification")}
                  >
                  {panelAction === "verification" ? "設置中..." : "認証パネルを設置"}
                  </button>
                  </div>
                  {verificationPanelFeedback && (
                  <div
                  className={
                  verificationPanelFeedback.kind === "success"
                  ? "panel-feedback success"
                  : verificationPanelFeedback.kind === "error"
                  ? "panel-feedback error"
                  : "panel-feedback info"
                  }
                  role="status"
                  aria-live="polite"
                  >
                  {verificationPanelFeedback.message}
                  </div>
                  )}
                  {status?.inviteUrl &&
                  (!verificationPanelChannel ||
                  selectedVerificationChannel?.botCanPost === false) && (
                  <a
                  className="secondary panel-permission-repair"
                  href={botAuthorizeUrl}
                  target="_blank"
                  rel="noreferrer"
                  >
                  BOT権限を更新
                  </a>
                  )}
                  </article>
                </section>

                <section
                  id="admin-panel-tickets"
                  className="admin-tab-panel admin-focus-panel"
                  role="tabpanel"
                  aria-labelledby="admin-tab-tickets"
                  hidden={activeView !== "tickets"}
                >
                  <article className="card">
                  <div className="section-head">
                  <div>
                  <span className="eyebrow">TICKETS</span>
                  <h2>Ticket</h2>
                  </div>
                  <button
                  type="button"
                  className="secondary"
                  onClick={() => void saveSettings("Ticket設定を保存しました")}
                  disabled={busy}
                  >
                  Ticket設定を保存
                  </button>
                  </div>
                  
                  <Field
                  label="Ticket対応者ロール"
                  hint="複数選択可能。選んだロール全員が作成されたTicketを閲覧・返信できます"
                  >
                  <div className="role-picker">
                  {meta.roles.length === 0 ? (
                  <span className="role-picker-empty">選択できるロールがありません</span>
                  ) : (
                  meta.roles.map((role) => {
                  const checked = settings.ticketSupportRoleIds.includes(role.id);
                  return (
                  <label
                  key={role.id}
                  className={`role-choice ${checked ? "selected" : ""}`}
                  >
                  <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                  const next = event.target.checked
                  ? [...settings.ticketSupportRoleIds, role.id]
                  : settings.ticketSupportRoleIds.filter((id) => id !== role.id);
                  setSettings({
                  ...settings,
                  ticketSupportRoleIds: [...new Set(next)]
                  });
                  }}
                  />
                  <span>@{role.name}</span>
                  </label>
                  );
                  })
                  )}
                  </div>
                  </Field>
                  
                  <Field
                  label="Ticketパネル設置チャンネル"
                  hint="認証パネルとは別のチャンネルを選べます"
                  >
                  <select
                  value={ticketPanelChannel}
                  onChange={(e) => setTicketPanelChannel(e.target.value)}
                  >
                  {meta.channels
                  .filter((channel) =>
                  channel.type === "text" || channel.type === "announcement"
                  )
                  .map((channel) => (
                  <option
                  key={channel.id}
                  value={channel.id}
                  disabled={channel.botCanPost === false}
                  >
                  #{channel.name}{channel.botCanPost === false ? " — BOTアクセス不可" : ""}
                  </option>
                  ))}
                  </select>
                  </Field>
                  
                  <div className="button-row">
                  <button
                  type="button"
                  className="primary"
                  disabled={
                  panelAction !== null ||
                  !ticketPanelChannel ||
                  selectedTicketChannel?.botCanPost === false
                  }
                  onClick={() => void postPanel("tickets")}
                  >
                  {panelAction === "tickets" ? "設置中..." : "Ticketパネルを設置"}
                  </button>
                  </div>
                  {ticketPanelFeedback && (
                  <div
                  className={
                  ticketPanelFeedback.kind === "success"
                  ? "panel-feedback success"
                  : ticketPanelFeedback.kind === "error"
                  ? "panel-feedback error"
                  : "panel-feedback info"
                  }
                  role="status"
                  aria-live="polite"
                  >
                  {ticketPanelFeedback.message}
                  </div>
                  )}
                  {status?.inviteUrl &&
                  (!ticketPanelChannel || selectedTicketChannel?.botCanPost === false) && (
                  <a
                  className="secondary panel-permission-repair"
                  href={botAuthorizeUrl}
                  target="_blank"
                  rel="noreferrer"
                  >
                  BOT権限を更新
                  </a>
                  )}
                  </article>
                </section>

                <section
                  id="admin-panel-vending"
                  className="admin-tab-panel"
                  role="tabpanel"
                  aria-labelledby="admin-tab-vending"
                  hidden={activeView !== "vending"}
                >
                  <VendingManager
                  key={"VendingManager:"+selectedId}
                  guildId={selectedId!}
                  channels={meta.channels}
                  roles={meta.roles}
                  onNotice={flash}
                  onError={fail}
                  />
                </section>
              </>
            )}

            <section
              id="admin-panel-backup"
              className="admin-tab-panel"
              role="tabpanel"
              aria-labelledby="admin-tab-backup"
              hidden={activeView !== "backup"}
            >
              <BackupManager
              key={"BackupManager:"+selectedId}
              guildId={selectedId!}
              channels={meta.channels}
              onNotice={flash}
              onError={fail}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
