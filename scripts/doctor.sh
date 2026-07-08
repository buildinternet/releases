#!/usr/bin/env bash
#
# Diagnose the local dev setup — the read-only inverse of bootstrap.sh.
#
# Scans installed tooling, the local D1 database, and env files, then reports
# what's present, what's missing, and how to fix each gap. Never installs or
# mutates anything. Exits non-zero if a REQUIRED check fails (usable as a
# pre-flight gate).
#
#   bun run doctor           # report
#   bun run doctor --strict  # treat warnings as failures too
set -uo pipefail

STRICT=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    -h | --help)
      sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0
WARNS=0

c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_red=$'\033[31m'
c_cyan=$'\033[36m'
c_dim=$'\033[2m'
c_off=$'\033[0m'

pass() { printf '  %s✓%s %s\n' "$c_green" "$c_off" "$1"; }
info() { printf '  %si%s %s\n' "$c_cyan" "$c_off" "$1"; }
# warn <label> <fix>
warn() {
  WARNS=$((WARNS + 1))
  printf '  %s⚠%s %s\n' "$c_yellow" "$c_off" "$1"
  [ -n "${2:-}" ] && printf '      %s→ %s%s\n' "$c_dim" "$2" "$c_off"
}
# fail <label> <fix>
fail() {
  ERRORS=$((ERRORS + 1))
  printf '  %s✗%s %s\n' "$c_red" "$c_off" "$1"
  [ -n "${2:-}" ] && printf '      %s→ %s%s\n' "$c_dim" "$2" "$c_off"
}
have() { command -v "$1" >/dev/null 2>&1; }
section() { printf '\n%s\n' "$1"; }

echo "Releases — environment doctor"

# ── Runtime ──────────────────────────────────────────────────────────────────
section "Runtime"
if have bun; then
  pass "bun $(bun --version) installed"
else
  fail "bun not found — the runtime + package manager for this repo" \
    "install Bun: https://bun.sh  (curl -fsSL https://bun.sh/install | bash), or: bun run bootstrap"
fi

# Node ≥24 is only needed for portless (the dev:* HTTPS hosts). The preview:*
# scripts don't need it — so a low/absent Node is a warning, never a failure.
if have node; then
  node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$node_major" -ge 24 ]; then
    pass "node $(node -v) (≥24, satisfies portless)"
  else
    warn "node $(node -v) is below portless's required ≥24 — the dev:* HTTPS hosts won't resolve" \
      "upgrade Node to ≥24, or use the plain-port fallback: bun run preview:api / preview:web"
  fi
else
  info "node not found — needed only for portless; the preview:* scripts run without it"
fi

if [ -d "$ROOT/node_modules" ]; then
  pass "dependencies installed (node_modules present)"
else
  fail "dependencies not installed" "bun install"
fi

# ── Local dev hosts ──────────────────────────────────────────────────────────
section "Local dev (portless)"
if have portless; then
  pass "portless $(portless --version 2>/dev/null || echo '') installed"
  info "proxy/DNS/CA health isn't checked here — run 'bunx portless doctor' if dev:* URLs don't resolve"
else
  warn "portless not found — the dev:* scripts exec 'portless run' and can't bind their HTTPS hosts" \
    "npm i -g portless  (or: bun run bootstrap) — or use the preview:* plain-port scripts instead"
fi

# ── Local D1 database ────────────────────────────────────────────────────────
section "Local D1 database"
if have wrangler; then
  pass "wrangler on PATH"
else
  info "wrangler not on PATH — that's fine, the db:*/dev:* scripts invoke it via bun"
fi

if [ -d "$ROOT/workers/api/.wrangler/state/v3/d1" ]; then
  pass "local D1 state present (workers/api/.wrangler/state/v3/d1)"
else
  warn "local D1 not built yet — dev:api will 500 on DB-backed routes" \
    "bun run db:reset:local  (builds a fresh D1 from migrations)"
fi

# ── Env files ────────────────────────────────────────────────────────────────
section "Env files"
# workers/api/.dev.vars drives local auth — the one env file that materially
# affects the core dev loop (sign-in). The rest degrade gracefully.
API_DEV_VARS="$ROOT/workers/api/.dev.vars"
if [ -f "$API_DEV_VARS" ]; then
  pass "workers/api/.dev.vars present (local auth/AI fallbacks)"
  if grep -qE '^BETTER_AUTH_SECRET_DEV=.+$' "$API_DEV_VARS" &&
    ! grep -qE '^BETTER_AUTH_SECRET_DEV=replace-with-any-stable-string$' "$API_DEV_VARS"; then
    pass "BETTER_AUTH_SECRET_DEV is set (local sessions survive dev:api restarts)"
  else
    warn "BETTER_AUTH_SECRET_DEV is unset or still the placeholder — local sessions reset on each restart (#1425)" \
      "set it to any stable string in workers/api/.dev.vars  (or re-run: bun run bootstrap)"
  fi
else
  warn "workers/api/.dev.vars missing — local sign-in and secret-backed routes fail" \
    "cp workers/api/.dev.vars.example workers/api/.dev.vars  (or: bun run bootstrap)"
fi

for w in mcp discovery webhooks; do
  if [ -f "$ROOT/workers/$w/.dev.vars" ]; then
    pass "workers/$w/.dev.vars present"
  else
    info "workers/$w/.dev.vars absent — optional (only needed to run dev:$w with bound secrets)"
  fi
done

[ -f "$ROOT/web/.env.local" ] && pass "web/.env.local present" \
  || info "web/.env.local absent — optional (dev:web falls back to sensible defaults)"
[ -f "$ROOT/.env" ] && pass "root .env present (CLI + deploy credentials)" \
  || info "root .env absent — optional (only needed for AI passes, scrape fetches, and deploys)"

# ── Optional keys ────────────────────────────────────────────────────────────
section "Optional API keys"
# The core loop (install / check / test / dev against local D1) is secret-free.
# These unlock the AI + scrape + semantic-search paths; absence degrades, not breaks.
env_has() { [ -f "$ROOT/.env" ] && grep -qE "^$1=.+" "$ROOT/.env" 2>/dev/null; }
for key in ANTHROPIC_API_KEY CLOUDFLARE_API_TOKEN VOYAGE_API_KEY GITHUB_TOKEN; do
  if [ -n "${!key:-}" ] || env_has "$key"; then
    pass "$key set"
  else
    info "$key not set — the dependent path degrades gracefully (AI/scrape/search)"
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
section "Summary"
if [ "$ERRORS" -gt 0 ]; then
  printf '  %s%s error(s)%s, %s warning(s) — fix the ✗ items above\n' "$c_red" "$ERRORS" "$c_off" "$WARNS"
  exit 1
elif [ "$WARNS" -gt 0 ]; then
  printf '  0 errors, %s%s warning(s)%s\n' "$c_yellow" "$WARNS" "$c_off"
  [ "$STRICT" = 1 ] && exit 1
  exit 0
else
  printf '  %sall checks passed%s — run `bun run check` before opening a PR\n' "$c_green" "$c_off"
  exit 0
fi
