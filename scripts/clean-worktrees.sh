#!/usr/bin/env bash
#
# clean-worktrees.sh — reclaim stale per-task worktrees and their dev servers.
#
# The on-demand broom companion to the per-session SessionEnd teardown
# (session-teardown.sh). Where that hook only cleans the session that's ending,
# this sweeps everything left behind: worktrees whose PR has already merged or
# closed, plus any orphaned dev-server processes (wrangler/workerd/next/…) still
# running inside this repo's worktrees.
#
# Safe by construction:
#   - Only removes a worktree whose branch has a MERGED or CLOSED PR (the
#     reliable "done" signal — this repo squash-merges, so commit-ancestry
#     checks wrongly report merged branches as unmerged). Open-PR and no-PR
#     worktrees are kept and reported.
#   - Never removes a worktree with uncommitted changes (the branch is always
#     preserved regardless, so a clean removal loses nothing).
#   - Only signals dev-server processes whose working directory is under THIS
#     repo's .claude/worktrees — never another checkout (e.g. a sibling repo).
#
# Usage:
#   bun run clean:worktrees                  # sweep
#   bun run clean:worktrees -- --dry-run     # preview only (note the `--`)
#   scripts/clean-worktrees.sh [--dry-run] [--no-kill-servers]
#
#   --dry-run         print what would happen; change nothing
#   --no-kill-servers leave dev-server processes running; only remove worktrees
#
set -uo pipefail

DRY_RUN=0
KILL_SERVERS=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-kill-servers) KILL_SERVERS=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "clean-worktrees: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

MAIN_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not in a git repo" >&2; exit 1; }
# Resolve to the MAIN working tree even if invoked from a linked worktree.
COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
MAIN_ROOT="$(dirname "$COMMON")"
WT_DIR="$MAIN_ROOT/.claude/worktrees"
# Legacy worktree location still present in this repo alongside .claude/worktrees.
WT_DIR_LEGACY="$MAIN_ROOT/.worktrees"

run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

# --- 1. Kill orphaned dev-server processes inside this repo's worktrees ------
if [ "$KILL_SERVERS" = 1 ]; then
  echo "== dev-server processes under $WT_DIR (and $WT_DIR_LEGACY) =="
  found=0
  for pid in $(pgrep -f 'workerd|wrangler|next-server|vitest|esbuild' 2>/dev/null); do
    pcwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "$pcwd" in
      "$WT_DIR"/*|"$WT_DIR_LEGACY"/*)
        found=$((found + 1))
        echo "  pid $pid  $pcwd"
        if [ "$DRY_RUN" = 0 ]; then kill -TERM "$pid" 2>/dev/null; fi
        ;;
    esac
  done
  [ "$found" = 0 ] && echo "  (none)"
  if [ "$found" -gt 0 ] && [ "$DRY_RUN" = 0 ]; then
    sleep 2
    for pid in $(pgrep -f 'workerd|wrangler|next-server|vitest|esbuild' 2>/dev/null); do
      pcwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
      case "$pcwd" in "$WT_DIR"/*|"$WT_DIR_LEGACY"/*) kill -KILL "$pid" 2>/dev/null ;; esac
    done
    echo "  stopped $found process(es)"
  fi
fi

# --- 2. Remove worktrees whose PR has merged or closed ----------------------
HAVE_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then HAVE_GH=1; fi
[ "$HAVE_GH" = 0 ] && echo "== gh unavailable: skipping PR-based removal (only pruning) =="

echo "== worktrees =="
# Iterate registered linked worktrees (skip the main tree).
git worktree list --porcelain | awk '/^worktree /{wt=$2} /^branch /{print wt"\t"$2}' | while IFS=$'\t' read -r wt ref; do
  [ "$wt" = "$MAIN_ROOT" ] && continue
  name="$(basename "$wt")"
  branch="${ref#refs/heads/}"

  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    echo "  KEEP  $name — uncommitted changes"
    continue
  fi
  if [ "$HAVE_GH" = 0 ]; then
    echo "  KEEP  $name — gh unavailable, cannot confirm PR state"
    continue
  fi

  state="$(gh pr list --head "$branch" --state all --limit 1 --json state --jq '.[0].state' 2>/dev/null)"
  case "$state" in
    MERGED|CLOSED)
      echo "  DROP  $name — PR $state"
      run git -C "\"$MAIN_ROOT\"" worktree remove "\"$wt\""
      ;;
    OPEN)
      echo "  KEEP  $name — PR still open"
      ;;
    *)
      echo "  KEEP  $name — no PR found"
      ;;
  esac
done

echo "== prune stale registry entries =="
run git worktree prune -v

echo "done."
