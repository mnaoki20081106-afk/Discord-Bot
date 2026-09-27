#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${1:?source root required}"
WORKING_DIRECTORY="${2:-.}"
BOT_NAME="${3:?bot name required}"
HOST="${4:?OCI host IP required}"
START_COMMAND="${5:-}"
WORKDIR="$SOURCE_ROOT/$WORKING_DIRECTORY"

: "${BOT_FACTORY_SSH_PRIVATE_KEY:?BOT_FACTORY_SSH_PRIVATE_KEY is required}"

if [[ ! "$BOT_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "::error::bot_name must match ^[a-z0-9][a-z0-9-]{0,62}$"
  exit 1
fi
if [[ ! -d "$WORKDIR" ]]; then
  echo "::error::Working directory not found: $WORKDIR"
  exit 1
fi
if [[ ! -f "$WORKDIR/Dockerfile" && ! -f "$WORKDIR/package.json" ]]; then
  echo "::error::Oracle runtime needs a Dockerfile or package.json in $WORKDIR"
  exit 1
fi

KEY_FILE="$(mktemp)"
ENV_FILE="$(mktemp)"
trap 'rm -f "$KEY_FILE" "$ENV_FILE"' EXIT
printf '%s\n' "$BOT_FACTORY_SSH_PRIVATE_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

if [[ -n "${BOT_SECRET_BUNDLE:-}" ]]; then
  BOT_SECRET_BUNDLE="$BOT_SECRET_BUNDLE" node - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const out = process.argv[2];
let obj;
try { obj = JSON.parse(process.env.BOT_SECRET_BUNDLE || '{}'); }
catch { console.error('::error::BOT secret bundle is not valid JSON.'); process.exit(1); }
if (!obj || Array.isArray(obj) || typeof obj !== 'object') process.exit(1);
const lines = [];
for (const [key, raw] of Object.entries(obj)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    console.error(`::error::Invalid environment variable name: ${key}`); process.exit(1);
  }
  const value = String(raw ?? '');
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    console.error(`::error::Environment value ${key} contains a newline or NUL.`); process.exit(1);
  }
  lines.push(`${key}=${value}`);
}
fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), {mode: 0o600});
NODE
else
  : > "$ENV_FILE"
fi

SSH=(ssh -i "$KEY_FILE" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "ubuntu@$HOST")
SCP=(scp -i "$KEY_FILE" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

ready=0
for attempt in $(seq 1 36); do
  if "${SSH[@]}" 'docker version >/dev/null 2>&1'; then
    ready=1
    break
  fi
  sleep 5
done
if [[ "$ready" -ne 1 ]]; then
  echo "::error::OCI host did not become ready for deployment."
  exit 1
fi

REMOTE_BASE="/opt/bot-factory/apps/$BOT_NAME"
"${SSH[@]}" "sudo mkdir -p '$REMOTE_BASE/src' && sudo chown -R ubuntu:ubuntu '$REMOTE_BASE' && rm -rf '$REMOTE_BASE/src' && mkdir -p '$REMOTE_BASE/src'"

tar --exclude='.git' --exclude='node_modules' --exclude='.dev.vars' --exclude='.env' -czf - -C "$WORKDIR" .   | "${SSH[@]}" "tar xzf - -C '$REMOTE_BASE/src'"

"${SCP[@]}" "$ENV_FILE" "ubuntu@$HOST:$REMOTE_BASE/.env" >/dev/null
"${SSH[@]}" "chmod 600 '$REMOTE_BASE/.env'"

if [[ ! -f "$WORKDIR/Dockerfile" ]]; then
  cat > /tmp/Dockerfile.bot-factory <<'DOCKER'
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; then npm run build; fi  && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["npm","start"]
DOCKER
  "${SCP[@]}" /tmp/Dockerfile.bot-factory "ubuntu@$HOST:$REMOTE_BASE/src/Dockerfile.bot-factory" >/dev/null
  rm -f /tmp/Dockerfile.bot-factory
  DOCKERFILE="Dockerfile.bot-factory"
else
  DOCKERFILE="Dockerfile"
fi

IMAGE="bot-factory/$BOT_NAME:latest"
"${SSH[@]}" "cd '$REMOTE_BASE/src' && docker build -f '$DOCKERFILE' -t '$IMAGE' ."
"${SSH[@]}" "docker rm -f '$BOT_NAME' >/dev/null 2>&1 || true"

if [[ -n "$START_COMMAND" ]]; then
  encoded="$(printf '%s' "$START_COMMAND" | base64 -w0)"
  "${SSH[@]}" "docker run -d --name '$BOT_NAME' --restart unless-stopped --env-file '$REMOTE_BASE/.env' '$IMAGE' sh -lc \"\$(printf '%s' '$encoded' | base64 -d)\""
else
  "${SSH[@]}" "docker run -d --name '$BOT_NAME' --restart unless-stopped --env-file '$REMOTE_BASE/.env' '$IMAGE'"
fi

sleep 8
state="$("${SSH[@]}" "docker inspect -f '{{.State.Status}}' '$BOT_NAME' 2>/dev/null || true")"
if [[ "$state" != "running" ]]; then
  echo "::error::Container $BOT_NAME is not running (state=$state)."
  "${SSH[@]}" "docker logs --tail 200 '$BOT_NAME' || true"
  exit 1
fi

"${SSH[@]}" "docker logs --tail 30 '$BOT_NAME' || true"
echo "Deployed $BOT_NAME on OCI host $HOST"
