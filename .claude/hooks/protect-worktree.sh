#!/usr/bin/env bash
# protect-worktree.sh — in a worktree session, block `cd` into the MAIN checkout.
#
# The failure this exists for is silent, which is why it needs a hook rather
# than care. On 2026-07-28 a full verification pass (`bun run lint`, `bun test
# web/`, `bun test workers/api`) ran with a `cd <main checkout>` prefix while
# the session's work lived in a worktree. Everything passed — against a tree
# that contained none of the changes. Nothing was dirty, nothing collided,
# no command errored. The only tell was a test count that went DOWN.
#
# Contrast the loud version of this same mistake (agent edits or commits
# landing in the main tree), which announces itself via a dirty `git status`
# and cross-session collisions. A read in the wrong tree announces nothing —
# it just returns a confident green.
#
# Why a blanket block is safe: a linked worktree IS the same repository. `gh`
# resolves the same remote from here, `git log`/`git show` see the same
# objects, and every build/test script is tree-relative. There is no task that
# requires standing in the main checkout from a worktree session — which is
# also how the habit forms unpunished, since `cd <main> && gh ...` is inert
# while `cd <main> && bun test` silently tests the wrong source.
#
# Scope, deliberately narrow:
#   Blocked  — the main checkout root, and paths beneath it
#   Allowed  — sibling repos (releases-cli, homebrew-tap), any other path,
#              and .claude/worktrees/* beneath the main checkout
#   Inactive — sessions whose project dir IS the main checkout
#
# The main checkout is derived from git (`--git-common-dir`), never hardcoded:
# this repo is public and must not carry absolute home-dir paths.
#
# Like protect-env.sh this is a convenience guard, not a security boundary, so
# it FAILS OPEN: if git can't answer, the command runs. A guard that blocked
# on ambiguity would strand work for no safety gain.

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[ -n "$CMD" ] || exit 0

PROJECT_DIR=${CLAUDE_PROJECT_DIR:-$PWD}

# Absolute, symlink-resolved form of a directory, or empty if it doesn't exist.
# Using `cd`+`pwd -P` rather than realpath keeps this portable to the macOS
# default userland, and normalizes `~`, relative paths, and `..` in one step.
resolve() { (cd "$1" 2>/dev/null && pwd -P) || true; }

# The main checkout is the parent of the common git dir. For a linked worktree
# `--git-dir` points at .git/worktrees/<name> while `--git-common-dir` still
# points at the main .git — that difference is what identifies a worktree.
COMMON=$(git -C "$PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ -n "$COMMON" ] || exit 0
MAIN=$(resolve "$(dirname "$COMMON")")
HERE=$(resolve "$PROJECT_DIR")
[ -n "$MAIN" ] && [ -n "$HERE" ] || exit 0

# Not a worktree session (or git returned something unexpected) — stand down.
[ "$HERE" != "$MAIN" ] || exit 0

WORKTREE_HOME="$MAIN/.claude/worktrees"

# Pull the argument of each `cd`/`pushd` used as a command word: at the start
# of the string, or after a separator (; & | && ||, or a newline). Requiring a
# command position is what keeps `echo 'cd /somewhere'` from tripping the guard.
# Quotes are stripped after extraction so `cd "a b"` resolves as one path.
targets=$(printf '%s\n' "$CMD" \
  | grep -oE '(^|[;&|])[[:space:]]*(cd|pushd)[[:space:]]+("[^"]*"|'\''[^'\'']*'\''|[^[:space:];&|]+)' \
  | sed -E 's/^.*(cd|pushd)[[:space:]]+//' \
  | tr -d '"'\''' || true)

while IFS= read -r raw; do
  [ -n "$raw" ] || continue
  # Expand a leading ~ ourselves; it is literal text here, not shell-expanded.
  case "$raw" in
    "~") raw="$HOME" ;;
    "~/"*) raw="$HOME/${raw#\~/}" ;;
  esac
  # Relative targets resolve against the session dir, matching what the shell
  # would do — `cd ../../..` from a worktree can reach the main checkout.
  case "$raw" in
    /*) candidate="$raw" ;;
    *) candidate="$HERE/$raw" ;;
  esac
  target=$(resolve "$candidate")
  [ -n "$target" ] || continue

  # Worktrees live beneath the main checkout; they are the point of all this.
  case "$target" in
    "$WORKTREE_HOME" | "$WORKTREE_HOME"/*) continue ;;
  esac

  # Exact match or a path strictly beneath it. The trailing-slash form is what
  # keeps a sibling like `<main>-cli` from matching `<main>` as a prefix.
  case "$target" in
    "$MAIN" | "$MAIN"/*)
      echo "Blocked: 'cd $raw' leaves this worktree for the main checkout ($MAIN)." >&2
      echo "This session's work is in $HERE. Running builds or tests after that cd" >&2
      echo "silently exercises the WRONG source tree and reports a confident pass." >&2
      echo "A worktree is the same repository: gh, git history, and every test" >&2
      echo "script already work from here — drop the cd. Other repos are unaffected." >&2
      exit 2
      ;;
  esac
done <<EOF
$targets
EOF

exit 0
