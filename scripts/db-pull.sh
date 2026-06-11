#!/usr/bin/env bash
#
# Rebuild the local miniflare D1 from migrations, then import a prod content
# subset for realistic local data. Auth tables (user/session/account/
# verification/rate_limit) are deliberately never synced — real user data and
# OAuth tokens stay off laptops; sign up locally instead.
#
# Flow:
#   1. `wrangler d1 export --remote --no-schema` on prod → temp dump.sql
#   2. wipe workers/api/.wrangler/state/v3/d1 and re-apply every migration
#   3. import the dump into the rebuilt local sqlite file
#
# The export runs before the wipe so a failed export leaves the local DB intact.
#
# Requirements:
#   - wrangler authenticated (`wrangler whoami`) with access to the
#     Build Internet account (or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID set)
#
# Usage:
#   bun run db:pull   (or ./scripts/db-pull.sh)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

D1_STATE_DIR="workers/api/.wrangler/state/v3/d1"
DUMP_FILE="$(mktemp -t releases-d1-export-XXXXXX)"
trap 'rm -f "${DUMP_FILE}"' EXIT

# Content tables only. Keep in sync with the db:pull subset documented in
# AGENTS.md — never add auth tables here.
TABLES=(
  organizations
  org_accounts
  sources
  releases
  usage_log
  fetch_log
  ignored_urls
)

TABLE_ARGS=()
for table in "${TABLES[@]}"; do
  TABLE_ARGS+=(--table "${table}")
done

wrangler d1 export released-db --remote --no-schema "${TABLE_ARGS[@]}" \
  --output "${DUMP_FILE}" --config workers/api/wrangler.jsonc

rm -rf "${D1_STATE_DIR}"
bun run db:migrate:local

# miniflare keeps two sqlite files side by side; metadata.sqlite is its own
# bookkeeping, not the database — never import into it.
DB_FILE="$(find "${D1_STATE_DIR}/miniflare-D1DatabaseObject" -name '*.sqlite' ! -name 'metadata.sqlite' | head -n 1)"
if [[ -z "${DB_FILE}" ]]; then
  echo "error: could not locate the local D1 sqlite file under ${D1_STATE_DIR}" >&2
  exit 1
fi

sqlite3 "${DB_FILE}" < "${DUMP_FILE}"
echo "Imported ${TABLES[*]} into ${DB_FILE}"
