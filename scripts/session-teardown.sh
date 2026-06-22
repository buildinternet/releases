#!/usr/bin/env bash
#
# session-teardown.sh — best-effort cleanup when a Claude Code session ends.
#
# Background agents spin up per-task git worktrees (EnterWorktree) and often
# start a local dev stack (`bun run dev:api`/`dev:web` → wrangler/workerd/next,
# or the `preview:*` scripts) to verify changes. When the job finishes, those
# servers keep running and the worktree lingers — over a day of parallel jobs
# this piles up dozens of stale worktrees and a hundred orphaned dev-server
# processes holding ports and memory.
#
# This runs from the SessionEnd hook and tears down ONLY the ending session's
# own worktree:
#   1. kill dev-server processes whose cwd is under this worktree, and
#   2. if the worktree is clean (no uncommitted/untracked work), remove it.
#
# Scoping to the session's own worktree is deliberate: it's safe to run while
# other jobs work in parallel — we never touch another worktree or another
# repo. The companion `clean-worktrees.sh` is the broader, on-demand broom.
#
# Best-effort by design: it must never fail a session teardown, so every step
# is guarded and the script always exits 0.

# Read the session cwd from the hook's JSON stdin (falls back to $PWD).
CWD=""
if [ ! -t 0 ]; then
  STDIN="$(cat 2>/dev/null || true)"
  CWD="$(printf '%s' "$STDIN" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$CWD" ] || CWD="$PWD"

# Resolve the worktree root + the main working tree from that cwd.
WT_ROOT="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)" || exit 0
COMMON="$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null)" || exit 0
case "$COMMON" in /*) : ;; *) COMMON="$CWD/$COMMON" ;; esac
MAIN_ROOT="$(cd "$(dirname "$COMMON")" 2>/dev/null && pwd)" || exit 0

# Only act inside a *linked* worktree under the repo's worktree dirs — never
# tear down the main working tree. Both conventions are in use here: the current
# EnterWorktree path (.claude/worktrees) and the legacy .worktrees dir.
case "$WT_ROOT" in
  "$MAIN_ROOT"/.claude/worktrees/*|"$MAIN_ROOT"/.worktrees/*) : ;;
  *) exit 0 ;;
esac

log() { echo "session-teardown: $*" 1>&2; }

# --- 1. Kill this worktree's dev-server processes ---------------------------
# Match only known dev-server signatures (not bare `bun`/`node`, so we can't
# hit the agent runtime), and only those whose working directory is inside THIS
# worktree. Exclude this script and its parent.
self=$$
parent=${PPID:-0}
killed=0
for pid in $(pgrep -f 'workerd|wrangler|next-server|vitest|esbuild' 2>/dev/null); do
  [ "$pid" = "$self" ] && continue
  [ "$pid" = "$parent" ] && continue
  pcwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$pcwd" in
    "$WT_ROOT"/*|"$WT_ROOT") kill -TERM "$pid" 2>/dev/null && killed=$((killed + 1)) ;;
  esac
done
[ "$killed" -gt 0 ] && log "stopped $killed dev-server process(es) in $(basename "$WT_ROOT")"

# Give them a beat to exit, then SIGKILL any that ignored SIGTERM.
if [ "$killed" -gt 0 ]; then
  sleep 2
  for pid in $(pgrep -f 'workerd|wrangler|next-server|vitest|esbuild' 2>/dev/null); do
    [ "$pid" = "$self" ] && continue
    pcwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "$pcwd" in
      "$WT_ROOT"/*|"$WT_ROOT") kill -KILL "$pid" 2>/dev/null ;;
    esac
  done
fi

# --- 2. Remove the worktree if it carries no uncommitted work ---------------
# `git worktree remove` refuses a dirty tree, but check first so we can keep a
# dirty worktree intact (and log it) rather than relying on the refusal. The
# branch is preserved either way, so a clean removal loses nothing.
if [ -n "$(git -C "$WT_ROOT" status --porcelain 2>/dev/null)" ]; then
  log "worktree $(basename "$WT_ROOT") has uncommitted changes — leaving it in place."
  exit 0
fi

# Must remove from outside the worktree being deleted, so step out first.
# (The script's own file stays readable via its open fd even once the directory
# is gone — POSIX unlink semantics — so execution finishes cleanly.)
cd "$MAIN_ROOT" 2>/dev/null || cd / || true
if git -C "$MAIN_ROOT" worktree remove "$WT_ROOT" 2>/dev/null; then
  log "removed clean worktree $(basename "$WT_ROOT") (branch preserved)."
else
  log "could not remove $(basename "$WT_ROOT") (in use?) — left in place."
fi

exit 0
