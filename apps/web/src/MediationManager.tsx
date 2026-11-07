import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Channel = {
  id: string;
  name: string;
  type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
  parentId?: string | null;
  botCanPost?: boolean;
};
type Category = { id: string; name: string };
type Role = { id: string; name: string; isEveryone: boolean; position: number };

export type MediationSettings = {
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelTitle: string;
  panelDescription: string;
  feeAmount: number;
  staffRoleIds: string[];
  staffChannelId: string | null;
  categoryId: string | null;
  resultChannelId: string | null;
  resultChannelBase: string;
  resultRenameEnabled: boolean;
  resultPostEnabled: boolean;
  logChannelId: string | null;
  blacklistRoleIds: string[];
  minAccountAgeDays: number;
  minMemberDays: number;
  minAmount: number;
  maxAmount: number;
  autoAgreeHours: number;
  maxOpenTrades: number;
  cancelDeleteSeconds: number;
  closeDeleteMinutes: number;
};

type TradeRow = {
  id: number;
  number: number;
  channel_id: string | null;
  user_a: string;
  user_b: string;
  buyer_id: string | null;
  seller_id: string | null;
  amount: number | null;
  status: string;
  decision: string | null;
  report_reason: string | null;
  created_at: number;
  channel_deleted: number;
};

type Overview = {
  settings: MediationSettings;
  paypay: { registered: boolean };
  summary: {
    completed: number;
    active: number;
    disputes: number;
    manualPayouts: number;
    cancelled: number;
    feeCollected: number;
    volume: number;
  };
  trades: TradeRow[];
};

type Section = "panel" | "results" | "blacklist" | "payment";

const SECTIONS: Array<[Section, string]> = [
  ["panel", "パネル設置"],
  ["results", "実績"],
  ["blacklist", "ブラックリスト"],
  ["payment", "支払い"]
];

const STATUS_LABELS: Record<string, string> = {
  FEE: "仲介費待ち",
  FEE_RECEIVING: "仲介費確認中",
  AMOUNT: "金額合意待ち",
  ROLE: "役割選択待ち",
  PAYMENT: "送金待ち",
  CONFIRMING: "預かり確認中",
  TRADING: "受け渡し中",
  COMPLETE_PENDING: "完了同意待ち",
  DISPUTE: "通報・凍結中",
  PAYOUT: "支払い処理中",
  PAID: "受け取り待ち",
  CLOSED: "完了",
  CANCELLED: "中止"
};

