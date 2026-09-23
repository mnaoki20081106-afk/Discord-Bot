import { FormEvent, useMemo, useState } from "react";
import { api } from "./api";

export type ServerEditorMeta = {
  channels: Array<{
    id: string;
    name: string;
    type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
    parentId?: string | null;
    topic?: string;
    position?: number;
  }>;
  categories: Array<{
    id: string;
    name: string;
    position?: number;
  }>;
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

  return (
    <section className="card server-editor-card">
      <div className="section-head server-editor-heading">
        <div>
          <span className="eyebrow">LIVE SERVER EDITOR</span>
          <h2>サーバー構成をプレビュー編集</h2>
          <p className="muted">
            左のDiscord風プレビューから、そのまま追加・編集・削除できます。
          </p>
        </div>
        <button className="secondary editor-add-category" onClick={() => openCreate(null, "category")}>
          ＋ カテゴリ
        </button>
      </div>

      <div className="server-editor-layout">
        <div className="discord-preview">
          <div
            className="discord-preview-server"
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

          <div className="discord-channel-scroll">
            {uncategorized.length > 0 && (
              <div className="discord-channel-group uncategorized-group">
                {uncategorized.map((channel) => (
                  <button
                    key={channel.id}
                    draggable
                    onDragStart={() => setDragging({ kind: "channel", id: channel.id })}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => dropOnChannel(channel)}
                    className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""}`}
                    onClick={() => openChannel(channel.id)}
                  >
                    <span className="channel-hash">
                      {channel.type === "voice" || channel.type === "stage" ? "🔊" : "#"}
                    </span>
                    <span>{channel.name}</span>
                    <span className="channel-edit">›</span>
                  </button>
                ))}
              </div>
            )}

            {meta.categories.map((category) => {
              const children = meta.channels.filter((channel) => channel.parentId === category.id);
              const selected = selection?.kind === "category" && selection.id === category.id;
              return (
                <div className="discord-channel-group" key={category.id}>
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
                      className={`discord-channel ${selection?.kind === "channel" && selection.id === channel.id ? "selected" : ""} ${dragging?.kind === "channel" && dragging.id === channel.id ? "dragging" : ""}`}
                      onClick={() => openChannel(channel.id)}
                    >
                      <span className="channel-hash">
                        {channel.type === "voice" || channel.type === "stage" ? "🔊" : "#"}
                      </span>
                      <span>{channel.name}</span>
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
                名前・トピック・所属カテゴリを変更できます。ドラッグ＆ドロップで移動・並べ替えもできます。
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
