import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

export type ServerEditorMeta = {
  channels: Array<{
    id: string;
    name: string;
    type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
    parentId?: string | null;
    topic?: string;
    position?: number;
    permissionOverwrites?: Array<{
      id: string;
      type: number;
      allow: string;
      deny: string;
    }>;
  }>;
  categories: Array<{
    id: string;
    name: string;
    position?: number;
  }>;
  roles: Array<{
    id: string;
    name: string;
    position: number;
  }>;
};

type PermissionMode = "inherit" | "allow" | "deny";
type PermissionKey =
  | "view"
  | "send"
  | "react"
  | "files"
  | "threads"
  | "connect"
  | "speak";

const PERMISSION_BITS: Record<PermissionKey, bigint> = {
  view: 1024n,
  send: 2048n,
  react: 64n,
  files: 32768n,
  threads: 34359738368n,
  connect: 1048576n,
  speak: 2097152n
};

const TEXT_PERMISSION_ROWS: Array<{ key: PermissionKey; label: string }> = [
  { key: "view", label: "閲覧" },
  { key: "send", label: "発言 / 投稿" },
  { key: "react", label: "リアクション" },
  { key: "files", label: "ファイル送信" },
  { key: "threads", label: "スレッド作成" }
];

const VOICE_PERMISSION_ROWS: Array<{ key: PermissionKey; label: string }> = [
  { key: "view", label: "閲覧" },
  { key: "connect", label: "接続" },
  { key: "speak", label: "発言" }
];

const EMPTY_PERMISSION_DRAFT: Record<PermissionKey, PermissionMode> = {
  view: "inherit",
  send: "inherit",
  react: "inherit",
  files: "inherit",
  threads: "inherit",
  connect: "inherit",
  speak: "inherit"
};

function permissionMode(
  channel: ServerEditorMeta["channels"][number],
  targetId: string,
  key: PermissionKey
): PermissionMode {
  const overwrite = channel.permissionOverwrites?.find(
    (item) => item.id === targetId && item.type === 0
  );
  if (!overwrite) return "inherit";
  const bit = PERMISSION_BITS[key];
  const allow = BigInt(overwrite.allow || "0");
  const deny = BigInt(overwrite.deny || "0");
  if ((allow & bit) === bit) return "allow";
  if ((deny & bit) === bit) return "deny";
  return "inherit";
}

function draftFor(
  channel: ServerEditorMeta["channels"][number],
  targetId: string
): Record<PermissionKey, PermissionMode> {
  return {
    view: permissionMode(channel, targetId, "view"),
    send: permissionMode(channel, targetId, "send"),
    react: permissionMode(channel, targetId, "react"),
    files: permissionMode(channel, targetId, "files"),
    threads: permissionMode(channel, targetId, "threads"),
    connect: permissionMode(channel, targetId, "connect"),
    speak: permissionMode(channel, targetId, "speak")
  };
}

type TouchDropTarget =
  | { kind: "channel"; id: string; placement: "before" | "after" }
  | { kind: "category"; id: string }
  | { kind: "uncategorized" }
  | null;

type TouchGesture = {
  channelId: string;
  identifier: number;
  startX: number;
  startY: number;
  timer: number;
};

type Selection =
  | { kind: "channel"; id: string }
  | { kind: "category"; id: string }
  | { kind: "create"; type: "text" | "voice" | "category"; parentId: string | null }
  | null;

type Props = {
  guildId: string;
  guildName: string;
  meta: ServerEditorMeta;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
};

