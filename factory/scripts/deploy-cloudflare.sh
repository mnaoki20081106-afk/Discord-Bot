#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${1:?source root required}"
WORKING_DIRECTORY="${2:-.}"
BOT_NAME="${3:?bot name required}"
WRANGLER_CONFIG="${4:-auto}"
HEALTH_URL="${5:-}"
WORKDIR="$SOURCE_ROOT/$WORKING_DIRECTORY"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

cd "$WORKDIR"

if [[ ! -f package.json ]]; then
  echo "::error::package.json was not found in $WORKDIR"
  exit 1
fi

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

if [[ "$WRANGLER_CONFIG" == "auto" || -z "$WRANGLER_CONFIG" ]]; then
  for candidate in wrangler.jsonc wrangler.json wrangler.toml; do
    if [[ -f "$candidate" ]]; then
      WRANGLER_CONFIG="$candidate"
      break
    fi
  done
fi

if [[ "$WRANGLER_CONFIG" == "auto" || ! -f "$WRANGLER_CONFIG" ]]; then
  echo "::error::Wrangler config not found in $WORKDIR"
  exit 1
fi

echo "Deploying $BOT_NAME to Cloudflare with $WRANGLER_CONFIG"
npx wrangler deploy --config "$WRANGLER_CONFIG"

if [[ -n "${BOT_SECRET_BUNDLE:-}" ]]; then
  tmp_json="$(mktemp)"
  trap 'rm -f "$tmp_json"' EXIT
  BOT_SECRET_BUNDLE="$BOT_SECRET_BUNDLE" node - "$tmp_json" <<'NODE'
const fs = require('node:fs');
const out = process.argv[2];
let obj;
try {
  obj = JSON.parse(process.env.BOT_SECRET_BUNDLE || '{}');
} catch (error) {
  console.error('::error::BOT secret bundle is not valid JSON.');
  process.exit(1);
}
if (!obj || Array.isArray(obj) || typeof obj !== 'object') {
  console.error('::error::BOT secret bundle must be a JSON object.');
  process.exit(1);
}
for (const [key, value] of Object.entries(obj)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    console.error(`::error::Invalid secret name: ${key}`);
    process.exit(1);
  }
  if (value === null || ['string','number','boolean'].includes(typeof value) === false) {
    console.error(`::error::Secret ${key} must be a string, number, or boolean.`);
    process.exit(1);
  }
  obj[key] = String(value);
}
fs.writeFileSync(out, JSON.stringify(obj), {mode: 0o600});
NODE
  if [[ "$(node -e 'const o=JSON.parse(process.argv[1]); console.log(Object.keys(o).length)' "$BOT_SECRET_BUNDLE")" -gt 0 ]]; then
    npx wrangler secret bulk "$tmp_json" --config "$WRANGLER_CONFIG"
  fi
fi

if [[ -n "$HEALTH_URL" ]]; then
  echo "Checking $HEALTH_URL"
  ok=0
  for attempt in $(seq 1 12); do
    if curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null; then
      ok=1
      break
    fi
    sleep 5
  done
  if [[ "$ok" -ne 1 ]]; then
    echo "::error::Health check failed after deployment: $HEALTH_URL"
    exit 1
  fi
fi
