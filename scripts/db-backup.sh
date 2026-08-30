#!/usr/bin/env bash
#
# Capture a full local backup of the production D1 (released-db) as a
# portable, gzipped SQL dump. This is the disaster-recovery layer beneath
# Cloudflare Time Travel: unlike db:pull / sync-staging-db.sh it exports
# EVERY real table — auth tables included — so a restore can rebuild the
# world from nothing.
#
# D1's export API refuses databases containing FTS5 virtual tables, so a
# bare `wrangler d1 export` fails on released-db. Instead we enumerate the
# real tables at runtime and export them data-only (--no-schema): the FTS
# index and its shadow tables are excluded (releases_fts is external-content
# over `releases`, so nothing is lost), and schema comes from the repo's
# migrations at restore time.
#
# Restore: apply migrations to a fresh database (e.g. `bun run
# db:migrate:local` for miniflare, or `wrangler d1 migrations apply` for a
# new D1), delete the freshly-stamped d1_migrations rows, then import the
# gunzipped dump. Rebuild the FTS index afterwards.
#
# Flow:
#   1. List real tables from sqlite_master (excluding FTS/system tables)
#   2. `wrangler d1 export --remote --no-schema --table ...` → temp dump.sql
#   3. Verify core tables have INSERT rows in the dump
#   4. gzip into BACKUP_DIR as released-db-<UTC timestamp>.sql.gz
#   5. Rotate: keep the newest KEEP_DAILY dumps plus one per ISO week for
#      the newest KEEP_WEEKLY weeks; delete the rest
#
# The dump contains real user data (emails, OAuth tokens). It stays outside
# the repo, and the backup directory is created chmod 700. Do not commit or
# upload these files anywhere public.
#
# Requirements:
#   - wrangler authenticated (`wrangler whoami`) with access to the
#     Build Internet account (or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID set)
#   - gzip, python3 (JSON parsing)
#
# Usage:
#   bun run db:backup                       (or ./scripts/db-backup.sh)
#   BACKUP_DIR=/somewhere ./scripts/db-backup.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

BACKUP_DIR="${BACKUP_DIR:-${HOME}/Code/.backups/releases}"
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"

WORK_DIR="$(mktemp -d -t releases-d1-backup-XXXXXX)"
DUMP_FILE="${WORK_DIR}/dump.sql"
trap 'rm -rf "${WORK_DIR}"' EXIT

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/released-db-${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# Enumerate real tables so new tables are picked up automatically. Excluded:
# sqlite internals, Cloudflare's _cf_KV bookkeeping, and the FTS5 virtual
# table + its shadow tables (releases_fts%), which D1 export cannot handle.
echo "Listing tables..."
TABLES=()
while IFS= read -r table; do
  TABLES+=("${table}")
done < <(
  bunx wrangler d1 execute released-db --remote --config workers/api/wrangler.jsonc --json \
    --command "SELECT name FROM sqlite_master WHERE type='table'
               AND name NOT LIKE 'sqlite_%'
               AND name NOT LIKE 'releases_fts%'
               AND name != '_cf_KV'
               ORDER BY name" 2>"${WORK_DIR}/enumerate.err" \
    | sed -n '/^[[{]/,$p' \
    | python3 -c "import json,sys; print('\n'.join(r['name'] for r in json.load(sys.stdin)[0]['results']))"
)
if ((${#TABLES[@]} < 10)); then
  echo "error: table enumeration returned only ${#TABLES[@]} tables — refusing to back up a partial list" >&2
  cat "${WORK_DIR}/enumerate.err" >&2 || true
  exit 1
fi
echo "Backing up ${#TABLES[@]} tables."

TABLE_ARGS=()
for table in "${TABLES[@]}"; do
  TABLE_ARGS+=(--table "${table}")
done

echo "Exporting released-db (data-only, all real tables)..."
bunx wrangler d1 export released-db --remote --no-schema "${TABLE_ARGS[@]}" \
  --output "${DUMP_FILE}" --config workers/api/wrangler.jsonc

# Verify the dump actually contains data for the core tables. A backup that
# silently exported nothing is worse than a failed run. Counts are NOT
# printed: in CI this log is public (public repo), and row counts — user
# counts especially — shouldn't be published nightly.
for table in organizations sources releases user; do
  count="$(grep -c "^INSERT INTO \"${table}\"" "${DUMP_FILE}" || true)"
  if ((count == 0)); then
    echo "error: verification failed — no INSERT rows for table '${table}' in the dump" >&2
    exit 1
  fi
  echo "  ${table}: ok"
done

gzip -9 -c "${DUMP_FILE}" > "${OUT_FILE}"
chmod 600 "${OUT_FILE}"
echo "Wrote $(du -h "${OUT_FILE}" | cut -f1 | tr -d ' ')	${OUT_FILE}"

# Rotation. Filenames sort chronologically, so "newest" is tail of a sorted
# listing. Keep the newest KEEP_DAILY outright, then the newest dump within
# each of the most recent KEEP_WEEKLY ISO weeks; everything else goes.
ALL_DUMPS=()
while IFS= read -r f; do
  ALL_DUMPS+=("${f}")
done < <(find "${BACKUP_DIR}" -maxdepth 1 -name 'released-db-*.sql.gz' | sort)

declare -a KEEP=()
total=${#ALL_DUMPS[@]}
daily_start=$((total > KEEP_DAILY ? total - KEEP_DAILY : 0))
for ((i = daily_start; i < total; i++)); do
  KEEP+=("${ALL_DUMPS[i]}")
done

# Newest-per-ISO-week, walking newest → oldest.
declare -a WEEKS_SEEN=()
for ((i = total - 1; i >= 0; i--)); do
  f="${ALL_DUMPS[i]}"
  stamp="$(basename "${f}" | sed -E 's/^released-db-([0-9]{8})T.*/\1/')"
  week="$(date -j -u -f '%Y%m%d' "${stamp}" +%G-%V 2>/dev/null || date -u -d "${stamp}" +%G-%V)"
  seen=0
  for w in ${WEEKS_SEEN[@]+"${WEEKS_SEEN[@]}"}; do
    [[ "${w}" == "${week}" ]] && seen=1 && break
  done
  if ((seen == 0)); then
    if ((${#WEEKS_SEEN[@]} >= KEEP_WEEKLY)); then
      break
    fi
    WEEKS_SEEN+=("${week}")
    KEEP+=("${f}")
  fi
done

for f in ${ALL_DUMPS[@]+"${ALL_DUMPS[@]}"}; do
  keep=0
  for k in "${KEEP[@]}"; do
    [[ "${k}" == "${f}" ]] && keep=1 && break
  done
  if ((keep == 0)); then
    rm -f "${f}"
    echo "Rotated out $(basename "${f}")"
  fi
done

echo "Backups retained: $(find "${BACKUP_DIR}" -maxdepth 1 -name 'released-db-*.sql.gz' | wc -l | tr -d ' ')"