const yen = (n: number | null | undefined) => "¥" + Number(n ?? 0).toLocaleString("ja-JP");

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  suffix
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  suffix?: string;
}) {
  return (
    <label className="field">
      <span>{label}{suffix ? `（${suffix}）` : ""}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Check({
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
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span />
      </span>
    </label>
  );
}

function RolePicker({
  roles,
  selected,
  onChange,
  empty
}: {
  roles: Role[];
  selected: string[];
  onChange: (next: string[]) => void;
  empty: string;
}) {
  if (roles.length === 0) return <div className="role-picker"><span className="role-picker-empty">{empty}</span></div>;
  return (
    <div className="role-picker">
      {roles.map((role) => {
        const checked = selected.includes(role.id);
        return (
          <label key={role.id} className={`role-choice ${checked ? "selected" : ""}`}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => {
                const next = event.target.checked ? [...selected, role.id] : selected.filter((id) => id !== role.id);
                onChange([...new Set(next)]);
              }}
            />
            <span>@{role.name}</span>
          </label>
        );
      })}
    </div>
  );
}

export default function MediationManager({
  guildId,
  channels,
  categories,
  roles,
  onNotice,
  onError
}: {
  guildId: string;
  channels: Channel[];
  categories: Category[];
  roles: Role[];
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
}) {
  const [section, setSection] = useState<Section>("panel");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<MediationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [panelChannel, setPanelChannel] = useState("");
  const [payForm, setPayForm] = useState({ phone: "", password: "", challengeId: "", otp: "" });

  const textChannels = useMemo(
    () => channels.filter((c) => c.type === "text" || c.type === "announcement" || c.type === undefined),
    [channels]
  );
  const postable = useMemo(() => textChannels.filter((c) => c.botCanPost !== false), [textChannels]);
  const pickableRoles = useMemo(
    () => roles.filter((r) => !r.isEveryone).sort((a, b) => b.position - a.position),
    [roles]
  );
  const channelName = (id: string | null) => (id ? "#" + (channels.find((c) => c.id === id)?.name ?? id) : "未設定");

  async function load() {
    const data = await api<Overview>(`/api/guilds/${guildId}/mediation`);
    setOverview(data);
    setDraft(data.settings);
    setPanelChannel((current) => current || data.settings.panelChannelId || postable[0]?.id || "");
  }

  useEffect(() => {
    void load().catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  const dirty = useMemo(
    () => Boolean(draft && overview && JSON.stringify(draft) !== JSON.stringify(overview.settings)),
    [draft, overview]
  );

  function patch(next: Partial<MediationSettings>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (reason) {
      onError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<MediationSettings | null> {
    if (!draft) return null;
    const result = await api<{ settings: MediationSettings }>(`/api/guilds/${guildId}/mediation/settings`, {
      method: "PUT",
      body: JSON.stringify(draft)
    });
    setOverview((current) => (current ? { ...current, settings: result.settings } : current));
    setDraft(result.settings);
    return result.settings;
  }

  const warnings: string[] = [];
  if (draft) {
    if (draft.staffRoleIds.length === 0) warnings.push("スタッフロールが未設定です（通報の判断・手動対応ができません）");
    if (!draft.staffChannelId) warnings.push("スタッフ通知チャンネルが未設定です（PayPay失敗時の手動対応通知が届きません）");
    if (!overview?.paypay.registered) warnings.push("運営PayPayが未ログインです（支払いタブからログインしてください）");
  }

  if (!draft || !overview) {
    return (
      <section className="card mediation-manager">
        <div className="section-head">
          <div>
            <span className="eyebrow">MEDIATION</span>
            <h2>仲介</h2>
            <p className="muted">読み込み中…</p>
          </div>
        </div>
      </section>
    );
  }

  const resultPreview = `${draft.resultChannelBase}ー実績${overview.summary.completed}件`;

  return (
    <section className="card mediation-manager" aria-busy={busy}>
      <div className="section-head">
        <div>
          <span className="eyebrow">MEDIATION</span>
          <h2>仲介</h2>
          <p className="muted">
            運営がPayPayで代金を預かり、両者の合意後に売り手へ支払う仲介botです。設定はこのサーバーにだけ反映されます。
          </p>
        </div>
        <div className="vending-payment-badges">
          <span className={`status-pill ${overview.paypay.registered ? "good" : "warn"}`}>
            <i /> PayPay {overview.paypay.registered ? "ログイン済み" : "未ログイン"}
          </span>
          <span className={`status-pill ${draft.panelMessageId ? "good" : "warn"}`}>
            <i /> パネル {draft.panelMessageId ? "設置済み" : "未設置"}
          </span>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="alert error" role="status">
          {warnings.map((w) => (
            <div key={w}>⚠️ {w}</div>
          ))}
        </div>
      )}

      <nav className="vending-section-nav" aria-label="仲介の管理メニュー">
        {SECTIONS.map(([id, label]) => (
          <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="button-row mediation-save-row">
        {dirty && <span className="vending-unsaved">● 未保存</span>}
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() => void run(async () => { await save(); onNotice("仲介の設定を保存しました"); })}
        >
          設定を保存
        </button>
        {dirty && (
          <button className="secondary" disabled={busy} onClick={() => setDraft(overview.settings)}>
            元に戻す
          </button>
        )}
      </div>

      {/* ① パネル設置 */}
      <div hidden={section !== "panel"} className="mediation-section">
        <div className="form-grid two">
          <label className="field">
            <span>パネルを設置するチャンネル</span>
            <select value={panelChannel} onChange={(e) => setPanelChannel(e.target.value)}>
              <option value="">選択してください</option>
              {postable.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
            <small>
              {draft.panelMessageId
                ? `現在のパネル: ${channelName(draft.panelChannelId)}`
                : "まだ設置していません"}
            </small>
          </label>
          <div className="field">
            <span>設置</span>
            <div className="button-row">
              <button
                className="primary"
                disabled={busy || !panelChannel}
                onClick={() =>
                  void run(async () => {
                    if (dirty) await save();
                    const result = await api<{ settings: MediationSettings; warning?: string | null }>(
                      `/api/guilds/${guildId}/mediation/panel`,
                      { method: "POST", body: JSON.stringify({ channelId: panelChannel }) }
                    );
                    setOverview((current) => (current ? { ...current, settings: result.settings } : current));
                    setDraft(result.settings);
                    onNotice(result.warning ? "パネルを設置しました。" + result.warning : "仲介パネルを設置しました");
                  })
                }
              >
                パネルを設置
              </button>
              <button
                className="secondary"
                disabled={busy || !draft.panelMessageId}
                onClick={() =>
                  void run(async () => {
                    if (dirty) await save();
                    await api(`/api/guilds/${guildId}/mediation/panel/update`, { method: "POST" });
                    onNotice("設置済みのパネルを最新の設定で更新しました");
                  })
                }
              >
                設置済みパネルを更新
              </button>
            </div>
            <small>未保存の設定は、設置・更新の前に自動で保存されます</small>
          </div>
        </div>

        <div className="form-grid two">
          <label className="field">
            <span>パネルのタイトル</span>
            <input value={draft.panelTitle} maxLength={256} onChange={(e) => patch({ panelTitle: e.target.value })} />
          </label>
          <NumberField
            label="仲介費"
            suffix="円"
            value={draft.feeAmount}
            min={0}
            onChange={(v) => patch({ feeAmount: v })}
            hint="0円にすると仲介費の段階をスキップします。変更は新しく始まる取引から反映されます"
          />
        </div>
        <label className="field">
          <span>パネルの説明文</span>
          <textarea
            rows={3}
            maxLength={3000}
            value={draft.panelDescription}
            onChange={(e) => patch({ panelDescription: e.target.value })}
          />
          <small>この下に、取引の流れ（仲介費の金額を含む）が自動で追記されます</small>
        </label>

        <div className="field">
          <span>スタッフロール（複数選択可）</span>
          <RolePicker
            roles={pickableRoles}
            selected={draft.staffRoleIds}
            onChange={(next) => patch({ staffRoleIds: next })}
            empty="選択できるロールがありません"
          />
          <small>
            取引チャンネルを閲覧でき、通報の判断・手動対応のボタンを押せます。通報時にメンションされます（ロールを「メンション可能」にするか、BOTに全ロールへのメンション権限を付けてください）
          </small>
        </div>

        <div className="form-grid two">
          <label className="field">
            <span>取引チャンネルを作るカテゴリ</span>
            <select value={draft.categoryId ?? ""} onChange={(e) => patch({ categoryId: e.target.value || null })}>
              <option value="">カテゴリなし（一番上に作成）</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <small>2人とスタッフ・BOTだけが見られるプライベートチャンネルを作ります</small>
          </label>
          <label className="field">
            <span>スタッフ通知チャンネル</span>
            <select value={draft.staffChannelId ?? ""} onChange={(e) => patch({ staffChannelId: e.target.value || null })}>
              <option value="">未設定</option>
              {postable.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
            <small>通報やPayPayの自動処理に失敗したとき、判断ボタン付きで通知します（スタッフだけが見られる部屋にしてください）</small>
          </label>
        </div>

        <details className="vending-advanced-settings">
          <summary>詳細設定</summary>
          <div className="form-grid three">
            <NumberField
              label="1人が同時に進められる取引数"
              value={draft.maxOpenTrades}
              min={0}
              max={50}
              onChange={(v) => patch({ maxOpenTrades: v })}
              hint="0で無制限"
            />
            <NumberField
              label="中止後にチャンネルを消すまで"
              suffix="秒"
              value={draft.cancelDeleteSeconds}
              min={0}
              onChange={(v) => patch({ cancelDeleteSeconds: v })}
              hint="削除は1分ごとの定期処理で行うため、最大1分ほど遅れます"
            />
            <NumberField
              label="完了後にチャンネルを消すまで"
              suffix="分"
              value={draft.closeDeleteMinutes}
              min={1}
              onChange={(v) => patch({ closeDeleteMinutes: v })}
              hint="受け取り忘れに備えた猶予です"
            />
          </div>
        </details>
      </div>

      {/* ② 実績 */}
      <div hidden={section !== "results"} className="mediation-section">
        <div className="mediation-stats">
          <span className="status-pill good"><i /> 完了 {overview.summary.completed} 件</span>
          <span className="status-pill"><i /> 進行中 {overview.summary.active} 件</span>
          <span className={`status-pill ${overview.summary.disputes ? "bad" : ""}`}><i /> 通報対応中 {overview.summary.disputes} 件</span>
          <span className={`status-pill ${overview.summary.manualPayouts ? "warn" : ""}`}><i /> 支払い処理中 {overview.summary.manualPayouts} 件</span>
          <span className="status-pill"><i /> 取引総額 {yen(overview.summary.volume)}</span>
          <span className="status-pill"><i /> 仲介費収入 {yen(overview.summary.feeCollected)}</span>
        </div>

        <div className="form-grid two">
          <label className="field">
            <span>実績を送る部屋</span>
            <select value={draft.resultChannelId ?? ""} onChange={(e) => patch({ resultChannelId: e.target.value || null })}>
              <option value="">送らない</option>
              {postable.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
            <small>両者合意で完了した取引を、2人をメンションして「ご利用ありがとうございました！」と投稿します</small>
          </label>
          <label className="field">
            <span>実績チャンネル名の前半</span>
            <input
              value={draft.resultChannelBase}
              maxLength={60}
              onChange={(e) => patch({ resultChannelBase: e.target.value })}
            />
            <small>プレビュー: {resultPreview}</small>
          </label>
        </div>
        <Check
          checked={draft.resultPostEnabled}
          onChange={(v) => patch({ resultPostEnabled: v })}
          title="完了した取引を投稿する"
          description="オフにすると、チャンネル名の件数だけを更新します"
        />
        <Check
          checked={draft.resultRenameEnabled}
          onChange={(v) => patch({ resultRenameEnabled: v })}
          title="チャンネル名に実績件数を表示する"
          description="Discordの制限（10分に2回まで）のため、5分以上あけて最新の件数に更新します"
        />
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy || !draft.resultChannelId}
            onClick={() =>
              void run(async () => {
                if (dirty) await save();
                await api(`/api/guilds/${guildId}/mediation/result/sync`, { method: "POST" });
                onNotice("チャンネル名の更新を予約しました（1分以内に反映されます）");
              })
            }
          >
            チャンネル名を今の件数に更新
          </button>
        </div>

        <label className="field">
          <span>取引ログの保存先</span>
          <select value={draft.logChannelId ?? ""} onChange={(e) => patch({ logChannelId: e.target.value || null })}>
            <option value="">保存しない</option>
            {postable.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
          <small>
            取引チャンネルを消す前に、全発言をテキストファイルにして投稿します（小さな添付ファイルも一緒に保存）。BOTの「Message Content Intent」をONにしてください
          </small>
        </label>

        <div className="mediation-trades">
          <h3>最近の取引</h3>
          {overview.trades.length === 0 ? (
            <p className="muted">まだ取引はありません。</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>番号</th>
                    <th>状態</th>
                    <th>金額</th>
                    <th>買い手 / 売り手</th>
                    <th>開始</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.trades.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {t.channel_id && !t.channel_deleted ? (
                          <a href={`https://discord.com/channels/${guildId}/${t.channel_id}`} target="_blank" rel="noreferrer">
                            #{String(t.number).padStart(4, "0")}
                          </a>
                        ) : (
                          "#" + String(t.number).padStart(4, "0")
                        )}
                      </td>
                      <td title={t.report_reason ?? t.decision ?? ""}>
                        {STATUS_LABELS[t.status] ?? t.status}
                        {t.decision ? `（${t.decision}）` : ""}
                      </td>
                      <td>{t.amount ? yen(t.amount) : "-"}</td>
                      <td>
                        <code>{t.buyer_id ?? t.user_a}</code> / <code>{t.seller_id ?? t.user_b}</code>
                      </td>
                      <td>{new Date(t.created_at).toLocaleString("ja-JP")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="button-row">
            <button className="secondary" disabled={busy} onClick={() => void run(load)}>再読み込み</button>
          </div>
        </div>
      </div>

      {/* ③ ブラックリスト */}
      <div hidden={section !== "blacklist"} className="mediation-section">
        <div className="field">
          <span>ブラックリストに追加するロール（複数選択可）</span>
          <RolePicker
            roles={pickableRoles}
            selected={draft.blacklistRoleIds}
            onChange={(next) => patch({ blacklistRoleIds: next })}
            empty="選択できるロールがありません"
          />
          <small>このロールを持つ人は取引を開始できず、取引相手にも選べません。付け外しはDiscordのロール操作だけで行えます</small>
        </div>
        <div className="form-grid two">
          <NumberField
            label="Discordアカウント作成からの日数"
            suffix="日以上"
            value={draft.minAccountAgeDays}
            min={0}
            onChange={(v) => patch({ minAccountAgeDays: v })}
            hint="作ったばかりの捨てアカウントを防ぎます。0で無効"
          />
          <NumberField
            label="サーバー参加からの日数"
            suffix="日以上"
            value={draft.minMemberDays}
            min={0}
            onChange={(v) => patch({ minMemberDays: v })}
            hint="参加直後の人の取引を防ぎます。0で無効"
          />
        </div>
      </div>

      {/* ④ 支払い */}
      <div hidden={section !== "payment"} className="mediation-section">
        <div className="mediation-paypay">
          <h3>運営PayPayアカウント</h3>
          <p className="muted">
            仲介費・代金の受け取りと、売り手への送金リンク作成に使います。自販機のPayPayとは別に、このサーバー専用で保存します（暗号化して保存）。
          </p>
          {overview.paypay.registered ? (
            <div className="button-row">
              <span className="status-pill good"><i /> ログイン済み</span>
              <button
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("保存されている運営PayPayのログイン情報を削除しますか？進行中の取引の受け取り・支払いが手動対応になります。")) return;
                  void run(async () => {
                    await api(`/api/guilds/${guildId}/mediation/paypay/logout`, { method: "POST" });
                    await load();
                    onNotice("運営PayPayからログアウトしました");
                  });
                }}
              >
                ログアウト
              </button>
            </div>
          ) : payForm.challengeId ? (
            <form
              className="button-row"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void run(async () => {
                  await api(`/api/guilds/${guildId}/mediation/paypay/login/verify`, {
                    method: "POST",
                    body: JSON.stringify({ challengeId: payForm.challengeId, otp: payForm.otp })
                  });
                  setPayForm({ phone: "", password: "", challengeId: "", otp: "" });
                  await load();
                  onNotice("運営PayPayにログインしました");
                });
              }}
            >
              <input
                value={payForm.otp}
                onChange={(e) => setPayForm({ ...payForm, otp: e.target.value })}
                placeholder="SMSの認証コード"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
              <button className="primary" type="submit" disabled={busy}>認証</button>
              <button className="secondary" type="button" onClick={() => setPayForm({ ...payForm, challengeId: "", otp: "" })}>
                やり直す
              </button>
            </form>
          ) : (
            <form
              className="button-row"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void run(async () => {
                  const result = await api<{ challengeId: string }>(`/api/guilds/${guildId}/mediation/paypay/login/start`, {
                    method: "POST",
                    body: JSON.stringify({ phone: payForm.phone, password: payForm.password })
                  });
                  setPayForm((current) => ({ ...current, challengeId: result.challengeId, otp: "" }));
                  onNotice("PayPayから届いたSMSの認証コードを入力してください");
                });
              }}
            >
              <input
                value={payForm.phone}
                onChange={(e) => setPayForm({ ...payForm, phone: e.target.value })}
                placeholder="PayPay 電話番号"
                autoComplete="username"
                required
              />
              <input
                type="password"
                value={payForm.password}
                onChange={(e) => setPayForm({ ...payForm, password: e.target.value })}
                placeholder="PayPay パスワード"
                autoComplete="current-password"
                required
              />
              <button className="primary" type="submit" disabled={busy}>ログイン</button>
            </form>
          )}
        </div>

        <div className="form-grid two">
          <NumberField
            label="取引金額の下限"
            suffix="円"
            value={draft.minAmount}
            min={1}
            onChange={(v) => patch({ minAmount: v })}
          />
          <NumberField
            label="取引金額の上限"
            suffix="円"
            value={draft.maxAmount}
            min={0}
            onChange={(v) => patch({ maxAmount: v })}
            hint="0で上限なし。凍結リスクに備えて上限を決めるのがおすすめです"
          />
        </div>

        <div className="alert">
          ⚠️ PayPayの非公式APIを使っています。仕様変更で突然動かなくなることや、運営アカウントが制限・凍結されることがあります。凍結されると預かり中の代金を動かせなくなるため、取引額の上限を決め、残高を溜めすぎないようにしてください。
          自動処理に失敗したときは、スタッフ通知チャンネルに手動対応のボタン付きで通知されます。
        </div>
      </div>
    </section>
  );
}
