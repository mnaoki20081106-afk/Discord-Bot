#!/usr/bin/env bash
# Discord Gateway 中継を VPS にインストールする（root で実行）
#
#   curl -fsSL https://raw.githubusercontent.com/mnaoki20081106-afk/Discord-Bot/main/apps/gateway-relay/install.sh | sudo bash
#
# やること:
#   1. Node.js 22 がなければ /opt/node22 に入れる
#   2. 中継プログラムを /opt/dsm-gateway-relay に置く
#   3. Main Bot のトークンを聞いて /etc/dsm-gateway-relay.env（root だけ読める）に保存
#   4. systemd サービス dsm-gateway-relay として常時起動（落ちても自動で再起動）
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/mnaoki20081106-afk/Discord-Bot/main"
DEFAULT_RELAY_URL="https://discord-bot.c53gftun651-tiktok.workers.dev/internal/gateway-relay"
APP_DIR="/opt/dsm-gateway-relay"
ENV_FILE="/etc/dsm-gateway-relay.env"
SERVICE="dsm-gateway-relay"
NODE_DIR="/opt/node22"

if [ "$(id -u)" -ne 0 ]; then
  echo "root で実行してください（sudo bash）" >&2
  exit 1
fi
for cmd in curl tar systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd が必要です" >&2; exit 1; }
done

# ---- 1. Node.js 22 -------------------------------------------------------------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -ge 22 ]; then NODE_BIN="$(command -v node)"; fi
fi
if [ -z "$NODE_BIN" ] && [ -x "$NODE_DIR/bin/node" ]; then NODE_BIN="$NODE_DIR/bin/node"; fi
if [ -z "$NODE_BIN" ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "未対応のCPUです: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "Node.js 22 をインストールします（$arch）..."
  file="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '{print $2}' | grep -E "^node-v22\.[0-9.]+-linux-${arch}\.tar\.gz$" | head -n1)"
  [ -n "$file" ] || { echo "Node.js のダウンロード先が見つかりません" >&2; exit 1; }
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$file" -o "$tmp/node.tar.gz"
  sum="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk -v f="$file" '$2==f{print $1}')"
  echo "$sum  $tmp/node.tar.gz" | sha256sum -c - >/dev/null || { echo "Node.js のチェックサムが一致しません" >&2; exit 1; }
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/node.tar.gz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  NODE_BIN="$NODE_DIR/bin/node"
fi
echo "Node.js: $("$NODE_BIN" -v)"

# ---- 2. 中継プログラム ---------------------------------------------------------------
id -u dsm-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin dsm-relay
mkdir -p "$APP_DIR"
curl -fsSL "$REPO_RAW/apps/gateway-relay/relay.mjs" -o "$APP_DIR/relay.mjs.new"
mv "$APP_DIR/relay.mjs.new" "$APP_DIR/relay.mjs"
chmod 755 "$APP_DIR" && chmod 644 "$APP_DIR/relay.mjs"

# ---- 3. トークン（既にあれば聞き直さない） ------------------------------------------------
if [ ! -s "$ENV_FILE" ] || [ "${RESET_TOKEN:-0}" = "1" ]; then
  echo
  echo "Main Bot のトークンを入力してください（Cloudflare Worker の DISCORD_BOT_TOKEN と同じもの。画面には表示されません）"
  token=""
  while [ -z "$token" ]; do
    read -r -s -p "DISCORD_BOT_TOKEN: " token < /dev/tty || true
    echo
  done
  me="$(curl -fsS -H "Authorization: Bot $token" https://discord.com/api/v10/users/@me || true)"
  if ! printf '%s' "$me" | grep -q '"id"'; then
    echo "このトークンでは Discord にログインできませんでした。トークンを確認してもう一度実行してください" >&2
    exit 1
  fi
  echo "確認できたBOT: $(printf '%s' "$me" | sed -n 's/.*"username": *"\([^"]*\)".*/\1/p')"
  umask 077
  printf 'DISCORD_BOT_TOKEN=%s\nRELAY_URL=%s\n' "$token" "${RELAY_URL:-$DEFAULT_RELAY_URL}" > "$ENV_FILE"
  chown root:root "$ENV_FILE" && chmod 600 "$ENV_FILE"
  unset token
fi

# ---- 4. systemd ----------------------------------------------------------------
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Discord Gateway relay for the Main Bot (forwards events to Cloudflare Worker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dsm-relay
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/relay.mjs
Restart=always
RestartSec=5
# トークン間違い(3)・Intent未許可(4)・設定不足(2)は再起動しても直らないので止める
RestartPreventExitStatus=2 3 4
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 6
echo
systemctl --no-pager --lines=0 status "$SERVICE" | head -n 5 || true
echo
journalctl -u "$SERVICE" --no-pager -n 15 || true
echo
echo "完了しました。ログの確認: journalctl -u $SERVICE -f"
echo "トークンを変えるとき:      RESET_TOKEN=1 で同じコマンドを実行"
