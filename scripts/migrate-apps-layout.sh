#!/usr/bin/env bash
#
# One-shot migration for OTHER checkouts after the web/ + workers/* → apps/*
# rename. `git pull` moves every TRACKED file for you; this script only moves
# the gitignored local state that git never touched and would otherwise be
# left orphaned in the old directories (most importantly apps/api's local D1
# under .wrangler/).
#
# Safe to run more than once — already-migrated items are skipped.
#
# Usage:
#   scripts/migrate-apps-layout.sh [checkout-path] [--dry-run|--apply]
#
#   checkout-path   defaults to `git rev-parse --show-toplevel` from cwd
#   --dry-run       print what would happen; change nothing (DEFAULT)
#   --apply         actually move files
#
# Never run this with --apply against a checkout you haven't pulled the
# apps/ rename into yet — it only relocates gitignored state, it does not
# move tracked files.
set -euo pipefail

APPLY=0
CHECKOUT=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "migrate-apps-layout: unknown option '$arg'" >&2
      exit 2
      ;;
    *)
      if [ -n "$CHECKOUT" ]; then
        echo "migrate-apps-layout: unexpected extra argument '$arg'" >&2
        exit 2
      fi
      CHECKOUT="$arg"
      ;;
  esac
done

if [ -z "$CHECKOUT" ]; then
  CHECKOUT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "migrate-apps-layout: not in a git repo and no checkout path given" >&2
    exit 1
  }
fi
CHECKOUT="$(cd "$CHECKOUT" && pwd)"

# Gitignored items worth rescuing. .wrangler/ (local D1 state) matters most —
# losing it means rebuilding the local database from migrations.
ITEMS=(.dev.vars .env.local .env .wrangler .next node_modules)

# old-dir:new-dir pairs.
PAIRS=(
  "web:apps/web"
  "workers/api:apps/api"
  "workers/mcp:apps/mcp"
  "workers/discovery:apps/discovery"
  "workers/webhooks:apps/webhooks"
)

if [ "$APPLY" = 1 ]; then
  echo "== migrate-apps-layout: applying in $CHECKOUT =="
else
  echo "== migrate-apps-layout: DRY RUN in $CHECKOUT (pass --apply to act) =="
fi

moved=0
skipped=0
for pair in "${PAIRS[@]}"; do
  old_rel="${pair%%:*}"
  new_rel="${pair##*:}"
  old_dir="$CHECKOUT/$old_rel"
  new_dir="$CHECKOUT/$new_rel"

  [ -d "$old_dir" ] || continue
  echo "-- $old_rel -> $new_rel"

  for item in "${ITEMS[@]}"; do
    old_path="$old_dir/$item"
    new_path="$new_dir/$item"

    [ -e "$old_path" ] || continue

    if [ -e "$new_path" ]; then
      echo "   !! both exist, skipping: $old_rel/$item (already at $new_rel/$item too)"
      skipped=$((skipped + 1))
      continue
    fi

    if [ "$APPLY" = 1 ]; then
      mkdir -p "$new_dir"
      mv "$old_path" "$new_path"
      echo "   moved $old_rel/$item -> $new_rel/$item"
    else
      echo "   [dry-run] would move $old_rel/$item -> $new_rel/$item"
    fi
    moved=$((moved + 1))
  done
done

echo
echo "== cleanup =="
for pair in "${PAIRS[@]}"; do
  old_rel="${pair%%:*}"
  old_dir="$CHECKOUT/$old_rel"
  [ -d "$old_dir" ] || continue

  if [ "$APPLY" = 1 ]; then
    if rmdir "$old_dir" 2>/dev/null; then
      echo "removed empty $old_rel"
    else
      echo "left in place (not empty): $old_rel"
      find "$old_dir" -mindepth 1 -maxdepth 1 -exec echo "   {}" \;
    fi
  else
    if [ -z "$(find "$old_dir" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
      echo "[dry-run] would remove empty $old_rel"
    else
      echo "[dry-run] would leave in place (not empty): $old_rel"
    fi
  fi
done

# The parent `workers/` dir itself, only once every worker subdir is gone.
old_workers="$CHECKOUT/workers"
if [ -d "$old_workers" ]; then
  if [ "$APPLY" = 1 ]; then
    if rmdir "$old_workers" 2>/dev/null; then
      echo "removed empty workers/"
    else
      echo "left in place (not empty): workers/"
    fi
  else
    if [ -z "$(find "$old_workers" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
      echo "[dry-run] would remove empty workers/"
    else
      echo "[dry-run] would leave in place (not empty): workers/"
    fi
  fi
fi

echo
if [ "$APPLY" = 1 ]; then
  echo "Moved $moved item(s), skipped $skipped conflict(s)."
else
  echo "Would move $moved item(s), $skipped conflict(s) to resolve by hand. Re-run with --apply."
fi

echo
echo "Next steps:"
echo "  bun install"
echo "  (cd apps/discovery && bun install)"
echo "  (cd apps/mcp && bun install)"
echo "  (cd apps/webhooks && bun install)"
