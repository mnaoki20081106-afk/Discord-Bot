import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";

export type RoleManagerRole = {
  id: string;
  name: string;
  position: number;
  color: number;
  permissions: string;
  isEveryone: boolean;
};

type Props = {
  guildId: string;
  roles: RoleManagerRole[];
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
};

type PermissionItem = {
  key: string;
  label: string;
  description: string;
  bit: bigint;
};

type PermissionGroup = {
  title: string;
  items: PermissionItem[];
};

const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    title: "管理",
    items: [
      {
        key: "administrator",
        label: "Administrator",
        description: "すべての権限を持つ最上位権限",
        bit: 8n
      },
      {
        key: "manageGuild",
        label: "サーバー管理",
        description: "サーバー設定を変更",
        bit: 32n
      },
      {
        key: "manageChannels",
        label: "チャンネル管理",
        description: "チャンネルの作成・編集・削除",
        bit: 16n
      },
      {
        key: "manageRoles",
        label: "ロール管理",
        description: "下位ロールの作成・編集・付与",
        bit: 268435456n
      },
      {
        key: "viewAuditLog",
        label: "監査ログを見る",
        description: "サーバー監査ログを閲覧",
        bit: 128n
      }
    ]
  },
  {
    title: "モデレーション",
    items: [
      {
        key: "kick",
        label: "メンバーをKick",
        description: "メンバーをサーバーから退出させる",
        bit: 2n
      },
      {
        key: "ban",
        label: "メンバーをBan",
        description: "メンバーをBan / Unban",
        bit: 4n
      },
      {
        key: "moderate",
        label: "タイムアウト",
        description: "メンバーをタイムアウト",
        bit: 1099511627776n
      },
      {
        key: "manageMessages",
        label: "メッセージ管理",
        description: "他ユーザーのメッセージ削除など",
        bit: 8192n
      }
    ]
  },
  {
    title: "テキスト・コミュニティ",
    items: [
      {
        key: "viewChannel",
        label: "チャンネルを見る",
        description: "閲覧可能なチャンネルにアクセス",
        bit: 1024n
      },
      {
        key: "sendMessages",
        label: "メッセージを送信",
        description: "テキストチャンネルへ投稿",
        bit: 2048n
      },
      {
        key: "mentionEveryone",
        label: "@everyone をメンション",
        description: "@everyone / @here を使用",
        bit: 131072n
      },
      {
        key: "manageThreads",
        label: "スレッド管理",
        description: "スレッドの編集・削除",
        bit: 17179869184n
      },
      {
        key: "manageWebhooks",
        label: "Webhook管理",
        description: "Webhookの作成・編集・削除",
        bit: 536870912n
      }
    ]
  },
  {
    title: "ボイス",
    items: [
      {
        key: "connect",
        label: "接続",
        description: "ボイスチャンネルへ接続",
        bit: 1048576n
      },
      {
        key: "speak",
        label: "発言",
        description: "ボイスチャンネルで発言",
        bit: 2097152n
      }
    ]
  }
];

function colorToHex(color: number): string {
  const safe = Number.isFinite(color) ? Math.max(0, Math.min(0xffffff, color)) : 0;
  return "#" + safe.toString(16).padStart(6, "0");
}

function roleColor(role: RoleManagerRole): string {
  return role.color ? colorToHex(role.color) : "#747f8d";
}

