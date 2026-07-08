#!/usr/bin/env bash
#
# One-command local setup — the whole thing on autopilot, idempotently.
# Re-running is safe: every step skips what's already done and never overwrites
# your real env files or wipes an existing local database.
#
# Steps:
#   1. tooling    — check Bun (the runtime); install portless (npm global) for
#                   the named HTTPS dev hosts, and flag Node < 24 (portless needs it)
#   2. install    — bun install
#   3. env files  — scaffold .env / web/.env.local / workers/*/.dev.vars from the
#                   committed *.example templates (only if absent), and mint a
#                   local Better Auth dev secret so sign-in works out of the box
#   4. database   — build a local D1 from migrations (only if none exists yet)
#   5. doctor     — verify the result
#
# Usage:
#   bun run bootstrap            # full setup
#   bun run bootstrap --skip-db  # tooling + deps + env only (no local D1)
#
# After it finishes:  bun run dev:api  &  bun run dev:web
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_DB=0
for arg in "$@"; do
  case "$arg" in
    --skip-db) SKIP_DB=1 ;;
    -h | --help)
      sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
add() { printf '  \033[33m+\033[0m %s\n' "$1"; }
note() { printf '  \033[36mi\033[0m %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

IS_MAC=0
[ "$(uname -s)" = "Darwin" ] && IS_MAC=1

# Copy a committed template to its real path only if the real one is absent.
scaffold() {
  local example="$1" real="$2"
  if [ -f "$real" ]; then
    ok "$real already exists — left untouched"
  elif [ -f "$example" ]; then
    cp "$example" "$real"
    add "created $real from $(basename "$example")"
  else
    note "no template at $example — skipped"
  fi
}

echo "Releases — local setup"

# ── 1. tooling ───────────────────────────────────────────────────────────────
step "Tooling (Bun, portless)"

# Bun is the runtime + package manager. Every script in this repo runs under it.
if have bun; then
  ok "bun $(bun --version) — already installed"
else
  if [ "$IS_MAC" = 1 ] && have brew; then
    add "installing bun via Homebrew…"
    brew install oven-sh/bun/bun
  else
    note "bun not found — install it, then re-run: https://bun.sh (curl -fsSL https://bun.sh/install | bash)"
    note "bun is required; aborting the rest of setup until it's on PATH"
    exit 1
  fi
fi

# Node 24+ is required by portless (the named-HTTPS-host proxy the dev:* scripts
# use). The preview:* scripts are the plain-port fallback if you'd rather skip it.
if have node; then
  node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$node_major" -ge 24 ]; then
    ok "node $(node -v) (≥24, satisfies portless)"
  else
    note "node $(node -v) is below portless's required ≥24 — the dev:* HTTPS hosts won't resolve"
    note "  either upgrade Node, or use the plain-port fallback: bun run preview:api / preview:web"
  fi
else
  note "node not found — needed only for portless; upgrade to Node ≥24 or use the preview:* scripts"
fi

# portless — named local HTTPS hosts (npm global, not a workspace dep). The dev:*
# scripts exec `portless run …`; without it use the preview:* plain-port scripts.
if have portless; then
  ok "portless $(portless --version 2>/dev/null || echo '') — already installed"
elif have npm; then
  add "installing portless via npm (global)…"
  npm i -g portless || note "portless install failed — install manually or use the preview:* scripts"
else
  note "portless missing and npm not found — install portless for the dev:* hosts, or use preview:* scripts"
fi

# ── 2. deps ──────────────────────────────────────────────────────────────────
step "Installing workspace dependencies"
bun install

# ── 3. env files ─────────────────────────────────────────────────────────────
step "Scaffolding env files (non-destructive)"
scaffold "$ROOT/.env.example" "$ROOT/.env"
scaffold "$ROOT/web/.env.example" "$ROOT/web/.env.local"
for w in api mcp discovery webhooks; do
  scaffold "$ROOT/workers/$w/.dev.vars.example" "$ROOT/workers/$w/.dev.vars"
done

# Mint a stable local Better Auth secret if .dev.vars still carries the template
# placeholder — otherwise local sessions reset on every dev:api restart (#1425).
DEV_VARS="$ROOT/workers/api/.dev.vars"
if [ -f "$DEV_VARS" ] && grep -qE '^BETTER_AUTH_SECRET_DEV=replace-with-any-stable-string$' "$DEV_VARS"; then
  if have openssl; then
    secret="$(openssl rand -base64 32)"
    # Portable in-place edit (BSD + GNU sed): write to a temp file, move back.
    tmp="$(mktemp)"
    sed "s#^BETTER_AUTH_SECRET_DEV=replace-with-any-stable-string\$#BETTER_AUTH_SECRET_DEV=${secret}#" \
      "$DEV_VARS" >"$tmp" && mv "$tmp" "$DEV_VARS"
    add "minted BETTER_AUTH_SECRET_DEV in workers/api/.dev.vars"
  else
    note "openssl not found — set BETTER_AUTH_SECRET_DEV to any stable string in workers/api/.dev.vars"
  fi
fi

# ── 4. database ──────────────────────────────────────────────────────────────
if [ "$SKIP_DB" = 1 ]; then
  step "Skipping local database (--skip-db)"
else
  step "Building the local D1 database"
  if [ -d "$ROOT/workers/api/.wrangler/state/v3/d1" ]; then
    ok "local D1 already present — left as-is (run 'bun run db:reset:local' to rebuild from scratch)"
  else
    # A fresh DB applies the squash baseline cleanly; db:reset:local is the
    # reliable path for a first build (see AGENTS.md → Local D1 schema parity).
    bun run db:reset:local \
      || note "DB build failed — see output above; 'bun run doctor' will detail what's missing"
  fi
fi

# ── 5. verify ────────────────────────────────────────────────────────────────
step "Verifying setup"
bash "$ROOT/scripts/doctor.sh" || true

cat <<'EOF'

Setup complete. Start the app:

  bun run dev:api      # API worker on local D1  (https://api.releases.localhost)
  bun run dev:web      # Next.js frontend        (https://releases.localhost)

  # No portless / Node < 24? Plain-port fallback:
  bun run preview:api  &  bun run preview:web

Run `bun run check` before opening a PR.

EOF
