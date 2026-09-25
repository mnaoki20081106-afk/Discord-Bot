import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Channel = {
  id: string;
  name: string;
  type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
  botCanPost?: boolean;
};

type MemberActivitySettings = {
  guildId: string;
  enabled: boolean;
  channelId: string | null;
  joinEnabled: boolean;
  leaveEnabled: boolean;
  initialized: boolean;
  lastScanAt: number | null;
  memberCount: number;
  lastError: string | null;
};

type Props = {
  guildId: string;
  channels: Channel[];
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
};

const EMPTY: MemberActivitySettings = {
  guildId: "",
  enabled: false,
  channelId: null,
  joinEnabled: true,
  leaveEnabled: true,
  initialized: false,
  lastScanAt: null,
  memberCount: 0,
  lastError: null
};

function formatScanTime(value: number | null): string {
  if (!value) return "まだ取得していません";
  return new Date(value).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour12: false
  });
}

export default function MemberActivityManager({
  guildId,
  channels,
  onNotice,
  onError
}: Props) {
  const [settings, setSettings] = useState<MemberActivitySettings>({
    ...EMPTY,
    guildId
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const messageChannels = useMemo(
    () =>
      channels.filter(
        channel =>
          channel.type === "text" || channel.type === "announcement"
      ),
    [channels]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<MemberActivitySettings>(
      `/api/guilds/${guildId}/member-activity`
    )
      .then(data => {
        if (cancelled) return;
        setSettings(data);
      })
      .catch(reason => {
        if (!cancelled) onError(reason);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, onError]);

  function patch(next: Partial<MemberActivitySettings>) {
    setSettings(current => ({ ...current, ...next }));
  }

  async function save() {
    if (settings.enabled && !settings.channelId) {
      onError(new Error("通知先チャンネルを選択してください"));
      return;
    }
    setSaving(true);
    try {
      const saved = await api<MemberActivitySettings>(
        `/api/guilds/${guildId}/member-activity`,
        {
          method: "PUT",
          body: JSON.stringify({
            enabled: settings.enabled,
            channelId: settings.channelId,
            joinEnabled: settings.joinEnabled,
            leaveEnabled: settings.leaveEnabled
          })
        },
        60_000
      );
      setSettings(saved);
      onNotice(
        saved.enabled
          ? "入退室通知を保存しました。初回メンバー情報も取得済みです"
          : "入退室通知をオフにしました"
      );
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function testNotification() {
    if (!settings.channelId) {
      onError(new Error("通知先チャンネルを選択してください"));
      return;
    }
    setTesting(true);
    try {
      await api(
        `/api/guilds/${guildId}/member-activity/test`,
        {
          method: "POST",
          body: JSON.stringify({ channelId: settings.channelId })
        },
        30_000
      );
      onNotice("入室・退室のテスト通知を送信しました");
    } catch (reason) {
      onError(reason);
    } finally {
      setTesting(false);
    }
  }

  const selectedChannel = messageChannels.find(
    channel => channel.id === settings.channelId
  );

  return (
    <div className="member-activity-manager">
      <article className="card member-activity-hero">
        <div className="section-head">
          <div>
            <span className="eyebrow">MEMBER ACTIVITY</span>
            <h2>入室管理</h2>
            <p className="muted">
              サーバーへの参加・退出を指定チャンネルへ通知します。
            </p>
          </div>
          <span
            className={
              settings.enabled
                ? "member-activity-state on"
                : "member-activity-state"
            }
          >
            {settings.enabled ? "通知 ON" : "通知 OFF"}
          </span>
        </div>

        <div className="member-activity-status-grid">
          <div>
            <span>現在の取得人数</span>
            <strong>{settings.memberCount.toLocaleString("ja-JP")}人</strong>
          </div>
          <div>
            <span>最終取得</span>
            <strong>{formatScanTime(settings.lastScanAt)}</strong>
          </div>
          <div>
            <span>初期化</span>
            <strong>{settings.initialized ? "完了" : "未完了"}</strong>
          </div>
        </div>

        {settings.lastError && (
          <div className="panel-feedback error" role="status">
            最終取得エラー: {settings.lastError}
          </div>
        )}

        <div className="member-activity-config">
          <label className="member-activity-toggle">
            <div>
              <strong>入退室通知を有効化</strong>
              <small>
                1分ごとの巡回でメンバー差分を確認して通知します。
              </small>
            </div>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={event => patch({ enabled: event.target.checked })}
            />
          </label>

          <label className="field">
            <span>通知先チャンネル</span>
            <select
              value={settings.channelId ?? ""}
              onChange={event =>
                patch({ channelId: event.target.value || null })
              }
            >
              <option value="">チャンネルを選択</option>
              {messageChannels.map(channel => (
                <option
                  key={channel.id}
                  value={channel.id}
                  disabled={channel.botCanPost === false}
                >
                  #{channel.name}
                  {channel.botCanPost === false ? " — BOTアクセス不可" : ""}
                </option>
              ))}
            </select>
            <small>
              BOTに「チャンネルを見る・メッセージを送信・リンクを埋め込む」が必要です。
            </small>
          </label>

          <div className="member-activity-options">
            <label>
              <input
                type="checkbox"
                checked={settings.joinEnabled}
                onChange={event =>
                  patch({ joinEnabled: event.target.checked })
                }
              />
              <span>
                <strong>入室通知</strong>
                <small>緑色の通知を送信</small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.leaveEnabled}
                onChange={event =>
                  patch({ leaveEnabled: event.target.checked })
                }
              />
              <span>
                <strong>退室通知</strong>
                <small>赤色の通知を送信</small>
              </span>
            </label>
          </div>

          <div className="member-activity-note">
            <strong>Server Members Intent が必要です</strong>
            <span>
              Discord Developer Portal の Bot 設定で Server Members Intent
              を有効にしてください。無効な場合はメンバー一覧を取得できません。
            </span>
          </div>

          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={loading || saving}
            >
              {saving ? "保存・初期化中..." : "設定を保存"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void testNotification()}
              disabled={
                loading ||
                testing ||
                !settings.channelId ||
                selectedChannel?.botCanPost === false
              }
            >
              {testing ? "送信中..." : "通知テスト"}
            </button>
          </div>
        </div>
      </article>

      <section className="member-activity-preview-grid" aria-label="通知プレビュー">
        <article className="member-activity-preview join">
          <div className="member-activity-preview-head">
            <span className="member-activity-avatar">入</span>
            <div>
              <strong>ユーザー名</strong>
              <small>入室通知プレビュー</small>
            </div>
          </div>
          <p>
            <span className="mention">@ユーザー名</span> がサーバーに参加しました
          </p>
          <div className="member-activity-preview-field">
            <strong>🕰️ アカウント作成からの経過</strong>
            <span>2026-01-01 12:00:00 JST</span>
            <span>経過: 267日 10時間 00分</span>
          </div>
          <div className="member-activity-preview-field">
            <strong>👥 現在のサーバー人数</strong>
            <span>{Math.max(settings.memberCount, 1).toLocaleString("ja-JP")}</span>
          </div>
        </article>

        <article className="member-activity-preview leave">
          <div className="member-activity-preview-head">
            <span className="member-activity-avatar">退</span>
            <div>
              <strong>ユーザー名</strong>
              <small>退室通知プレビュー</small>
            </div>
          </div>
          <p>
            <span className="mention">@ユーザー名</span> がサーバーから退出しました
          </p>
          <div className="member-activity-preview-field">
            <strong>🕰️ アカウント作成からの経過</strong>
            <span>2026-01-01 12:00:00 JST</span>
            <span>経過: 267日 10時間 00分</span>
          </div>
          <div className="member-activity-preview-field">
            <strong>👥 現在のサーバー人数</strong>
            <span>{Math.max(settings.memberCount - 1, 0).toLocaleString("ja-JP")}</span>
          </div>
        </article>
      </section>
    </div>
  );
}
