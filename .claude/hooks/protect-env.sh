#!/usr/bin/env bash
# protect-env.sh — block Claude Code from MODIFYING env / secret files.
#
# Reads are never blocked: `source .env`, `cat`, `grep`, `printenv`,
# `test -n "$VAR"` all still work. Per CLAUDE.md the user edits env files
# themselves, so this guard turns that convention into a hard stop on the
# normal edit path and a best-effort stop on obvious Bash writes.
#
#   Protected:  .env, .env.<anything>, .dev.vars, *.dev.vars
#   Allowed:    *.example, *.sample, *.template  (templates are safe to edit)
#
# Registered on PreToolUse for Edit|Write|MultiEdit|NotebookEdit (checks
# file_path) and Bash (best-effort scan of redirections / tee). The Bash scan
# is defense-in-depth only — the permission system, not this hook, is the hard
# enforcement boundary; sed -i / cp / mv are intentionally NOT covered.

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')

is_protected() {
  # Lowercase the basename first: APFS (macOS) and NTFS resolve paths
  # case-insensitively, so `.ENV` is the SAME file as `.env`. Matching
  # case-sensitively here would let a differently-cased name slip past the
  # guard. Keep this normalization if you edit the patterns below.
  local name
  name=$(basename "$1" | tr '[:upper:]' '[:lower:]')
  case "$name" in
    *.example | *.sample | *.template) return 1 ;;
    .env | .env.* | .dev.vars | *.dev.vars) return 0 ;;
    *) return 1 ;;
  esac
}

block() {
  echo "Blocked: $1 is an env/secret file — per CLAUDE.md the user must edit it themselves. Ask them to make the change. (Reading/sourcing is unaffected.)" >&2
  exit 2
}

case "$TOOL" in
  Edit | Write | MultiEdit | NotebookEdit)
    FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
    [ -n "$FILE" ] && is_protected "$FILE" && block "$FILE"
    ;;
  Bash)
    CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
    # Pull the token following a write operator ( > , >> , tee [-a] ) and test
    # each against is_protected (which exempts *.example/.sample/.template).
    targets=$(printf '%s' "$CMD" \
      | grep -oE '(>>?[[:space:]]*|[[:space:]]tee[[:space:]]+(-a[[:space:]]+)?)(\./)?[A-Za-z0-9._/-]+' \
      | grep -oE '[A-Za-z0-9._/-]+$' || true)
    for t in $targets; do
      is_protected "$t" && block "$t (via Bash redirection/tee)"
    done
    ;;
esac
exit 0
