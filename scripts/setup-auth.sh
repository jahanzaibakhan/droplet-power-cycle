#!/usr/bin/env bash
# Run on the Cloudways server after adding DB credentials from Application → Access Details → Database
set -euo pipefail
cd "$(dirname "$0")/.."
APP_ENV=".env"

if ! grep -q '^DB_PASSWORD=' "$APP_ENV" 2>/dev/null; then
  echo "Add DB_HOST, DB_USER, DB_PASSWORD, DB_NAME to .env first (Cloudways → mtnwykeaqs → Access Details → Database)."
  exit 1
fi

gen_pass() { openssl rand -base64 18 | tr -d '/+=' | head -c 16; }

append_if_missing() {
  local key="$1" val="$2"
  if ! grep -q "^${key}=" "$APP_ENV" 2>/dev/null; then
    echo "${key}=${val}" >> "$APP_ENV"
  fi
}

append_if_missing COOKIE_SECURE 1
append_if_missing ADMIN_USERNAME jahanzaib
append_if_missing ADMIN_EMAIL admin@dropkick.local
append_if_missing ADMIN_PASSWORD "$(gen_pass)"
append_if_missing ADMIN2_USERNAME admin2
append_if_missing ADMIN2_EMAIL admin2@dropkick.local
append_if_missing ADMIN2_PASSWORD "$(gen_pass)"
append_if_missing USER1_USERNAME operator1
append_if_missing USER1_EMAIL operator1@dropkick.local
append_if_missing USER1_PASSWORD "$(gen_pass)"
append_if_missing USER2_USERNAME operator2
append_if_missing USER2_EMAIL operator2@dropkick.local
append_if_missing USER2_PASSWORD "$(gen_pass)"
append_if_missing USER3_USERNAME operator3
append_if_missing USER3_EMAIL operator3@dropkick.local
append_if_missing USER3_PASSWORD "$(gen_pass)"

echo "Running migration…"
node scripts/migrate.js

echo "Done. Restart PM2: pm2 restart droplet-reboot --update-env"
