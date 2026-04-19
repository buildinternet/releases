#!/usr/bin/env bash
# Bootstraps a freshly-created git worktree: installs deps and copies env
# files from the main checkout. Run once after `git worktree add <path>`:
#
#   ./scripts/setup-worktree.sh
#
# Idempotent — won't overwrite files that already exist in the worktree.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# First entry from `git worktree list --porcelain` is the main checkout.
MAIN="$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')"

if [ -z "$MAIN" ]; then
  echo "!! could not determine main checkout path — aborting env copy"
  exit 1
fi

copy_if_missing() {
  local rel="$1"
  local src="$MAIN/$rel"
  local dst="$ROOT/$rel"

  if [ "$MAIN" = "$ROOT" ]; then
    return 0  # running from main checkout itself
  fi
  if [ -e "$dst" ]; then
    echo "==> $rel already present, skipping"
    return 0
  fi
  if [ ! -e "$src" ]; then
    echo "!! $rel missing from main checkout ($src) — skipping"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "==> copied $rel from main checkout"
}

if [ ! -d node_modules ]; then
  echo "==> bun install"
  bun install
else
  echo "==> node_modules present, skipping bun install"
fi

copy_if_missing .env
copy_if_missing web/.env.local

echo "==> setup complete"
