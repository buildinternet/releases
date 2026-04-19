#!/usr/bin/env bash
# Bootstraps a freshly-created git worktree so dev servers can start.
# Run once after `git worktree add <path>`:
#
#   ./scripts/setup-worktree.sh
#
# Idempotent — skips work that's already done.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ ! -d node_modules ]; then
  echo "==> bun install"
  bun install
else
  echo "==> node_modules present, skipping bun install"
fi

# .env is gitignored and contains secrets — the user must link or create it
# themselves. We don't touch env files automatically.
if [ ! -f .env ]; then
  cat <<EOF

==> .env missing

This worktree needs a .env file. Either symlink it from your primary
checkout or copy + edit by hand. Example:

  ln -s ~/Code/released/.env "$ROOT/.env"

See .env.example for required variables.
EOF
fi

if [ ! -f web/.env.local ] && [ ! -f web/.env ]; then
  cat <<EOF

==> web/.env.local missing (optional)

The web frontend defaults to hitting api.releases.sh. To point it at a
local wrangler worker instead, create web/.env.local with:

  RELEASED_API_URL=http://localhost:8787

EOF
fi

echo "==> setup complete"