export default function RoleManager({
  guildId,
  roles,
  onRefresh,
  onNotice,
  onError
}: Props) {
  const initialRole = roles.find((role) => role.isEveryone) ?? roles[0] ?? null;
  const [selectedRoleId, setSelectedRoleId] = useState(initialRole?.id ?? "");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(initialRole?.name ?? "");
  const [color, setColor] = useState(initialRole?.color ?? 0);
  const [colorHex, setColorHex] = useState(colorToHex(initialRole?.color ?? 0));
  const [permissions, setPermissions] = useState(
    BigInt(initialRole?.permissions ?? "0")
  );
  const [saving, setSaving] = useState(false);

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) ?? null,
    [roles, selectedRoleId]
  );

  function loadRole(role: RoleManagerRole) {
    setCreating(false);
    setSelectedRoleId(role.id);
    setName(role.name);
    setColor(role.color ?? 0);
    setColorHex(colorToHex(role.color ?? 0));
    setPermissions(BigInt(role.permissions || "0"));
  }

  useEffect(() => {
    if (creating) return;
    if (selectedRole) return;
    const fallback = roles.find((role) => role.isEveryone) ?? roles[0] ?? null;
    if (fallback) loadRole(fallback);
  }, [roles, selectedRoleId, selectedRole, creating]);

  function startCreate() {
    setCreating(true);
    setSelectedRoleId("");
    setName("");
    setColor(0);
    setColorHex("#000000");
    setPermissions(0n);
  }

  function togglePermission(bit: bigint) {
    setPermissions((current) =>
      (current & bit) === bit ? current & ~bit : current | bit
    );
  }

  function applyHex(value: string) {
    setColorHex(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      setColor(parseInt(value.slice(1), 16));
    }
  }

  async function saveRole(event: FormEvent) {
    event.preventDefault();
    const roleName = name.trim();
    if (creating && !roleName) return;
    if (!creating && !selectedRole) return;

    setSaving(true);
    try {
      if (creating) {
        const created = await api<RoleManagerRole>(
          `/api/guilds/${guildId}/roles`,
          {
            method: "POST",
            body: JSON.stringify({
              name: roleName,
              color,
              permissions: permissions.toString()
            })
          }
        );
        await onRefresh();
        loadRole(created);
        onNotice("ロールを追加しました");
      } else if (selectedRole) {
        const payload = selectedRole.isEveryone
          ? { permissions: permissions.toString() }
          : {
              name: roleName,
              color,
              permissions: permissions.toString()
            };
        const updated = await api<RoleManagerRole>(
          `/api/guilds/${guildId}/roles/${selectedRole.id}`,
          {
            method: "PATCH",
            body: JSON.stringify(payload)
          }
        );
        await onRefresh();
        loadRole(updated);
        onNotice(
          selectedRole.isEveryone
            ? "@everyone の権限を保存しました"
            : "ロールを保存しました"
        );
      }
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  async function deleteRole() {
    if (!selectedRole || selectedRole.isEveryone) return;
    if (!window.confirm(`ロール「${selectedRole.name}」を削除しますか？`)) return;

    setSaving(true);
    try {
      await api(`/api/guilds/${guildId}/roles/${selectedRole.id}`, {
        method: "DELETE"
      });
      const next =
        roles.find((role) => role.id !== selectedRole.id && role.isEveryone) ??
        roles.find((role) => role.id !== selectedRole.id) ??
        null;
      await onRefresh();
      if (next) loadRole(next);
      else startCreate();
      onNotice("ロールを削除しました");
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card role-manager-card">
      <div className="section-head role-manager-heading">
        <div>
          <span className="eyebrow">ROLE MANAGER</span>
          <h2>ロール管理</h2>
          <p className="muted">
            ロールの追加・削除・色変更と、サーバー全体の権限を設定できます。
          </p>
        </div>
        <button
          type="button"
          className="primary"
          onClick={startCreate}
          disabled={saving}
        >
          ＋ ロール追加
        </button>
      </div>

      <div className="role-manager-layout">
        <div className="role-manager-list">
          {roles.map((role) => (
            <button
              type="button"
              key={role.id}
              className={
                !creating && selectedRoleId === role.id
                  ? "role-manager-item active"
                  : "role-manager-item"
              }
              onClick={() => loadRole(role)}
            >
              <span
                className="role-color-dot"
                style={{ backgroundColor: roleColor(role) }}
              />
              <span className="role-manager-item-copy">
                <strong>{role.isEveryone ? "@everyone" : role.name}</strong>
                <small>
                  {role.isEveryone ? "BASE ROLE" : `POSITION ${role.position}`}
                </small>
              </span>
              <span className="role-manager-chevron">›</span>
            </button>
          ))}

          {roles.length === 0 && (
            <div className="role-manager-empty">
              まだ編集可能なロールがありません。
            </div>
          )}
        </div>

        <form className="role-manager-editor" onSubmit={(event) => void saveRole(event)}>
          <div className="role-editor-title">
            <div>
              <span className="eyebrow">{creating ? "CREATE ROLE" : "EDIT ROLE"}</span>
              <h3>
                {creating
                  ? "新しいロール"
                  : selectedRole?.isEveryone
                    ? "@everyone"
                    : selectedRole?.name ?? "ロールを選択"}
              </h3>
            </div>
            {!creating && selectedRole && !selectedRole.isEveryone && (
              <button
                type="button"
                className="danger"
                disabled={saving}
                onClick={() => void deleteRole()}
              >
                削除
              </button>
            )}
          </div>

          {(creating || selectedRole) && (
            <>
              {!selectedRole?.isEveryone && (
                <div className="role-basic-grid">
                  <label>
                    <span>ロール名</span>
                    <input
                      required
                      maxLength={100}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Moderator"
                    />
                  </label>

                  <label>
                    <span>ロール色</span>
                    <div className="role-color-editor">
                      <input
                        className="role-color-input"
                        type="color"
                        value={colorToHex(color)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setColorHex(value);
                          setColor(parseInt(value.slice(1), 16));
                        }}
                      />
                      <input
                        className="role-hex-input"
                        value={colorHex}
                        onChange={(event) => applyHex(event.target.value)}
                        maxLength={7}
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setColor(0);
                          setColorHex("#000000");
                        }}
                      >
                        既定色
                      </button>
                    </div>
                  </label>
                </div>
              )}

              {selectedRole?.isEveryone && (
                <div className="role-everyone-note">
                  <strong>@everyone</strong>
                  <span>
                    全メンバーの基礎ロールです。名前・色・削除は変更できませんが、
                    サーバー全体の権限は編集できます。
                  </span>
                </div>
              )}

              <div className="role-permission-groups">
                {PERMISSION_GROUPS.map((group) => (
                  <section className="role-permission-group" key={group.title}>
                    <h4>{group.title}</h4>
                    <div className="role-permission-list">
                      {group.items.map((permission) => {
                        const checked = (permissions & permission.bit) === permission.bit;
                        return (
                          <label
                            className={checked ? "role-permission-row enabled" : "role-permission-row"}
                            key={permission.key}
                          >
                            <span className="role-permission-copy">
                              <strong>{permission.label}</strong>
                              <small>{permission.description}</small>
                            </span>
                            <span className={checked ? "role-permission-switch on" : "role-permission-switch"}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => togglePermission(permission.bit)}
                              />
                              <span />
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>

              {(permissions & 8n) === 8n && (
                <div className="role-admin-warning">
                  Administrator はチャンネル個別設定を含む全権限を実質的に許可します。
                </div>
              )}

              <button
                className="primary role-save-button"
                type="submit"
                disabled={saving}
              >
                {saving
                  ? "保存中…"
                  : creating
                    ? "ロールを追加"
                    : "変更を保存"}
              </button>
            </>
          )}
        </form>
      </div>
    </section>
  );
}
