import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
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
| "history"
| "react"
| "files"
| "embeds"
| "appCommands"
| "polls"
| "createPublicThreads"
| "createPrivateThreads"
| "sendInThreads"
| "manageThreads"
| "manageMessages"
| "mentionEveryone"
| "externalEmojis"
| "externalStickers"
| "voiceMessages"
| "createInvite"
| "manageWebhooks"
| "pinMessages"
| "bypassSlowmode"
| "connect"
| "speak"
| "stream"
| "useVad"
| "soundboard"
| "externalSounds"
| "setVoiceStatus"
| "prioritySpeaker"
| "muteMembers"
| "deafenMembers"
| "moveMembers";
type PermissionRow = { key: PermissionKey; label: string };
const PERMISSION_BITS: Record<PermissionKey, bigint> = {
view: 1024n,
send: 2048n,
history: 65536n,
react: 64n,
files: 32768n,
embeds: 16384n,
appCommands: 2147483648n,
polls: 562949953421312n,
createPublicThreads: 34359738368n,
createPrivateThreads: 68719476736n,
sendInThreads: 274877906944n,
manageThreads: 17179869184n,
manageMessages: 8192n,
mentionEveryone: 131072n,
externalEmojis: 262144n,
externalStickers: 137438953472n,
voiceMessages: 70368744177664n,
createInvite: 1n,
manageWebhooks: 536870912n,
pinMessages: 2251799813685248n,
bypassSlowmode: 4503599627370496n,
connect: 1048576n,
speak: 2097152n,
stream: 512n,
useVad: 33554432n,
soundboard: 4398046511104n,
externalSounds: 35184372088832n,
setVoiceStatus: 281474976710656n,
prioritySpeaker: 256n,
muteMembers: 4194304n,
deafenMembers: 8388608n,
moveMembers: 16777216n
};
const TEXT_PRIMARY_PERMISSION_ROWS: PermissionRow[] = [
{ key: "view", label: "チャンネルを見る" },
{ key: "send", label: "メッセージを送信" },
{ key: "history", label: "メッセージ履歴を読む" },
{ key: "react", label: "リアクションを追加" },
{ key: "files", label: "ファイルを添付" },
{ key: "embeds", label: "リンクを埋め込む" },
{ key: "appCommands", label: "アプリコマンドを使用" },
{ key: "polls", label: "投票を作成" },
{ key: "createPublicThreads", label: "公開スレッドを作成" },
{ key: "createPrivateThreads", label: "プライベートスレッドを作成" },
{ key: "sendInThreads", label: "スレッド内でメッセージを送信" }
];
const TEXT_ADVANCED_PERMISSION_ROWS: PermissionRow[] = [
{ key: "manageMessages", label: "メッセージを管理" },
{ key: "manageThreads", label: "スレッドを管理" },
{ key: "mentionEveryone", label: "@everyone / @here をメンション" },
{ key: "externalEmojis", label: "外部の絵文字を使用" },
{ key: "externalStickers", label: "外部のスタンプを使用" },
{ key: "voiceMessages", label: "ボイスメッセージを送信" },
{ key: "createInvite", label: "招待を作成" },
{ key: "manageWebhooks", label: "Webhookを管理" },
{ key: "pinMessages", label: "メッセージをピン留め" },
{ key: "bypassSlowmode", label: "低速モードを無視" }
];
const VOICE_PRIMARY_PERMISSION_ROWS: PermissionRow[] = [
{ key: "view", label: "チャンネルを見る" },
{ key: "connect", label: "接続" },
{ key: "speak", label: "発言" },
{ key: "stream", label: "ビデオ / 画面共有" },
{ key: "appCommands", label: "アプリコマンドを使用" },
{ key: "polls", label: "投票を作成" }
];
const VOICE_ADVANCED_PERMISSION_ROWS: PermissionRow[] = [
{ key: "useVad", label: "音声検出を使用" },
{ key: "soundboard", label: "サウンドボードを使用" },
{ key: "externalSounds", label: "外部サウンドを使用" },
{ key: "voiceMessages", label: "ボイスメッセージを送信" },
{ key: "setVoiceStatus", label: "ボイスチャンネルのステータスを設定" },
{ key: "prioritySpeaker", label: "優先スピーカー" },
{ key: "muteMembers", label: "メンバーをミュート" },
{ key: "deafenMembers", label: "メンバーのスピーカーをミュート" },
{ key: "moveMembers", label: "メンバーを移動" },
{ key: "bypassSlowmode", label: "低速モードを無視" }
];
const TEXT_PERMISSION_ROWS: PermissionRow[] = [
...TEXT_PRIMARY_PERMISSION_ROWS,
...TEXT_ADVANCED_PERMISSION_ROWS
];
const VOICE_PERMISSION_ROWS: PermissionRow[] = [
...VOICE_PRIMARY_PERMISSION_ROWS,
...VOICE_ADVANCED_PERMISSION_ROWS
];
function mergePermissionRows(...groups: PermissionRow[][]): PermissionRow[] {
const seen = new Set<PermissionKey>();
return groups.flat().filter((row) => {
if (seen.has(row.key)) return false;
seen.add(row.key);
return true;
});
}
function permissionGroupsForChannelType(type: string) {
const isVoice = type === "voice" || type === "stage";
return isVoice
? {
primary: VOICE_PRIMARY_PERMISSION_ROWS,
advanced: VOICE_ADVANCED_PERMISSION_ROWS
}
: {
primary: TEXT_PRIMARY_PERMISSION_ROWS,
advanced: TEXT_ADVANCED_PERMISSION_ROWS
};
}
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
function makePermissionDraft(mode: PermissionMode): Record<PermissionKey, PermissionMode> {
return Object.fromEntries(
(Object.keys(PERMISSION_BITS) as PermissionKey[]).map((key) => [key, mode])
) as Record<PermissionKey, PermissionMode>;
}
const EMPTY_PERMISSION_DRAFT = makePermissionDraft("inherit");
type BulkPermissionMode = PermissionMode | "keep";
function makeBulkPermissionDraft(
mode: BulkPermissionMode
): Record<PermissionKey, BulkPermissionMode> {
return Object.fromEntries(
(Object.keys(PERMISSION_BITS) as PermissionKey[]).map((key) => [key, mode])
) as Record<PermissionKey, BulkPermissionMode>;
}
const EMPTY_BULK_PERMISSION_DRAFT = makeBulkPermissionDraft("keep");
function draftFor(
channel: ServerEditorMeta["channels"][number],
targetId: string
): Record<PermissionKey, PermissionMode> {
return Object.fromEntries(
(Object.keys(PERMISSION_BITS) as PermissionKey[]).map((key) => [
key,
permissionMode(channel, targetId, key)
])
) as Record<PermissionKey, PermissionMode>;
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
const [permissionSaving, setPermissionSaving] = useState(false);
const [permissionSaveFeedback, setPermissionSaveFeedback] = useState<{
kind: "idle" | "saving" | "success" | "error";
message: string;
detail?: string;
}>({
kind: "idle",
message: "権限を変更して「権限を保存」を押してください"
});
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
const [bulkApplyLog, setBulkApplyLog] = useState<{
kind: "idle" | "saving" | "success" | "error";
message: string;
detail?: string;
}>({
kind: "idle",
message: "一括反映の結果がここに表示されます"
});
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
const bulkPermissionGroups = useMemo(() => {
const hasText = bulkSelectedChannels.some(
(channel) => channel.type !== "voice" && channel.type !== "stage"
);
const hasVoice = bulkSelectedChannels.some(
(channel) => channel.type === "voice" || channel.type === "stage"
);
if (hasText && hasVoice) {
return {
primary: mergePermissionRows(
TEXT_PRIMARY_PERMISSION_ROWS,
          VOICE_PRIMARY_PERMISSION_ROWS
),
advanced: mergePermissionRows(
TEXT_ADVANCED_PERMISSION_ROWS,
          VOICE_ADVANCED_PERMISSION_ROWS
)
};
}
return hasVoice
? {
primary: VOICE_PRIMARY_PERMISSION_ROWS,
advanced: VOICE_ADVANCED_PERMISSION_ROWS
}
: {
primary: TEXT_PRIMARY_PERMISSION_ROWS,
advanced: TEXT_ADVANCED_PERMISSION_ROWS
};
}, [bulkSelectedChannels]);
const selectedPermissionGroups = selectedChannel
? permissionGroupsForChannelType(selectedChannel.type ?? "text")
: permissionGroupsForChannelType("text");
function renderPermissionRows(rows: PermissionRow[], bulk = false) {
if (bulk) {
return rows.map((permission) => (
<div className="permission-row bulk-permission-row" key={permission.key}>
<span>{permission.label}</span>
<div className="permission-modes bulk-permission-modes">
{(["keep", "inherit", "allow", "deny"] as BulkPermissionMode[]).map((mode) => (
<button
type="button"
key={mode}
className={
bulkPermissionDraft[permission.key] === mode
? "active " + mode
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
));
}
return rows.map((permission) => (
<div className="permission-row" key={permission.key}>
<span>{permission.label}</span>
<div className="permission-modes">
{(["inherit", "allow", "deny"] as PermissionMode[]).map((mode) => (
<button
type="button"
key={mode}
className={
permissionDraft[permission.key] === mode
? "active " + mode
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
));
}
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
setPermissionSaveFeedback({
kind: "idle",
message: "権限を変更して「権限を保存」を押してください"
});
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
setBulkApplyLog({
kind: "idle",
message: "一括反映の結果がここに表示されます"
});
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
const targetId = permissionTargetId;
const targetName =
      targetId === guildId
? "@everyone"
: meta.roles.find((role) => role.id === targetId)
? `@${meta.roles.find((role) => role.id === targetId)!.name}`
: permissionPreviewRoleName;
const groups = [
{
channels: bulkSelectedChannels.filter(
(channel) => channel.type !== "voice" && channel.type !== "stage"
),
keys: new Set<PermissionKey>(TEXT_PERMISSION_ROWS.map((row) => row.key))
},
{
channels: bulkSelectedChannels.filter(
(channel) => channel.type === "voice" || channel.type === "stage"
),
keys: new Set<PermissionKey>(VOICE_PERMISSION_ROWS.map((row) => row.key))
}
].filter((group) => group.channels.length > 0);
const changedLabels = Object.entries(bulkPermissionDraft)
.filter(([, mode]) => mode !== "keep")
.map(([key, mode]) => {
const label =
[...TEXT_PERMISSION_ROWS, ...VOICE_PERMISSION_ROWS]
.find((row) => row.key === key)?.label ?? key;
const modeLabel =
          mode === "inherit" ? "継承" : mode === "allow" ? "許可" : "拒否";
return `${label}=${modeLabel}`;
});
setSaving(true);
setBulkSavingProgress({ done: 0, total: bulkSelectedChannels.length });
setBulkApplyLog({
kind: "saving",
message: `${bulkSelectedChannels.length}チャンネルへ反映中…`,
detail: `${targetName} / ${changedLabels.join("・")}`
});
try {
let completed = 0;
let verifiedUpdated = 0;
const operationIds: string[] = [];
const failures: Array<{ id: string; name: string; message: string }> = [];
for (const group of groups) {
const permissions: Partial<Record<PermissionKey, PermissionMode>> = {};
for (const [rawKey, mode] of Object.entries(bulkPermissionDraft)) {
const key = rawKey as PermissionKey;
if (mode === "keep" || !group.keys.has(key)) continue;
permissions[key] = mode;
}
if (Object.keys(permissions).length === 0) {
          completed += group.channels.length;
setBulkSavingProgress({
done: completed,
total: bulkSelectedChannels.length
});
continue;
}
const result = await api<{
ok: boolean;
operationId?: string;
requested: number;
updated: number;
updatedIds: string[];
failed: Array<{ id: string; name: string; message: string }>;
}>(
          `/api/guilds/${guildId}/channels/permissions/bulk`,
{
method: "PATCH",
body: JSON.stringify({
channelIds: group.channels.map((channel) => channel.id),
targetId,
              permissions
})
},
          60_000
);
failures.push(...result.failed);
        verifiedUpdated += result.updated;
if (result.operationId) operationIds.push(result.operationId);
        completed += group.channels.length;
setBulkApplyLog({
kind: result.failed.length > 0 ? "error" : "saving",
message:
result.failed.length > 0
? `${verifiedUpdated}/${bulkSelectedChannels.length}件確認済み・${failures.length}件失敗`
: `${verifiedUpdated}/${bulkSelectedChannels.length}件をDiscordで確認済み`,
detail:
            `${targetName} / ${changedLabels.join("・")}` +
(result.operationId ? ` / ID: ${result.operationId.slice(0, 8)}` : "")
});
setBulkSavingProgress({
done: completed,
total: bulkSelectedChannels.length
});
}
let refreshWarning = false;
try {
await onRefresh();
} catch {
// Discord writes were already verified by the Worker. A secondary
// dashboard refresh must not turn a confirmed save into a failure.
        refreshWarning = true;
}
if (failures.length > 0) {
const details = failures
.slice(0, 3)
.map((failure) => `#${failure.name}: ${failure.message}`)
.join(" / ");
const rest = failures.length > 3 ? ` / ほか${failures.length - 3}件` : "";
throw new Error(
          `${failures.length}チャンネルで権限を反映できませんでした。 ${details}${rest}`
);
}
setBulkPermissionDraft({ ...EMPTY_BULK_PERMISSION_DRAFT });
setBulkApplyLog({
kind: "success",
message: `完了しました：${verifiedUpdated}/${bulkSelectedChannels.length}チャンネル反映済み`,
detail:
          `Discord再取得で確認済み / ${targetName} / ${changedLabels.join("・")}` +
(operationIds.length ? ` / ID: ${operationIds.map((id) => id.slice(0, 8)).join(", ")}` : "") +
(refreshWarning ? " / 管理画面の表示更新のみ後で再取得します" : "")
});
onNotice(
        `${bulkSelectedChannels.length}チャンネルの${targetName}権限を更新しました`
);
} catch (reason) {
try {
await onRefresh();
} catch {
// The original error is more useful than a secondary refresh failure.
}
const message = reason instanceof Error ? reason.message : String(reason);
setBulkApplyLog({
kind: "error",
message: "一括反映に失敗しました",
detail: message
});
onError(reason);
} finally {
setSaving(false);
setBulkSavingProgress(null);
}
}
async function persistChannelPermissions(
channel: ServerEditorMeta["channels"][number],
targetId: string,
draft: Record<PermissionKey, PermissionMode>
) {
const result = await api<{
ok: boolean;
verified?: boolean;
operationId?: string;
}>(
      `/api/guilds/${guildId}/channels/${channel.id}/permissions/${targetId}?client=save-all-v48`,
{
method: "PATCH",
body: JSON.stringify({
targetType: "role",
permissions: draft
})
},
      18_000
);
if (!result.ok || result.verified !== true) {
throw new Error("Discord側の反映確認が完了しませんでした");
}
return result;
}
async function savePermissions() {
if (!selectedChannel || permissionSaving) return;
const channel = selectedChannel;
const channelName = channel.name;
const targetId = permissionTargetId;
const targetName =
      targetId === guildId
? "@everyone"
: meta.roles.find((role) => role.id === targetId)
? `@${meta.roles.find((role) => role.id === targetId)!.name}`
: targetId;
setPermissionSaving(true);
setPermissionSaveFeedback({
kind: "saving",
message: "Discordへ権限を反映して確認中…",
detail: `#${channelName} / ${targetName} / save-all-v48`
});
try {
const result = await persistChannelPermissions(
channel,
targetId,
{ ...permissionDraft }
);
setPermissionSaveFeedback({
kind: "success",
message: "成功しました：Discordへの反映を確認しました",
detail:
          `#${channelName} / ${targetName}` +
(result.operationId ? ` / ID: ${result.operationId.slice(0, 8)}` : "")
});
onNotice("チャンネル権限を保存し、Discordへの反映を確認しました");
      void onRefresh().catch(() => {
setPermissionSaveFeedback((current) =>
current.kind === "success"
? {
...current,
detail:
(current.detail ? current.detail + " / " : "") +
                  "Discord反映済み・管理画面の表示更新のみ後で再取得します"
}
: current
);
});
} catch (reason) {
const message = reason instanceof Error ? reason.message : String(reason);
setPermissionSaveFeedback({
kind: "error",
message: "権限の保存に失敗しました",
detail: message
});
onError(reason);
} finally {
setPermissionSaving(false);
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
const channel = selectedChannel;
const targetId = permissionTargetId;
const baselineDraft = channel ? draftFor(channel, targetId) : null;
const permissionChanged =
      channel !== null &&
      baselineDraft !== null &&
(Object.keys(permissionDraft) as PermissionKey[]).some(
(key) => permissionDraft[key] !== baselineDraft[key]
);
const metadataChanged =
selection.kind === "category"
? name.trim() !== selectedCategory?.name
: channel !== null &&
(
name.trim() !== channel.name ||
(parentId || null) !== (channel.parentId || null) ||
(
["text", "announcement", "forum", "media"].includes(channel.type ?? "text") &&
              topic !== (channel.topic ?? "")
)
);
setSaving(true);
if (permissionChanged && channel) {
const targetName =
        targetId === guildId
? "@everyone"
: meta.roles.find((role) => role.id === targetId)
? `@${meta.roles.find((role) => role.id === targetId)!.name}`
: targetId;
setPermissionSaveFeedback({
kind: "saving",
message: "Discordへ権限を反映して確認中…",
detail: `#${channel.name} / ${targetName} / save-all-v48`
});
}
try {
let permissionOperationId: string | undefined;
// The main "save changes" action must include permission edits. Previously
// it only sent name/parent/topic, so role permission changes were silently
// ignored even though the button showed "保存中…".
if (permissionChanged && channel) {
const result = await persistChannelPermissions(
channel,
targetId,
{ ...permissionDraft }
);
        permissionOperationId = result.operationId;
const targetName =
          targetId === guildId
? "@everyone"
: meta.roles.find((role) => role.id === targetId)
? `@${meta.roles.find((role) => role.id === targetId)!.name}`
: targetId;
setPermissionSaveFeedback({
kind: "success",
message: "成功しました：Discordへの反映を確認しました",
detail:
            `#${channel.name} / ${targetName}` +
(permissionOperationId ? ` / ID: ${permissionOperationId.slice(0, 8)}` : "")
});
}
// Avoid the generic channel PATCH entirely when only permissions changed.
// That removes an unnecessary Discord round trip and the old 20s timeout
// path from the common permission-edit workflow.
if (metadataChanged) {
const body =
selection.kind === "category"
? { name: name.trim() }
: {
name: name.trim(),
parentId: parentId || null,
...(channel &&
["text", "announcement", "forum", "media"].includes(channel.type ?? "text")
? { topic }
: {})
};
await api(`/api/guilds/${guildId}/channels/${selection.id}`, {
method: "PATCH",
body: JSON.stringify(body)
});
}
if (permissionChanged || metadataChanged) {
await onRefresh();
}
if (permissionChanged && metadataChanged) {
onNotice("チャンネル設定とロール権限を更新しました");
} else if (permissionChanged) {
onNotice("チャンネル権限を保存し、Discordへの反映を確認しました");
} else if (metadataChanged) {
onNotice(selection.kind === "category" ? "カテゴリを更新しました" : "チャンネルを更新しました");
} else {
onNotice("変更はありません");
}
} catch (reason) {
if (permissionChanged) {
const message = reason instanceof Error ? reason.message : String(reason);
setPermissionSaveFeedback((current) =>
current.kind === "success"
? current
: {
kind: "error",
message: "権限の保存に失敗しました",
detail: message
}
);
}
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
value={permissionTargetId}
onChange={(event) => {
const roleId = event.target.value;
setPermissionTargetId(roleId);
setPermissionPreviewRoleId(roleId);
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
{renderPermissionRows(bulkPermissionGroups.primary, true)}
</div>
{bulkPermissionGroups.advanced.length > 0 && (
<details className="permission-advanced">
<summary>
<span>詳細な権限</span>
<small>管理・特殊用途の権限</small>
</summary>
<div className="permission-list bulk-permission-list">
{renderPermissionRows(bulkPermissionGroups.advanced, true)}
</div>
</details>
)}
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
<div className={`bulk-apply-log ${bulkApplyLog.kind}`} role="status" aria-live="polite">
<div className="bulk-apply-log-title">
<span>
{bulkApplyLog.kind === "saving"
? "⏳"
: bulkApplyLog.kind === "success"
? "✓"
: bulkApplyLog.kind === "error"
? "!"
: "i"}
</span>
<strong>{bulkApplyLog.message}</strong>
</div>
{bulkApplyLog.detail && <small>{bulkApplyLog.detail}</small>}
</div>
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
setPermissionSaveFeedback({
kind: "idle",
message: "権限を変更して「権限を保存」を押してください"
});
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
{renderPermissionRows(selectedPermissionGroups.primary)}
</div>
{selectedPermissionGroups.advanced.length > 0 && (
<details className="permission-advanced">
<summary>
<span>詳細な権限</span>
<small>管理・特殊用途の権限</small>
</summary>
<div className="permission-list">
{renderPermissionRows(selectedPermissionGroups.advanced)}
</div>
</details>
)}
<button
type="button"
className="secondary permission-save"
disabled={saving || permissionSaving}
onClick={() => void savePermissions()}
>
{permissionSaving ? "反映確認中…" : "権限を保存"}
</button>
<div
className={`bulk-apply-log ${permissionSaveFeedback.kind}`}
role="status"
aria-live="polite"
>
<div className="bulk-apply-log-title">
<span>
{permissionSaveFeedback.kind === "saving"
? "⏳"
: permissionSaveFeedback.kind === "success"
? "✓"
: permissionSaveFeedback.kind === "error"
? "!"
: "i"}
</span>
<strong>{permissionSaveFeedback.message}</strong>
</div>
{permissionSaveFeedback.detail && (
<small>{permissionSaveFeedback.detail}</small>
)}
</div>
</div>
</>
)}
<div className="editor-action-row">
<button className="primary" type="submit" disabled={saving}>
{saving ? "保存中…" : "すべての変更を保存"}
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