export default function ServerEditor({
  guildId,
  guildName,
  meta,
  onRefresh,
  onNotice,
  onError
}: Props) {
  const [selection, setSelection] = useState<Selection>(null);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [parentId, setParentId] = useState("");
  const [createType, setCreateType] = useState<"text" | "voice" | "category">("text");
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<
    { kind: "channel" | "category"; id: string } | null
  >(null);
  const [pressingChannelId, setPressingChannelId] = useState<string | null>(null);
  const [touchDraggingId, setTouchDraggingId] = useState<string | null>(null);
  const [touchDropTarget, setTouchDropTarget] = useState<TouchDropTarget>(null);
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const touchDraggingIdRef = useRef<string | null>(null);
  const touchDropTargetRef = useRef<TouchDropTarget>(null);
  const suppressClickUntilRef = useRef(0);
  const channelScrollRef = useRef<HTMLDivElement | null>(null);
  const [permissionTargetId, setPermissionTargetId] = useState(guildId);
  const [permissionDraft, setPermissionDraft] =
    useState<Record<PermissionKey, PermissionMode>>(EMPTY_PERMISSION_DRAFT);
  const [showPermissionBadges, setShowPermissionBadges] = useState(
    () => localStorage.getItem("dsm_show_permission_badges") !== "0"
  );

  const selectedChannel = useMemo(
    () =>
      selection?.kind === "channel"
        ? meta.channels.find((channel) => channel.id === selection.id) ?? null
        : null,
    [selection, meta.channels]
  );

  const selectedCategory = useMemo(
    () =>
      selection?.kind === "category"
        ? meta.categories.find((category) => category.id === selection.id) ?? null
        : null,
    [selection, meta.categories]
  );

  const uncategorized = useMemo(
    () => meta.channels.filter((channel) => !channel.parentId),
    [meta.channels]
  );

  function openChannel(id: string) {
    const channel = meta.channels.find((item) => item.id === id);
    if (!channel) return;
    setSelection({ kind: "channel", id });
    setName(channel.name);
    setTopic(channel.topic ?? "");
    setParentId(channel.parentId ?? "");
    setPermissionTargetId(guildId);
    setPermissionDraft(draftFor(channel, guildId));
  }

  function openCategory(id: string) {
    const category = meta.categories.find((item) => item.id === id);
    if (!category) return;
    setSelection({ kind: "category", id });
    setName(category.name);
    setTopic("");
    setParentId("");
  }

  function openCreate(parent: string | null = null, type: "text" | "voice" | "category" = "text") {
    setSelection({ kind: "create", parentId: parent, type });
    setCreateType(type);
    setName("");
    setTopic("");
    setParentId(parent ?? "");
  }

  async function savePermissions() {
    if (!selectedChannel) return;
    setSaving(true);
    try {
      await api(
        `/api/guilds/${guildId}/channels/${selectedChannel.id}/permissions/${permissionTargetId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            targetType: "role",
            permissions: permissionDraft
          })
        }
      );
      await onRefresh();
      onNotice("チャンネル権限を保存しました");
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  function renderPermissionBadge(channel: ServerEditorMeta["channels"][number]) {
    if (!showPermissionBadges) return null;
    const key: PermissionKey =
      channel.type === "voice" || channel.type === "stage" ? "speak" : "send";
    const mode = permissionMode(channel, guildId, key);
    const label =
      mode === "allow" ? "発言 可" : mode === "deny" ? "発言 不可" : "発言 継承";
    return <span className={`permission-badge ${mode}`}>{label}</span>;
  }

  async function saveExisting(event: FormEvent) {
    event.preventDefault();
    if (!selection || selection.kind === "create" || !name.trim()) return;
    setSaving(true);
    try {
      const body =
        selection.kind === "category"
          ? { name: name.trim() }
          : {
              name: name.trim(),
              parentId: parentId || null,
              ...(selectedChannel &&
              ["text", "announcement", "forum", "media"].includes(selectedChannel.type ?? "text")
                ? { topic }
                : {})
            };

      await api(`/api/guilds/${guildId}/channels/${selection.id}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      });
      await onRefresh();
      onNotice(selection.kind === "category" ? "カテゴリを更新しました" : "チャンネルを更新しました");
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function createItem(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api(`/api/guilds/${guildId}/channels`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          type: createType,
          parentId: createType === "category" ? null : parentId || null,
          topic: createType === "text" ? topic : undefined
        })
      });
      await onRefresh();
      setSelection(null);
      setName("");
      setTopic("");
      setParentId("");
      onNotice(createType === "category" ? "カテゴリを追加しました" : "チャンネルを追加しました");
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelected() {
    if (!selection || selection.kind === "create") return;
    const label = selection.kind === "category" ? "カテゴリ" : "チャンネル";
    if (!window.confirm(`${label}「${name}」を削除しますか？`)) return;
    setSaving(true);
    try {
      await api(`/api/guilds/${guildId}/channels/${selection.id}`, {
        method: "DELETE"
      });
      setSelection(null);
      await onRefresh();
      onNotice(`${label}を削除しました`);
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function reorderItem(
    id: string,
    position: number,
    nextParentId?: string | null
  ) {
    setSaving(true);
    try {
      await api(`/api/guilds/${guildId}/channels/reorder`, {
        method: "PATCH",
        body: JSON.stringify({
          id,
          position,
          ...(nextParentId !== undefined ? { parentId: nextParentId } : {})
        })
      });
      await onRefresh();
      onNotice("並び順を更新しました");
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
      setDragging(null);
    }
  }

  function dropOnChannel(target: ServerEditorMeta["channels"][number]) {
    if (!dragging || dragging.kind !== "channel" || dragging.id === target.id) {
      setDragging(null);
      return;
    }
    void reorderItem(
      dragging.id,
      target.position ?? 0,
      target.parentId ?? null
    );
  }

  function dropOnCategory(target: ServerEditorMeta["categories"][number]) {
    if (!dragging) return;
    if (dragging.kind === "category") {
      if (dragging.id !== target.id) {
        void reorderItem(dragging.id, target.position ?? 0);
      } else {
        setDragging(null);
      }
      return;
    }

    const firstChild = meta.channels
      .filter((channel) => channel.parentId === target.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];

    void reorderItem(
      dragging.id,
      firstChild?.position ?? (target.position ?? 0) + 1,
      target.id
    );
  }

  function dropUncategorized() {
    if (!dragging || dragging.kind !== "channel") {
      setDragging(null);
      return;
    }
    const first = uncategorized[0];
    void reorderItem(dragging.id, first?.position ?? 0, null);
  }

  function clearPendingTouch() {
    const gesture = touchGestureRef.current;
    if (gesture) window.clearTimeout(gesture.timer);
    touchGestureRef.current = null;
    setPressingChannelId(null);
  }

  function startChannelLongPress(
    event: React.TouchEvent<HTMLButtonElement>,
    channelId: string
  ) {
    if (event.touches.length !== 1 || saving) return;
    clearPendingTouch();
    const touch = event.touches[0]!;
    const gesture: TouchGesture = {
      channelId,
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      timer: 0
    };
    gesture.timer = window.setTimeout(() => {
      if (touchGestureRef.current !== gesture) return;
      touchDraggingIdRef.current = channelId;
      setTouchDraggingId(channelId);
      setDragging({ kind: "channel", id: channelId });
      setPressingChannelId(null);
      suppressClickUntilRef.current = Date.now() + 700;
    }, 450);
    touchGestureRef.current = gesture;
    setPressingChannelId(channelId);
  }

  function trackPendingLongPress(event: React.TouchEvent<HTMLButtonElement>) {
    const gesture = touchGestureRef.current;
    if (!gesture || touchDraggingIdRef.current) return;
    const touch = Array.from(event.touches).find(
      (item) => item.identifier === gesture.identifier
    );
    if (!touch) return;
    const distance = Math.hypot(
      touch.clientX - gesture.startX,
      touch.clientY - gesture.startY
    );
    if (distance > 10) clearPendingTouch();
  }

  function endPendingLongPress() {
    if (touchDraggingIdRef.current) return;
    clearPendingTouch();
  }

  function updateTouchDropTarget(clientX: number, clientY: number) {
    const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!element) return;

    const channelElement = element.closest<HTMLElement>("[data-channel-id]");
    if (channelElement?.dataset.channelId) {
      const targetId = channelElement.dataset.channelId;
      if (targetId === touchDraggingIdRef.current) {
        touchDropTargetRef.current = null;
        setTouchDropTarget(null);
        return;
      }
      const rect = channelElement.getBoundingClientRect();
      const next: TouchDropTarget = {
        kind: "channel",
        id: targetId,
        placement: clientY < rect.top + rect.height / 2 ? "before" : "after"
      };
      touchDropTargetRef.current = next;
      setTouchDropTarget(next);
      return;
    }

    const uncategorizedElement = element.closest<HTMLElement>(
      "[data-uncategorized-drop]"
    );
    if (uncategorizedElement) {
      const next: TouchDropTarget = { kind: "uncategorized" };
      touchDropTargetRef.current = next;
      setTouchDropTarget(next);
      return;
    }

    const categoryElement = element.closest<HTMLElement>("[data-category-id]");
    if (categoryElement?.dataset.categoryId) {
      const next: TouchDropTarget = {
        kind: "category",
        id: categoryElement.dataset.categoryId
      };
      touchDropTargetRef.current = next;
      setTouchDropTarget(next);
      return;
    }

    touchDropTargetRef.current = null;
    setTouchDropTarget(null);
  }

  function finishTouchDrag(channelId: string) {
    const target = touchDropTargetRef.current;
    const gesture = touchGestureRef.current;
    if (gesture) window.clearTimeout(gesture.timer);

    touchGestureRef.current = null;
    touchDraggingIdRef.current = null;
    touchDropTargetRef.current = null;
    setPressingChannelId(null);
    setTouchDraggingId(null);
    setTouchDropTarget(null);
    setDragging(null);
    suppressClickUntilRef.current = Date.now() + 700;

    if (!target) return;

    if (target.kind === "channel") {
      const targetChannel = meta.channels.find((channel) => channel.id === target.id);
      if (!targetChannel || targetChannel.id === channelId) return;
      const position =
        (targetChannel.position ?? 0) + (target.placement === "after" ? 1 : 0);
      void reorderItem(channelId, position, targetChannel.parentId ?? null);
      return;
    }

    if (target.kind === "category") {
      const category = meta.categories.find((item) => item.id === target.id);
      if (!category) return;
      const firstChild = meta.channels
        .filter(
          (channel) =>
            channel.id !== channelId && channel.parentId === category.id
        )
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
      void reorderItem(
        channelId,
        firstChild?.position ?? (category.position ?? 0) + 1,
        category.id
      );
      return;
    }

    const first = uncategorized
      .filter((channel) => channel.id !== channelId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
    void reorderItem(channelId, first?.position ?? 0, null);
  }

  useEffect(() => {
    if (!touchDraggingId) return;

    document.body.classList.add("dsm-touch-reordering");

    const handleMove = (event: TouchEvent) => {
      const gesture = touchGestureRef.current;
      if (!gesture) return;
      const touch = Array.from(event.touches).find(
        (item) => item.identifier === gesture.identifier
      );
      if (!touch) return;

      event.preventDefault();

      const scroller = channelScrollRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const edge = 54;
        if (touch.clientY < rect.top + edge) {
          scroller.scrollTop -= 12;
        } else if (touch.clientY > rect.bottom - edge) {
          scroller.scrollTop += 12;
        }
      }

      updateTouchDropTarget(touch.clientX, touch.clientY);
    };

    const handleEnd = (event: TouchEvent) => {
      const gesture = touchGestureRef.current;
      if (!gesture) return;
      const ended = Array.from(event.changedTouches).some(
        (item) => item.identifier === gesture.identifier
      );
      if (!ended) return;
      event.preventDefault();
      finishTouchDrag(touchDraggingId);
    };

    const handleCancel = () => {
      touchDropTargetRef.current = null;
      touchDraggingIdRef.current = null;
      touchGestureRef.current = null;
      setTouchDropTarget(null);
      setTouchDraggingId(null);
      setDragging(null);
      setPressingChannelId(null);
    };

    document.addEventListener("touchmove", handleMove, { passive: false });
    document.addEventListener("touchend", handleEnd, { passive: false });
    document.addEventListener("touchcancel", handleCancel, { passive: false });

    return () => {
      document.body.classList.remove("dsm-touch-reordering");
      document.removeEventListener("touchmove", handleMove);
      document.removeEventListener("touchend", handleEnd);
      document.removeEventListener("touchcancel", handleCancel);
    };
  }, [touchDraggingId, meta.channels, meta.categories, uncategorized]);

  return (
    <section className="card server-editor-card">
      <div className="section-head server-editor-heading">
        <div>
          <span className="eyebrow">LIVE SERVER EDITOR</span>
          <h2>サーバー構成をプレビュー編集</h2>
          <p className="muted">
            左のDiscord風プレビューから追加・編集・削除できます。スマホではチャンネルを長押しして自由に並べ替えできます。
          </p>
        </div>
        <div className="editor-heading-actions">
          <label className="permission-preview-toggle">
            <input
              type="checkbox"
              checked={showPermissionBadges}
              onChange={(event) => {
                const checked = event.target.checked;
                setShowPermissionBadges(checked);
                localStorage.setItem("dsm_show_permission_badges", checked ? "1" : "0");
              }}
            />
            <span>発言権を表示</span>
          </label>
          <button className="secondary editor-add-category" onClick={() => openCreate(null, "category")}>
            ＋ カテゴリ
          </button>
        </div>
      </div>

      <div className="server-editor-layout">
        <div className="discord-preview">
          <div
            className={`discord-preview-server ${
              touchDropTarget?.kind === "uncategorized" ? "touch-drop-target" : ""
            }`}
            data-uncategorized-drop="true"
            onDragOver={(event) => event.preventDefault()}
            onDrop={dropUncategorized}
          >
            <strong>{guildName}</strong>
            <button
              className="discord-plus"
              onClick={() => openCreate(null, "text")}
              title="チャンネルを追加"
              aria-label="チャンネルを追加"
            >
              ＋
            </button>
          </div>

          <div className="discord-channel-scroll" ref={channelScrollRef}>
            {touchDraggingId && (
              <div
                className={`uncategorized-touch-drop ${
                  touchDropTarget?.kind === "uncategorized" ? "active" : ""
                }`}
                data-uncategorized-drop="true"
              >
                カテゴリなしへ移動
              </div>
            )}
            {uncategorized.length > 0 && (
              <div className="discord-channel-group uncategorized-group">
                {uncategorized.map((channel) => (
                  <button
                    key={channel.id}
                    data-channel-id={channel.id}
                    draggable
                    onDragStart={() => setDragging({ kind: "channel", id: channel.id })}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => dropOnChannel(channel)}
                    onTouchStart={(event) => startChannelLongPress(event, channel.id)}
                    onTouchMove={trackPendingLongPress}
                    onTouchEnd={endPendingLongPress}
                    onTouchCancel={endPendingLongPress}
                    onContextMenu={(event) => event.preventDefault()}
                    className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""} ${pressingChannelId === channel.id ? "long-pressing" : ""} ${touchDraggingId === channel.id ? "touch-dragging" : ""} ${touchDropTarget?.kind === "channel" && touchDropTarget.id === channel.id ? `touch-drop-${touchDropTarget.placement}` : ""}`}
                    onClick={() => {
                      if (Date.now() < suppressClickUntilRef.current) return;
                      openChannel(channel.id);
                    }}
                  >
                    <span className="channel-hash">
                      {channel.type === "voice" || channel.type === "stage" ? "🔊" : "#"}
                    </span>
                    <span className="channel-name">{channel.name}</span>
                    {renderPermissionBadge(channel)}
                    <span className="channel-edit">›</span>
                  </button>
                ))}
              </div>
            )}

            {meta.categories.map((category) => {
              const children = meta.channels.filter((channel) => channel.parentId === category.id);
              const selected = selection?.kind === "category" && selection.id === category.id;
              return (
                <div
                  className={`discord-channel-group ${
                    touchDropTarget?.kind === "category" &&
                    touchDropTarget.id === category.id
                      ? "touch-category-target"
                      : ""
                  }`}
                  key={category.id}
                  data-category-id={category.id}
                >
                  <div
                    className={`discord-category ${selected ? "selected" : ""} ${dragging?.kind === "category" && dragging.id === category.id ? "dragging" : ""}`}
                    draggable
                    onDragStart={() => setDragging({ kind: "category", id: category.id })}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => dropOnCategory(category)}
                  >
                    <button className="discord-category-name" onClick={() => openCategory(category.id)}>
                      <span>⌄</span>
                      <strong>{category.name.toUpperCase()}</strong>
                    </button>
                    <button
                      className="discord-plus category-plus"
                      onClick={() => openCreate(category.id, "text")}
                      title={`${category.name} にチャンネルを追加`}
                      aria-label={`${category.name} にチャンネルを追加`}
                    >
                      ＋
                    </button>
                  </div>

                  {children.map((channel) => (
                    <button
                      key={channel.id}
                      data-channel-id={channel.id}
                      draggable
                      onDragStart={(event) => {
                        event.stopPropagation();
                        setDragging({ kind: "channel", id: channel.id });
                      }}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onDrop={(event) => {
                        event.stopPropagation();
                        dropOnChannel(channel);
                      }}
                      onTouchStart={(event) => startChannelLongPress(event, channel.id)}
                      onTouchMove={trackPendingLongPress}
                      onTouchEnd={endPendingLongPress}
                      onTouchCancel={endPendingLongPress}
                      onContextMenu={(event) => event.preventDefault()}
                      className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""} ${pressingChannelId === channel.id ? "long-pressing" : ""} ${touchDraggingId === channel.id ? "touch-dragging" : ""} ${touchDropTarget?.kind === "channel" && touchDropTarget.id === channel.id ? `touch-drop-${touchDropTarget.placement}` : ""}`}
                      onClick={() => {
                        if (Date.now() < suppressClickUntilRef.current) return;
                        openChannel(channel.id);
                      }}
                    >
                      <span className="channel-hash">
                        {channel.type === "voice" || channel.type === "stage" ? "🔊" : "#"}
                      </span>
                      <span className="channel-name">{channel.name}</span>
                    {renderPermissionBadge(channel)}
                      <span className="channel-edit">›</span>
                    </button>
                  ))}
                </div>
              );
            })}

            {meta.categories.length === 0 && uncategorized.length === 0 && (
              <div className="discord-empty">
                <span>まだチャンネルがありません</span>
                <button onClick={() => openCreate(null, "category")}>最初のカテゴリを作る</button>
              </div>
            )}
          </div>
        </div>

        <div className="server-editor-inspector">
          {!selection && (
            <div className="editor-welcome">
              <div className="editor-welcome-icon">＋</div>
              <h3>プレビューから編集</h3>
              <p>
                カテゴリ横の＋でその中にチャンネルを追加。チャンネル名を押すと、
                名前・トピック・所属カテゴリを変更できます。PCはドラッグ、スマホは長押ししてカテゴリをまたいで移動・並べ替えできます。
              </p>
              <div className="editor-quick-actions">
                <button className="primary" onClick={() => openCreate(null, "text")}>
                  ＋ チャンネル
                </button>
                <button className="secondary" onClick={() => openCreate(null, "category")}>
                  ＋ カテゴリ
                </button>
              </div>
            </div>
          )}

          {selection?.kind === "create" && (
            <form className="editor-form" onSubmit={(event) => void createItem(event)}>
              <div className="editor-inspector-title">
                <div>
                  <span className="eyebrow">ADD</span>
                  <h3>新しく追加</h3>
                </div>
                <button type="button" className="editor-close" onClick={() => setSelection(null)}>
                  ×
                </button>
              </div>

              <label>
                <span>種類</span>
                <select
                  value={createType}
                  onChange={(event) => {
                    const next = event.target.value as "text" | "voice" | "category";
                    setCreateType(next);
                    if (next === "category") setParentId("");
                  }}
                >
                  <option value="text"># テキストチャンネル</option>
                  <option value="voice">🔊 ボイスチャンネル</option>
                  <option value="category">カテゴリ</option>
                </select>
              </label>

              <label>
                <span>名前</span>
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={createType === "category" ? "INFORMATION" : "general"}
                />
              </label>

              {createType !== "category" && (
                <>
                  <label>
                    <span>カテゴリ</span>
                    <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                      <option value="">カテゴリなし</option>
                      {meta.categories.map((category) => (
                        <option value={category.id} key={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {createType === "text" && (
                    <label>
                      <span>トピック</span>
                      <textarea
                        value={topic}
                        onChange={(event) => setTopic(event.target.value)}
                        maxLength={1024}
                        placeholder="任意"
                      />
                    </label>
                  )}
                </>
              )}

              <button className="primary editor-save" type="submit" disabled={saving}>
                {saving ? "作成中…" : "追加する"}
              </button>
            </form>
          )}

          {(selectedChannel || selectedCategory) && selection?.kind !== "create" && (
            <form className="editor-form" onSubmit={(event) => void saveExisting(event)}>
              <div className="editor-inspector-title">
                <div>
                  <span className="eyebrow">EDIT</span>
                  <h3>{selectedCategory ? "カテゴリを編集" : "チャンネルを編集"}</h3>
                </div>
                <button type="button" className="editor-close" onClick={() => setSelection(null)}>
                  ×
                </button>
              </div>

              <label>
                <span>名前</span>
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>

              {selectedChannel && (
                <>
                  <label>
                    <span>所属カテゴリ</span>
                    <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                      <option value="">カテゴリなし</option>
                      {meta.categories.map((category) => (
                        <option value={category.id} key={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedChannel.type === "text" || selectedChannel.type === "announcement" || selectedChannel.type === "forum" || selectedChannel.type === "media" ? (
                    <label>
                      <span>トピック</span>
                      <textarea
                        value={topic}
                        onChange={(event) => setTopic(event.target.value)}
                        maxLength={1024}
                        placeholder="チャンネルの説明"
                      />
                    </label>
                  ) : null}

                  <div className="channel-permission-editor">
                    <div className="permission-editor-head">
                      <div>
                        <strong>チャンネル権限</strong>
                        <small>ロールごとに継承 / 許可 / 拒否を設定</small>
                      </div>
                    </div>

                    <label>
                      <span>対象ロール</span>
                      <select
                        value={permissionTargetId}
                        onChange={(event) => {
                          const targetId = event.target.value;
                          setPermissionTargetId(targetId);
                          setPermissionDraft(draftFor(selectedChannel, targetId));
                        }}
                      >
                        <option value={guildId}>@everyone</option>
                        {meta.roles
                          .filter((role) => role.id !== guildId)
                          .map((role) => (
                            <option key={role.id} value={role.id}>
                              @{role.name}
                            </option>
                          ))}
                      </select>
                    </label>

                    <div className="permission-list">
                      {(selectedChannel.type === "voice" || selectedChannel.type === "stage"
                        ? VOICE_PERMISSION_ROWS
                        : TEXT_PERMISSION_ROWS
                      ).map((permission) => (
                        <div className="permission-row" key={permission.key}>
                          <span>{permission.label}</span>
                          <div className="permission-modes">
                            {(["inherit", "allow", "deny"] as PermissionMode[]).map((mode) => (
                              <button
                                type="button"
                                key={mode}
                                className={
                                  permissionDraft[permission.key] === mode
                                    ? `active ${mode}`
                                    : ""
                                }
                                onClick={() =>
                                  setPermissionDraft({
                                    ...permissionDraft,
                                    [permission.key]: mode
                                  })
                                }
                              >
                                {mode === "inherit" ? "継承" : mode === "allow" ? "許可" : "拒否"}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      className="secondary permission-save"
                      disabled={saving}
                      onClick={() => void savePermissions()}
                    >
                      {saving ? "保存中…" : "権限を保存"}
                    </button>
                  </div>
                </>
              )}

              <div className="editor-action-row">
                <button className="primary" type="submit" disabled={saving}>
                  {saving ? "保存中…" : "変更を保存"}
                </button>
                <button className="danger" type="button" disabled={saving} onClick={() => void deleteSelected()}>
                  削除
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
