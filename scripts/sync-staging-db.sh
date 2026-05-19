#!/usr/bin/env bash
#
# Snapshot a subset of the production D1 (released-db) into the staging D1
# (released-db-staging). Content-heavy tables only — observability, queues,
# webhook state, and vectorize-adjacent tables are skipped because staging
# either doesn't have those bindings or shouldn't pollute prod signals.
#
# Flow:
#   1. `wrangler d1 export --remote --no-schema` on prod for each table → dump.sql
#   2. DELETE FROM each staging table (reverse dep order, under PRAGMA
#      foreign_keys=OFF for the duration)
#   3. `wrangler d1 execute --remote --file=dump.sql` against staging
#
# Requirements:
#   - wrangler authenticated (`wrangler whoami`) with access to the
#     Build Internet account (or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID set)
#   - run from the repo root or workers/api/
#
# Usage:
#   ./scripts/sync-staging-db.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="${REPO_ROOT}/workers/api"
WORK_DIR="$(mktemp -d -t releases-sync-XXXXXX)"
DUMP_FILE="${WORK_DIR}/prod-dump.sql"
WIPE_FILE="${WORK_DIR}/wipe.sql"

trap 'rm -rf "${WORK_DIR}"' EXIT

# Tables to copy. Dependency-safe insert order (parents before children).
# Keep in sync with packages/core/src/schema.ts + src/db/schema-coverage.ts.
# d1_migrations leads because it has no FKs and we want it stamped before any
# data INSERTs that depend on the post-migration schema.
TABLES=(
  d1_migrations
  organizations
  org_accounts
  products
  domain_aliases
  tags
  org_tags
  product_tags
  sources
  releases
  ignored_urls
  blocked_urls
  release_summaries
  media_assets
  knowledge_pages
  release_coverage
)

# Deliberately NOT copied:
#   usage_log, fetch_log, telemetry_events, cron_runs   (observability; regenerate)
#   source_changelog_chunks                              (tied to Vectorize, staging skips it)
#   source_changelog_files                               (content column hits D1's ~1MB
#                                                         per-statement limit on the biggest
#                                                         CHANGELOG.md files; the /v1/sources/:slug/changelog
#                                                         endpoint just degrades on staging)
#   webhook_subscriptions                                (per-user state; don't mirror)
#
# d1_migrations IS copied (above): mirroring prod's migration log keeps
# staging's wrangler state aligned with the schema. Without this, ad-hoc DDL
# applied to staging during dev (e.g. `wrangler d1 execute --file` instead of
# `wrangler d1 migrations apply`) leaves staging's schema ahead of its log,
# and the next CI deploy fails with `duplicate column`/`already exists`.

echo "== releases staging DB sync =="
echo "Prod DB:    released-db"
echo "Staging DB: released-db-staging"
echo "Tables:     ${#TABLES[@]}"
echo

cd "${API_DIR}"

# Build the --table arg list once
TABLE_ARGS=()
for t in "${TABLES[@]}"; do
  TABLE_ARGS+=(--table="${t}")
done

echo ">> 1/3 Exporting prod data-only dump (this can take a few minutes)..."
bunx wrangler d1 export DB \
  --remote \
  --no-schema \
  "${TABLE_ARGS[@]}" \
  --output="${DUMP_FILE}"

SIZE=$(du -h "${DUMP_FILE}" | cut -f1)
LINES=$(wc -l <"${DUMP_FILE}" | tr -d ' ')
echo "   wrote ${DUMP_FILE} (${SIZE}, ${LINES} lines)"

# D1's server-side cap rejects statements where a single string literal is
# "too big" (SQLITE_TOOBIG). Empirically, inserts with column values around
# 125KB fail — safest threshold observed is ~90KB. Drop any INSERT line over
# that size; it's a few-dozen release.content rows out of ~25k. Staging can
# re-fetch them on demand via a targeted CLI refresh if needed.
FILTERED_FILE="${WORK_DIR}/prod-dump.filtered.sql"
MAX_LINE_BYTES=90000
SKIPPED=$(awk -v max="${MAX_LINE_BYTES}" '
  /^INSERT / && length($0) > max { skipped++; next }
  { print }
  END { print skipped + 0 > "/dev/stderr" }
' "${DUMP_FILE}" 2>&1 >"${FILTERED_FILE}")
echo "   dropped ${SKIPPED} oversized INSERT line(s) (> ${MAX_LINE_BYTES} bytes)"
DUMP_FILE="${FILTERED_FILE}"

echo
echo ">> 2/3 Wiping staging tables in reverse order..."
# Reverse the array for DELETE ordering (children before parents).
WIPE_ORDER=()
for ((i=${#TABLES[@]}-1; i>=0; i--)); do
  WIPE_ORDER+=("${TABLES[i]}")
done

{
  echo "PRAGMA foreign_keys = OFF;"
  for t in "${WIPE_ORDER[@]}"; do
    echo "DELETE FROM ${t};"
  done
  echo "PRAGMA foreign_keys = ON;"
} > "${WIPE_FILE}"

bunx wrangler d1 execute DB \
  --env staging \
  --remote \
  --file="${WIPE_FILE}" \
  --yes

echo
echo ">> 3/3 Importing prod snapshot into staging (chunked)..."
# Wrangler's `d1 execute --file` bundles statements into a single server-side
# batch and fails with SQLITE_TOOBIG when the bundle exceeds ~1MB. Some
# releases carry ~125KB `content`, so a flat row cap doesn't bound chunk size
# reliably — we budget bytes instead. 500 KiB is well under the limit and
# leaves headroom for the largest escaped INSERTs observed in prod.
CHUNK_DIR="${WORK_DIR}/chunks"
mkdir -p "${CHUNK_DIR}"
awk -v chunk_dir="${CHUNK_DIR}" -v max_bytes=524288 '
  BEGIN { idx = 0; bytes = 0; out = sprintf("%s/chunk-%06d.sql", chunk_dir, idx) }
  {
    # Rotation is gated on /^INSERT / so PRAGMA/COMMIT/etc. never start a new
    # chunk — they stay glued to the surrounding INSERT block.
    if (/^INSERT / && bytes > 0 && bytes + length($0) + 1 > max_bytes) {
      close(out)
      out = sprintf("%s/chunk-%06d.sql", chunk_dir, ++idx)
      bytes = 0
    }
    bytes += length($0) + 1
    print >> out
  }
  END { close(out) }
' "${DUMP_FILE}"

CHUNK_COUNT=$(find "${CHUNK_DIR}" -name 'chunk-*.sql' | wc -l | tr -d ' ')
echo "   split into ${CHUNK_COUNT} chunks"

i=0
for chunk in "${CHUNK_DIR}"/chunk-*.sql; do
  i=$((i + 1))
  printf "   [%d/%d] %s\n" "${i}" "${CHUNK_COUNT}" "$(basename "${chunk}")"
  bunx wrangler d1 execute DB \
    --env staging \
    --remote \
    --file="${chunk}" \
    --yes >/dev/null
done

echo
echo "== Done =="
echo "Verify with:"
echo "  bunx wrangler d1 execute DB --env staging --remote --command='SELECT COUNT(*) FROM releases'"
