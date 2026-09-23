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

type BulkPermissionMode = PermissionMode | "keep";

const EMPTY_BULK_PERMISSION_DRAFT: Record<PermissionKey, BulkPermissionMode> = {
  view: "keep",
  send: "keep",
  react: "keep",
  files: "keep",
  threads: "keep",
  connect: "keep",
  speak: "keep"
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
  grabOffsetX: number;
  grabOffsetY: number;
  width: number;
  height: number;
  timer: number;
  armed: boolean;
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
  const [reorderFeedback, setReorderFeedback] = useState<{
    kind: "saving" | "success" | "error";
    message: string;
  } | null>(null);
  const [touchDragGhost, setTouchDragGhost] = useState<{
    channelId: string;
    name: string;
    type?: ServerEditorMeta["channels"][number]["type"];
    width: number;
    height: number;
    x: number;
    y: number;
  } | null>(null);
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const touchGhostRef = useRef<HTMLDivElement | null>(null);
  const touchDraggingIdRef = useRef<string | null>(null);
  const touchDropTargetRef = useRef<TouchDropTarget>(null);
  const suppressClickUntilRef = useRef(0);
  const channelScrollRef = useRef<HTMLDivElement | null>(null);
  const [permissionTargetId, setPermissionTargetId] = useState(guildId);
  const [permissionDraft, setPermissionDraft] =
    useState<Record<PermissionKey, PermissionMode>>(EMPTY_PERMISSION_DRAFT);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<string[]>([]);
  const [bulkPermissionDraft, setBulkPermissionDraft] =
    useState<Record<PermissionKey, BulkPermissionMode>>(EMPTY_BULK_PERMISSION_DRAFT);
  const [bulkSavingProgress, setBulkSavingProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [showPermissionBadges, setShowPermissionBadges] = useState(
    () => localStorage.getItem("dsm_show_permission_badges") !== "0"
  );
  const [permissionPreviewRoleId, setPermissionPreviewRoleId] = useState(() => {
    const saved = localStorage.getItem(`dsm_permission_preview_role_${guildId}`);
    return saved || guildId;
  });

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

  const permissionPreviewRole = useMemo(
    () =>
      permissionPreviewRoleId === guildId
        ? null
        : meta.roles.find((role) => role.id === permissionPreviewRoleId) ?? null,
    [permissionPreviewRoleId, guildId, meta.roles]
  );

  const permissionPreviewRoleName =
    permissionPreviewRoleId === guildId
      ? "@everyone"
      : permissionPreviewRole
        ? `@${permissionPreviewRole.name}`
        : "@everyone";

  const bulkMode = bulkSelectedIds.length > 0;

  const bulkSelectedChannels = useMemo(
    () => meta.channels.filter((channel) => bulkSelectedIds.includes(channel.id)),
    [meta.channels, bulkSelectedIds]
  );

  const bulkPermissionRows = useMemo(() => {
    const hasText = bulkSelectedChannels.some(
      (channel) => channel.type !== "voice" && channel.type !== "stage"
    );
    const hasVoice = bulkSelectedChannels.some(
      (channel) => channel.type === "voice" || channel.type === "stage"
    );
    if (hasText && hasVoice) {
      const seen = new Set<PermissionKey>();
      return [...TEXT_PERMISSION_ROWS, ...VOICE_PERMISSION_ROWS].filter((row) => {
        if (seen.has(row.key)) return false;
        seen.add(row.key);
        return true;
      });
    }
    return hasVoice ? VOICE_PERMISSION_ROWS : TEXT_PERMISSION_ROWS;
  }, [bulkSelectedChannels]);

  useEffect(() => {
    const valid =
      permissionPreviewRoleId === guildId ||
      meta.roles.some((role) => role.id === permissionPreviewRoleId);
    if (valid) return;
    setPermissionPreviewRoleId(guildId);
    setPermissionTargetId(guildId);
    if (selectedChannel) setPermissionDraft(draftFor(selectedChannel, guildId));
    localStorage.setItem(`dsm_permission_preview_role_${guildId}`, guildId);
  }, [permissionPreviewRoleId, guildId, meta.roles, selectedChannel]);

  function openChannel(id: string) {
    const channel = meta.channels.find((item) => item.id === id);
    if (!channel) return;
    setSelection({ kind: "channel", id });
    setName(channel.name);
    setTopic(channel.topic ?? "");
    setParentId(channel.parentId ?? "");
    setPermissionTargetId(permissionPreviewRoleId);
    setPermissionDraft(draftFor(channel, permissionPreviewRoleId));
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

  function enterBulkSelection(channelId: string) {
    const channel = meta.channels.find((item) => item.id === channelId);
    if (!channel) return;
    setSelection(null);
    setBulkSelectedIds([channelId]);
    setBulkPermissionDraft({ ...EMPTY_BULK_PERMISSION_DRAFT });
    setPermissionTargetId(permissionPreviewRoleId);
    setPressingChannelId(null);
    suppressClickUntilRef.current = Date.now() + 700;
  }

  function exitBulkSelection() {
    setBulkSelectedIds([]);
    setBulkPermissionDraft({ ...EMPTY_BULK_PERMISSION_DRAFT });
    setBulkSavingProgress(null);
  }

  function toggleBulkChannel(channelId: string) {
    setBulkSelectedIds((current) => {
      if (current.includes(channelId)) {
        const next = current.filter((id) => id !== channelId);
        if (next.length === 0) {
          setBulkPermissionDraft({ ...EMPTY_BULK_PERMISSION_DRAFT });
          setBulkSavingProgress(null);
        }
        return next;
      }
      return [...current, channelId];
    });
  }

  async function saveBulkPermissions() {
    if (!bulkSelectedChannels.length) return;

    const hasChange = Object.values(bulkPermissionDraft).some(
      (mode) => mode !== "keep"
    );
    if (!hasChange) {
      onNotice("変更する権限を選択してください");
      return;
    }

    setSaving(true);
    setBulkSavingProgress({ done: 0, total: bulkSelectedChannels.length });
    try {
      let completed = 0;
      for (const channel of bulkSelectedChannels) {
        const relevantKeys = new Set<PermissionKey>(
          (channel.type === "voice" || channel.type === "stage"
            ? VOICE_PERMISSION_ROWS
            : TEXT_PERMISSION_ROWS
          ).map((row) => row.key)
        );

        const permissions: Partial<Record<PermissionKey, PermissionMode>> = {};
        for (const [rawKey, mode] of Object.entries(bulkPermissionDraft)) {
          const key = rawKey as PermissionKey;
          if (mode === "keep" || !relevantKeys.has(key)) continue;
          permissions[key] = mode;
        }

        if (Object.keys(permissions).length > 0) {
          await api(
            `/api/guilds/${guildId}/channels/${channel.id}/permissions/${permissionPreviewRoleId}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                targetType: "role",
                permissions
              })
            }
          );
        }

        completed += 1;
        setBulkSavingProgress({
          done: completed,
          total: bulkSelectedChannels.length
        });
      }

      await onRefresh();
      setBulkPermissionDraft({ ...EMPTY_BULK_PERMISSION_DRAFT });
      onNotice(
        `${bulkSelectedChannels.length}チャンネルの${permissionPreviewRoleName}権限を更新しました`
      );
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
      setBulkSavingProgress(null);
    }
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
    const mode = permissionMode(channel, permissionPreviewRoleId, key);
    const label =
      mode === "allow" ? "発言 可" : mode === "deny" ? "発言 不可" : "発言 継承";
    return (
      <span
        className={`permission-badge ${mode}`}
        title={`${permissionPreviewRoleName}: ${label}`}
      >
        <span className="permission-badge-role">{permissionPreviewRoleName}</span>
        <span className="permission-badge-state">{label}</span>
      </span>
    );
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

  async function reorderChannel(
    id: string,
    destination:
      | { targetId: string; placement: "before" | "after" }
      | { parentId: string | null; placement: "start" }
  ) {
    setSaving(true);
    setReorderFeedback({
      kind: "saving",
      message: "Discordへ並び順を反映中…"
    });
    try {
      await api(`/api/guilds/${guildId}/channels/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ id, ...destination })
      });
      await onRefresh();
      setReorderFeedback({
        kind: "success",
        message: "並び替えを反映しました"
      });
      window.setTimeout(() => {
        setReorderFeedback((current) =>
          current?.kind === "success" ? null : current
        );
      }, 1800);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setReorderFeedback({
        kind: "error",
        message: "並び替えに失敗しました: " + message
      });
      onError(reason);
    } finally {
      setSaving(false);
      setDragging(null);
    }
  }

  async function reorderCategory(id: string, position: number) {
    setSaving(true);
    setReorderFeedback({
      kind: "saving",
      message: "カテゴリの並び順を反映中…"
    });
    try {
      await api(`/api/guilds/${guildId}/channels/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ id, position })
      });
      await onRefresh();
      setReorderFeedback({
        kind: "success",
        message: "カテゴリの並び替えを反映しました"
      });
      window.setTimeout(() => {
        setReorderFeedback((current) =>
          current?.kind === "success" ? null : current
        );
      }, 1800);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setReorderFeedback({
        kind: "error",
        message: "カテゴリの並び替えに失敗しました: " + message
      });
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
    void reorderChannel(dragging.id, {
      targetId: target.id,
      placement: "before"
    });
  }

  function dropOnCategory(target: ServerEditorMeta["categories"][number]) {
    if (!dragging) return;
    if (dragging.kind === "category") {
      if (dragging.id !== target.id) {
        void reorderCategory(dragging.id, target.position ?? 0);
      } else {
        setDragging(null);
      }
      return;
    }

    void reorderChannel(dragging.id, {
      parentId: target.id,
      placement: "start"
    });
  }

  function dropUncategorized() {
    if (!dragging || dragging.kind !== "channel") {
      setDragging(null);
      return;
    }
    void reorderChannel(dragging.id, {
      parentId: null,
      placement: "start"
    });
  }

  function clearPendingTouch() {
    const gesture = touchGestureRef.current;
    if (gesture) window.clearTimeout(gesture.timer);
    touchGestureRef.current = null;
    setPressingChannelId(null);
  }

  function beginTouchDrag(gesture: TouchGesture, touch: React.Touch) {
    const channel = meta.channels.find((item) => item.id === gesture.channelId);
    touchDraggingIdRef.current = gesture.channelId;
    setTouchDraggingId(gesture.channelId);
    setDragging({ kind: "channel", id: gesture.channelId });
    setTouchDragGhost({
      channelId: gesture.channelId,
      name: channel?.name ?? "channel",
      type: channel?.type,
      width: gesture.width,
      height: gesture.height,
      x: touch.clientX - gesture.grabOffsetX,
      y: touch.clientY - gesture.grabOffsetY
    });
    setPressingChannelId(null);
    suppressClickUntilRef.current = Date.now() + 700;
  }

  function startChannelLongPress(
    event: React.TouchEvent<HTMLButtonElement>,
    channelId: string
  ) {
    if (event.touches.length !== 1 || saving || bulkMode) return;
    clearPendingTouch();
    const touch = event.touches[0]!;
    const rect = event.currentTarget.getBoundingClientRect();
    const gesture: TouchGesture = {
      channelId,
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      grabOffsetX: touch.clientX - rect.left,
      grabOffsetY: touch.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      timer: 0,
      armed: false
    };
    gesture.timer = window.setTimeout(() => {
      if (touchGestureRef.current !== gesture) return;
      gesture.armed = true;
      setPressingChannelId(channelId);
      suppressClickUntilRef.current = Date.now() + 700;
    }, 450);
    touchGestureRef.current = gesture;
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

    if (!gesture.armed) {
      if (distance > 10) clearPendingTouch();
      return;
    }

    if (distance > 6) {
      event.preventDefault();
      beginTouchDrag(gesture, touch);
    }
  }

  function endPendingLongPress() {
    if (touchDraggingIdRef.current) {
      finishTouchDrag(touchDraggingIdRef.current);
      return;
    }
    const gesture = touchGestureRef.current;
    if (gesture?.armed) {
      window.clearTimeout(gesture.timer);
      touchGestureRef.current = null;
      setPressingChannelId(null);
      enterBulkSelection(gesture.channelId);
      return;
    }
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
    setTouchDragGhost(null);
    setDragging(null);
    suppressClickUntilRef.current = Date.now() + 700;

    if (!target) return;

    if (target.kind === "channel") {
      const targetChannel = meta.channels.find((channel) => channel.id === target.id);
      if (!targetChannel || targetChannel.id === channelId) return;
      void reorderChannel(channelId, {
        targetId: targetChannel.id,
        placement: target.placement
      });
      return;
    }

    if (target.kind === "category") {
      const category = meta.categories.find((item) => item.id === target.id);
      if (!category) return;
      void reorderChannel(channelId, {
        parentId: category.id,
        placement: "start"
      });
      return;
    }

    void reorderChannel(channelId, {
      parentId: null,
      placement: "start"
    });
  }

  function touchDropDescription(): string {
    if (!touchDropTarget) return "移動先を選んでください";

    if (touchDropTarget.kind === "channel") {
      const target = meta.channels.find(
        (channel) => channel.id === touchDropTarget.id
      );
      if (!target) return "移動先を選んでください";
      return `#${target.name} の${touchDropTarget.placement === "before" ? "前" : "後"}へ移動`;
    }

    if (touchDropTarget.kind === "category") {
      const category = meta.categories.find(
        (item) => item.id === touchDropTarget.id
      );
      return category
        ? `${category.name} の先頭へ移動`
        : "カテゴリへ移動";
    }

    return "カテゴリなしの先頭へ移動";
  }

  useEffect(() => {
    return () => {
      const gesture = touchGestureRef.current;
      if (gesture) window.clearTimeout(gesture.timer);
    };
  }, []);

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

      const ghost = touchGhostRef.current;
      if (ghost) {
        const x = touch.clientX - gesture.grabOffsetX;
        const y = touch.clientY - gesture.grabOffsetY;
        ghost.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.025)`;
      }

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
      setTouchDragGhost(null);
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
      {touchDragGhost && (
        <div
          ref={touchGhostRef}
          className="touch-channel-ghost"
          style={{
            width: touchDragGhost.width,
            height: touchDragGhost.height,
            transform: `translate3d(${touchDragGhost.x}px, ${touchDragGhost.y}px, 0) scale(1.025)`
          }}
          aria-hidden="true"
        >
          <span className="channel-hash">
            {touchDragGhost.type === "voice" || touchDragGhost.type === "stage" ? "🔊" : "#"}
          </span>
          <span className="channel-name">{touchDragGhost.name}</span>
          <span className="touch-ghost-grip">⋮⋮</span>
        </div>
      )}
      <div className="section-head server-editor-heading">
        <div>
          <span className="eyebrow">LIVE SERVER EDITOR</span>
          <h2>サーバー構成をプレビュー編集</h2>
          <p className="muted">
            左のDiscord風プレビューから追加・編集・削除できます。スマホではチャンネルを長押しして自由に並べ替えできます。
          </p>
        </div>
        <div className="editor-heading-actions">
          <div className="permission-preview-controls">
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
            {showPermissionBadges && (
              <label className="permission-preview-role-select">
                <span>対象</span>
                <select
                  value={permissionPreviewRoleId}
                  onChange={(event) => {
                    const roleId = event.target.value;
                    setPermissionPreviewRoleId(roleId);
                    setPermissionTargetId(roleId);
                    if (selectedChannel) {
                      setPermissionDraft(draftFor(selectedChannel, roleId));
                    }
                    if (bulkMode) {
                      setBulkPermissionDraft({ ...EMPTY_BULK_PERMISSION_DRAFT });
                    }
                    localStorage.setItem(
                      `dsm_permission_preview_role_${guildId}`,
                      roleId
                    );
                  }}
                  aria-label="発言権を表示する対象ロール"
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
            )}
          </div>
          <button className="secondary editor-add-category" onClick={() => openCreate(null, "category")}>
            ＋ カテゴリ
          </button>
        </div>
      </div>

      <div className="server-editor-layout">
        <div className="discord-preview">
          {(touchDraggingId || reorderFeedback) && (
            <div
              className={
                touchDraggingId
                  ? "reorder-status dragging"
                  : `reorder-status ${reorderFeedback?.kind ?? ""}`
              }
              role="status"
              aria-live="polite"
            >
              <span className="reorder-status-icon">
                {touchDraggingId
                  ? "↕"
                  : reorderFeedback?.kind === "success"
                    ? "✓"
                    : reorderFeedback?.kind === "error"
                      ? "!"
                      : "…"}
              </span>
              <strong>
                {touchDraggingId
                  ? touchDropDescription()
                  : reorderFeedback?.message}
              </strong>
            </div>
          )}
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

          {showPermissionBadges && (
            <div className="permission-preview-context">
              <span className="permission-preview-context-icon">◉</span>
              <span>発言権表示</span>
              <strong>{permissionPreviewRoleName}</strong>
            </div>
          )}

          {bulkMode && (
            <div className="bulk-selection-bar">
              <div>
                <strong>{bulkSelectedIds.length}チャンネル選択中</strong>
                <span>{permissionPreviewRoleName} の権限を一括編集</span>
              </div>
              <button type="button" onClick={exitBulkSelection}>
                完了
              </button>
            </div>
          )}

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
                    draggable={!bulkMode}
                    onDragStart={() => setDragging({ kind: "channel", id: channel.id })}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => dropOnChannel(channel)}
                    onTouchStart={(event) => startChannelLongPress(event, channel.id)}
                    onTouchMove={trackPendingLongPress}
                    onTouchEnd={endPendingLongPress}
                    onTouchCancel={endPendingLongPress}
                    onContextMenu={(event) => event.preventDefault()}
                    className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${bulkMode ? "bulk-mode" : ""} ${bulkSelectedIds.includes(channel.id) ? "bulk-selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""} ${pressingChannelId === channel.id ? "long-pressing" : ""} ${touchDraggingId === channel.id ? "touch-dragging" : ""} ${touchDropTarget?.kind === "channel" && touchDropTarget.id === channel.id ? `touch-drop-${touchDropTarget.placement}` : ""}`}
                    onClick={() => {
                      if (Date.now() < suppressClickUntilRef.current) return;
                      if (bulkMode) {
                        toggleBulkChannel(channel.id);
                        return;
                      }
                      openChannel(channel.id);
                    }}
                  >
                    <span className="channel-hash">
                      {channel.type === "voice" || channel.type === "stage" ? "🔊" : "#"}
                    </span>
                    <span className="channel-name">{channel.name}</span>
                    {renderPermissionBadge(channel)}
                    {bulkMode ? (
                      <span
                        className={`bulk-select-indicator ${
                          bulkSelectedIds.includes(channel.id) ? "selected" : ""
                        }`}
                      >
                        {bulkSelectedIds.includes(channel.id) ? "✓" : "○"}
                      </span>
                    ) : (
                      <span className="channel-edit">›</span>
                    )}
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
                      draggable={!bulkMode}
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
                      className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${bulkMode ? "bulk-mode" : ""} ${bulkSelectedIds.includes(channel.id) ? "bulk-selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""} ${pressingChannelId === channel.id ? "long-pressing" : ""} ${touchDraggingId === channel.id ? "touch-dragging" : ""} ${touchDropTarget?.kind === "channel" && touchDropTarget.id === channel.id ? `touch-drop-${touchDropTarget.placement}` : ""}`}
                      onClick={() => {
                        if (Date.now() < suppressClickUntilRef.current) return;
                        if (bulkMode) {
                          toggleBulkChannel(channel.id);
                          return;
                        }
                        openChannel(channel.id);
                      }}
                    >
                      <span className="channel-hash">
                        {channel.type === "voice" || channel.type === "stage" ? "🔊" : "#"}
                      </span>
                      <span className="channel-name">{channel.name}</span>
                    {renderPermissionBadge(channel)}
                      {bulkMode ? (
                        <span
                          className={`bulk-select-indicator ${
                            bulkSelectedIds.includes(channel.id) ? "selected" : ""
                          }`}
                        >
                          {bulkSelectedIds.includes(channel.id) ? "✓" : "○"}
                        </span>
                      ) : (
                        <span className="channel-edit">›</span>
                      )}
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
          {bulkMode && (
            <div className="bulk-permission-editor">
              <div className="editor-inspector-title">
                <div>
                  <span className="eyebrow">BULK PERMISSIONS</span>
                  <h3>チャンネル権限を一括編集</h3>
                  <p>
                    {bulkSelectedIds.length}チャンネルを選択中。変更した項目だけまとめて反映します。
                  </p>
                </div>
                <button
                  type="button"
                  className="editor-close"
                  onClick={exitBulkSelection}
                  aria-label="一括選択を終了"
                >
                  ×
                </button>
              </div>

              <div className="bulk-selected-channels">
                {bulkSelectedChannels.map((channel) => (
                  <button
                    type="button"
                    key={channel.id}
                    onClick={() => toggleBulkChannel(channel.id)}
                    title="選択解除"
                  >
                    <span>{channel.type === "voice" || channel.type === "stage" ? "🔊" : "#"}</span>
                    <strong>{channel.name}</strong>
                    <i>×</i>
                  </button>
                ))}
              </div>

              <div className="channel-permission-editor bulk-channel-permission-editor">
                <div className="permission-editor-head">
                  <div>
                    <strong>対象ロール</strong>
                    <small>発言権プレビューと同じロールを使用します</small>
                  </div>
                </div>

                <label>
                  <span>対象ロール</span>
                  <select
                    value={permissionPreviewRoleId}
                    onChange={(event) => {
                      const roleId = event.target.value;
                      setPermissionPreviewRoleId(roleId);
                      setPermissionTargetId(roleId);
                      setBulkPermissionDraft({ ...EMPTY_BULK_PERMISSION_DRAFT });
                      localStorage.setItem(
                        `dsm_permission_preview_role_${guildId}`,
                        roleId
                      );
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

                <div className="bulk-permission-note">
                  <strong>変更なし</strong> を選んだ権限は、各チャンネルの現在設定をそのまま残します。
                </div>

                <div className="permission-list bulk-permission-list">
                  {bulkPermissionRows.map((permission) => (
                    <div className="permission-row bulk-permission-row" key={permission.key}>
                      <span>{permission.label}</span>
                      <div className="permission-modes bulk-permission-modes">
                        {(["keep", "inherit", "allow", "deny"] as BulkPermissionMode[]).map((mode) => (
                          <button
                            type="button"
                            key={mode}
                            className={
                              bulkPermissionDraft[permission.key] === mode
                                ? `active ${mode}`
                                : ""
                            }
                            onClick={() =>
                              setBulkPermissionDraft({
                                ...bulkPermissionDraft,
                                [permission.key]: mode
                              })
                            }
                          >
                            {mode === "keep"
                              ? "変更なし"
                              : mode === "inherit"
                                ? "継承"
                                : mode === "allow"
                                  ? "許可"
                                  : "拒否"}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  className="primary permission-save bulk-permission-save"
                  disabled={saving}
                  onClick={() => void saveBulkPermissions()}
                >
                  {bulkSavingProgress
                    ? `反映中… ${bulkSavingProgress.done}/${bulkSavingProgress.total}`
                    : `${bulkSelectedIds.length}チャンネルへ一括反映`}
                </button>
              </div>
            </div>
          )}

          {!selection && !bulkMode && (
            <div className="editor-welcome">
              <div className="editor-welcome-icon">＋</div>
              <h3>プレビューから編集</h3>
              <p>
                カテゴリ横の＋でその中にチャンネルを追加。チャンネル名を押すと、
                名前・トピック・所属カテゴリを変更できます。スマホは長押しして離すと一括選択、長押し後そのまま動かすと並べ替えできます。
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

          {!bulkMode && selection?.kind === "create" && (
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

          {!bulkMode && (selectedChannel || selectedCategory) && selection?.kind !== "create" && (
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
                          setPermissionPreviewRoleId(targetId);
                          setPermissionDraft(draftFor(selectedChannel, targetId));
                          localStorage.setItem(
                            `dsm_permission_preview_role_${guildId}`,
                            targetId
                          );
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
