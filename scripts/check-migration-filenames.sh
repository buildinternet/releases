#!/usr/bin/env bash
# Fails if any migration file added on the current branch uses the legacy
# NNNN_ numeric prefix. New migrations must use a YYYYMMDDHHMMSS_ timestamp
# prefix to prevent filename collisions between concurrent branches.
#
# Existing numeric files (0000..0008 Drizzle, 0000..0011 D1) are grandfathered
# in — renaming them would break __drizzle_migrations / d1_migrations tracking
# state on already-migrated DBs.
set -euo pipefail

base="${1:-origin/main}"

added=$(git diff --name-only --diff-filter=A "$base"...HEAD -- \
  'src/db/migrations/*.sql' 'workers/api/migrations/*.sql' || true)

if [ -z "$added" ]; then
  exit 0
fi

bad=$(echo "$added" | grep -E '/[0-9]{4}_[^/]+\.sql$' || true)

if [ -n "$bad" ]; then
  echo "ERROR: New migration files must use a timestamp prefix (YYYYMMDDHHMMSS_*.sql)." >&2
  echo "Offending files:" >&2
  echo "$bad" | sed 's/^/  /' >&2
  echo >&2
  echo "For Drizzle migrations, run 'bun run db:generate' — the prefix is set in drizzle.config.ts." >&2
  echo "For D1 migrations under workers/api/migrations/, name the file manually with 'date +%Y%m%d%H%M%S'." >&2
  exit 1
fi
