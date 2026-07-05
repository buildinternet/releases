# Standardize `RELEASED_` → `RELEASES_` env vars — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize every live `RELEASED_`-prefixed env var on `RELEASES_` across the monorepo and OSS CLI, honoring legacy names via a warn-once fallback, with a deploy-safe dual-binding rollout for the API-token secret.

**Architecture:** A `legacyEnv(canonical, legacy)` helper per runtime centralizes prefer-new / fall-back-to-old / warn-once. `process.env` reads route through `config.*()` accessors (monorepo `packages/lib`, CLI `packages/lib`) or web accessors (`web/src/lib/env.ts`); worker secret bindings read `env.RELEASES_API_KEY ?? env.RELEASED_API_KEY` with both bindings declared during the transition.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers (Hono), Next.js, Drizzle/D1, oxlint + prettier. Tests via `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-22-env-var-prefix-standardization-design.md` · **Tracking:** buildinternet/releases#1122

**Repos / branches:**

- Monorepo: this worktree, branch `worktree-env-prefix-standardization` (Tasks 1–11).
- CLI: `~/Code/releases-cli`, new branch `feat/releases-env-prefix` (Tasks 12–16).

**Operator prerequisite (gates Task 5 deploy, not the code):** create `RELEASES_API_KEY` in the Cloudflare Secrets Store (`store_id a887a71cab084105b79706df23380723`, same value as `RELEASED_API_KEY`) and add a `RELEASES_API_KEY` GitHub Actions repo secret. Tasks 1–4, 6–11 are deploy-safe without it.

---

## File structure

**Monorepo — create:**

- `packages/lib/src/legacy-env.ts` — Node/CLI `legacyEnv` helper (logger-based warn-once).
- `web/src/lib/env.ts` — web accessors (`apiBaseUrl`, `serverApiKey`, `staticBaseUrlEnv`).
- `tests/unit/legacy-env.test.ts` — helper unit tests.

**Monorepo — modify (high level):** `packages/lib/package.json` (export), `packages/lib/src/config.ts`, worker auth/session/types (`workers/api/src/middleware/auth.ts`, `workers/mcp/src/auth.ts`, `workers/mcp/src/mcp-agent.ts`, `workers/discovery/src/{index,managed-agents-session,types}.ts`, `workers/api/src/index.ts`, `workers/api/src/routes/media.ts`, `workers/api/src/cron/scrape-agent-sweep.ts`, `workers/api/src/workflows/scrape-agent-sweep.ts`), wrangler (`workers/{api,mcp,discovery}/wrangler.jsonc`), web reads (~25 sites), scripts (~10), `drizzle.config.ts`, `workers/discovery/Dockerfile`, `scripts/install.sh`, `package.json`, `.github/workflows/deploy-workers.yml`, `.env.example`, `web/.env.example`, docs, tests.

**CLI — create:** `packages/lib/src/legacy-env.ts`, test.
**CLI — modify:** `src/lib/mode.ts`, `src/lib/telemetry.ts`, `packages/lib/src/config.ts`, `src/cli/commands/onboard.ts`, `src/cli/completion/hint.ts`, `src/cli/commands/auth.ts`, `src/index.ts`, `src/cli/program.ts`, `.env.example`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `skills/releases-cli/**`, `.changeset/*.md`.

---

## Task 1: Node `legacyEnv` helper (monorepo)

**Files:**

- Create: `packages/lib/src/legacy-env.ts`
- Modify: `packages/lib/package.json` (add export)
- Test: `tests/unit/legacy-env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/legacy-env.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { legacyEnv, __resetLegacyEnvWarnings } from "@releases/lib/legacy-env";

describe("legacyEnv", () => {
  beforeEach(() => {
    delete process.env.RELEASES_FOO;
    delete process.env.RELEASED_FOO;
    __resetLegacyEnvWarnings();
  });
  afterEach(() => {
    delete process.env.RELEASES_FOO;
    delete process.env.RELEASED_FOO;
  });

  test("prefers the canonical var", () => {
    process.env.RELEASES_FOO = "new";
    process.env.RELEASED_FOO = "old";
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBe("new");
  });

  test("falls back to the legacy var", () => {
    process.env.RELEASED_FOO = "old";
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBe("old");
  });

  test("returns undefined when neither is set", () => {
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBeUndefined();
  });

  test("treats empty string as unset", () => {
    process.env.RELEASES_FOO = "";
    process.env.RELEASED_FOO = "old";
    expect(legacyEnv("RELEASES_FOO", "RELEASED_FOO")).toBe("old");
  });

  test("warns at most once per legacy name", () => {
    const calls: string[] = [];
    process.env.RELEASED_FOO = "old";
    legacyEnv("RELEASES_FOO", "RELEASED_FOO", (m) => calls.push(m));
    legacyEnv("RELEASES_FOO", "RELEASED_FOO", (m) => calls.push(m));
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("RELEASED_FOO");
    expect(calls[0]).toContain("RELEASES_FOO");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/legacy-env.test.ts`
Expected: FAIL — module `@releases/lib/legacy-env` not found.

- [ ] **Step 3: Create the helper**

```ts
// packages/lib/src/legacy-env.ts
import { logger } from "./logger";

const warned = new Set<string>();

/** Reset warn-once state. Test-only. */
export function __resetLegacyEnvWarnings(): void {
  warned.clear();
}

/**
 * Resolve an env var migrating from a legacy name to a canonical one. Prefers
 * `canonical`; falls back to `legacy` with a one-time deprecation warning.
 * Empty string counts as unset. Returns `undefined` when neither is set.
 *
 * `warn` is injectable for tests; defaults to the shared logger.
 */
export function legacyEnv(
  canonical: string,
  legacy: string,
  warn: (msg: string) => void = (msg) => logger.warn(msg),
): string | undefined {
  const next = process.env[canonical];
  if (next) return next;
  const old = process.env[legacy];
  if (old) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      warn(
        `${legacy} is deprecated; rename it to ${canonical}. The legacy name still works for now but will be removed.`,
      );
    }
    return old;
  }
  return undefined;
}
```

- [ ] **Step 4: Add the package export**

In `packages/lib/package.json`, add to `exports` (keep alphabetical):

```json
    "./legacy-env": "./src/legacy-env.ts",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/legacy-env.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/legacy-env.ts packages/lib/package.json tests/unit/legacy-env.test.ts
git commit -m "feat(lib): legacyEnv helper for RELEASED_->RELEASES_ fallback"
```

---

## Task 2: Shim `config.ts` accessors (monorepo)

`packages/lib/src/config.ts` is the single chokepoint for the CLI/runtime-neutral API key/url, data dir, and model vars. Route every `RELEASED_` read through `legacyEnv`, and add the two missing accessors (`stagingApiUrl`, `workerAgentModel`) so scripts stop reading `process.env` directly in later tasks.

**Files:**

- Modify: `packages/lib/src/config.ts`
- Test: `tests/unit/config-legacy-env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/config-legacy-env.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const KEYS = [
  "RELEASES_API_URL",
  "RELEASED_API_URL",
  "RELEASES_API_KEY",
  "RELEASED_API_KEY",
  "RELEASES_INGEST_MODEL",
  "RELEASED_INGEST_MODEL",
];

describe("config accessors honor both prefixes", () => {
  beforeEach(() => KEYS.forEach((k) => delete process.env[k]));
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));

  test("apiUrl prefers RELEASES_ then falls back to RELEASED_", async () => {
    const { config } = await import("@releases/lib/config");
    process.env.RELEASED_API_URL = "https://old";
    expect(config.apiUrl()).toBe("https://old");
    process.env.RELEASES_API_URL = "https://new";
    expect(config.apiUrl()).toBe("https://new");
  });

  test("apiKey falls back to RELEASED_API_KEY", async () => {
    const { config } = await import("@releases/lib/config");
    process.env.RELEASED_API_KEY = "legacy";
    expect(config.apiKey()).toBe("legacy");
  });

  test("ingestModel falls back, keeps default", async () => {
    const { config } = await import("@releases/lib/config");
    expect(config.ingestModel()).toBe("claude-haiku-4-5-20251001");
    process.env.RELEASED_INGEST_MODEL = "x";
    expect(config.ingestModel()).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/config-legacy-env.test.ts`
Expected: FAIL — `config.apiUrl()` returns `""` when only `RELEASED_API_URL` is set.

- [ ] **Step 3: Rewrite `config.ts`**

```ts
// packages/lib/src/config.ts
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { legacyEnv } from "./legacy-env";

let _dataDir: string | null = null;

export function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = legacyEnv("RELEASES_DATA_DIR", "RELEASED_DATA_DIR") || join(homedir(), ".releases");
    mkdirSync(_dataDir, { recursive: true });
  }
  return _dataDir;
}

export function getDbPath(): string {
  return join(getDataDir(), "releases.db");
}

export function getLogsDir(): string {
  const dir = join(getDataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const config = {
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || "",
  cloudflareAccountId: () => process.env.CLOUDFLARE_ACCOUNT_ID || "",
  cloudflareApiToken: () => process.env.CLOUDFLARE_API_TOKEN || "",
  githubToken: () => process.env.GITHUB_TOKEN || "",
  ingestModel: () =>
    legacyEnv("RELEASES_INGEST_MODEL", "RELEASED_INGEST_MODEL") || "claude-haiku-4-5-20251001",
  agentModel: () =>
    legacyEnv("RELEASES_AGENT_MODEL", "RELEASED_AGENT_MODEL") || "claude-sonnet-4-6",
  queryModel: () =>
    legacyEnv("RELEASES_QUERY_MODEL", "RELEASED_QUERY_MODEL") || "claude-sonnet-4-6",
  summaryModel: () =>
    legacyEnv("RELEASES_SUMMARY_MODEL", "RELEASED_SUMMARY_MODEL") || "claude-haiku-4-5-20251001",
  groupingModel: () =>
    legacyEnv("RELEASES_GROUPING_MODEL", "RELEASED_GROUPING_MODEL") || "claude-haiku-4-5-20251001",
  workerAgentModel: () =>
    legacyEnv("RELEASES_WORKER_AGENT_MODEL", "RELEASED_WORKER_AGENT_MODEL") ||
    "claude-haiku-4-5-20251001",
  apiUrl: () => legacyEnv("RELEASES_API_URL", "RELEASED_API_URL") || "",
  stagingApiUrl: () => legacyEnv("RELEASES_STAGING_API_URL", "RELEASED_STAGING_API_URL") || "",
  apiKey: () => legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY") || "",
} as const;
```

Note: `getDataDir` memoizes `_dataDir`; tests that toggle the data-dir env at runtime are not added here (existing `getDataDir` was already memoized). Confirm the default for `workerAgentModel` against `scripts/sync-agent-skills.ts:690` and match it exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/config-legacy-env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/config.ts tests/unit/config-legacy-env.test.ts
git commit -m "feat(lib): route config accessors through legacyEnv"
```

---

## Task 3: Worker secret-binding reads (monorepo)

Workers read the API token through a Secrets Store binding. Change every read to prefer the new binding and fall back to the old: `env.RELEASES_API_KEY ?? env.RELEASED_API_KEY`. Add the new binding to each worker's `Env` type as optional alongside the existing one. The `RELEASED_API_URL` binding/var (discovery) becomes `env.RELEASES_API_URL ?? env.RELEASED_API_URL`. No warn at worker sites — both bindings resolve in prod (dual-binding from Task 5), so the fallback is inert there.

**Files (modify):**

- `workers/api/src/middleware/auth.ts:47` — `getSecret(c.env.RELEASES_API_KEY ?? c.env.RELEASED_API_KEY)`
- `workers/api/src/index.ts:48` (Env type), `:590`, `:605` — read sites
- `workers/api/src/routes/media.ts:11` — Env type: add `RELEASES_API_KEY?: SecretBinding`
- `workers/api/src/cron/scrape-agent-sweep.ts:232,470` and `workers/api/src/workflows/scrape-agent-sweep.ts:66,172,185` — read sites
- `workers/mcp/src/auth.ts:46` — `getSecret(env.RELEASES_API_KEY ?? env.RELEASED_API_KEY)`
- `workers/mcp/src/mcp-agent.ts:115,357` — Env type: add `RELEASES_API_KEY?: SecretBinding`
- `workers/discovery/src/types.ts:65,66` — Env type: add `RELEASES_API_URL?: string` and `RELEASES_API_KEY?: SecretBinding`
- `workers/discovery/src/index.ts:143,154,211,489,501` — read sites (key + url)
- `workers/discovery/src/managed-agents-session.ts:413,457,1256,1275` — read sites (`getSecret(this.env.RELEASES_API_KEY ?? this.env.RELEASED_API_KEY)`, `this.env.RELEASES_API_URL ?? this.env.RELEASED_API_URL`)
- `src/agent/managed-discovery.ts:241,242,245` — local-dev path: `legacyEnv("RELEASES_API_URL","RELEASED_API_URL")` / `legacyEnv("RELEASES_API_KEY","RELEASED_API_KEY")` (import from `@releases/lib/legacy-env`); update the error string to name `RELEASES_API_URL`/`RELEASES_API_KEY`.

- [ ] **Step 1: Apply the binding-read transform**

For each `*_API_KEY` read: `getSecret(X.RELEASED_API_KEY)` → `getSecret(X.RELEASES_API_KEY ?? X.RELEASED_API_KEY)` (where `X` is `c.env` / `env` / `this.env`). For each `*_API_URL` read in discovery: `X.RELEASED_API_URL` → `X.RELEASES_API_URL ?? X.RELEASED_API_URL`. In `src/agent/managed-discovery.ts` use the `legacyEnv` helper (Node runtime, not a worker binding).

- [ ] **Step 2: Add Env types**

In each worker `Env`/types definition that declares `RELEASED_API_KEY: SecretBinding`, add a sibling `RELEASES_API_KEY?: SecretBinding` (optional during transition). In `workers/discovery/src/types.ts`, add `RELEASES_API_URL?: string` beside `RELEASED_API_URL`.

- [ ] **Step 3: Type-check each worker**

Run:

```bash
npx tsc --noEmit -p workers/api && npx tsc --noEmit -p workers/mcp && npx tsc --noEmit -p workers/discovery && npx tsc --noEmit
```

Expected: no errors. (If a worker has no tsconfig project flag, use the command from that worker's package script.)

- [ ] **Step 4: Run worker tests**

Run: `bun test tests/api tests/unit/mcp-auth.test.ts`
Expected: existing tests pass (fixtures still set `RELEASED_API_KEY`; the `??` keeps them green). Failures here mean a read site was missed.

- [ ] **Step 5: Commit**

```bash
git add workers src/agent/managed-discovery.ts
git commit -m "feat(workers): read RELEASES_API_KEY/URL with RELEASED_ fallback"
```

---

## Task 4: Web accessors + migrate web reads (monorepo)

**Files:**

- Create: `web/src/lib/env.ts`
- Modify: `web/src/lib/api.ts` (88, 96), `web/src/lib/base-url.ts` (11, 19, 20), `web/src/lib/admin-action.ts` (15, 16-17), `web/src/lib/local-admin-flag.ts` (12), `web/next.config.ts` (4), `web/src/app/layout.tsx` (12), `web/src/app/live/page.tsx` (25), `web/src/app/admin/status/page.tsx` (15), `web/src/app/actions/api-tokens.ts` (7, 30), `web/src/app/api/proxy/[...path]/route.ts` (5, 6), `web/src/app/api/category-releases/[slug]/route.ts` (5), `web/src/app/api/collection-releases/[slug]/route.ts` (4), `web/src/app/api/org-releases/[slug]/route.ts` (4), `web/src/app/api/source-releases/[orgSlug]/[sourceSlug]/route.ts` (4)
- Test: `web` has no bun-test setup for these; rely on `tsc` + the grep gate (Task 9).

- [ ] **Step 1: Create `web/src/lib/env.ts`**

```ts
// web/src/lib/env.ts
const warned = new Set<string>();

function legacyEnv(canonical: string, legacy: string): string | undefined {
  const next = process.env[canonical];
  if (next) return next;
  const old = process.env[legacy];
  if (old) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      console.warn(
        `[releases] ${legacy} is deprecated; rename it to ${canonical}. The legacy name still works for now but will be removed.`,
      );
    }
    return old;
  }
  return undefined;
}

/** API worker base URL (server + build-time). Empty string when unset. */
export function apiBaseUrl(): string {
  return legacyEnv("RELEASES_API_URL", "RELEASED_API_URL") ?? "";
}

/** Static root API token for server-to-API admin calls. Empty when unset. */
export function serverApiKey(): string {
  return legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY") ?? "";
}

/** Canonical-base-URL override for statically generated files. */
export function staticBaseUrlEnv(): string | undefined {
  return legacyEnv("RELEASES_BASE_URL", "RELEASED_BASE_URL");
}
```

- [ ] **Step 2: Migrate the reads**

Replace each direct read with the accessor:

- `process.env.RELEASED_API_URL` → `apiBaseUrl()` (import from `@/lib/env`). For `web/next.config.ts` (runs in Node config context, no `@/` alias guaranteed) inline `process.env.RELEASES_API_URL ?? process.env.RELEASED_API_URL` instead of importing.
- `process.env.RELEASED_API_KEY` → `serverApiKey()`.
- `local-admin-flag.ts:12` `Boolean(process.env.RELEASED_API_KEY)` → `Boolean(serverApiKey())`.
- `base-url.ts` `process.env.RELEASED_BASE_URL` (3 sites) → `staticBaseUrlEnv()` (preserve the existing `?.replace(/\/$/,"")` / `.replace(...)` handling on the returned value).

- [ ] **Step 3: Type-check web**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 4: Grep for stragglers**

Run: `rg -n 'process\.env\.RELEASED_(API_URL|API_KEY|BASE_URL)' web/src`
Expected: no matches (every site routed through the accessor; `next.config.ts` uses the inline `??` form, which this pattern still flags — confirm that single line is the inline fallback, not a bare read).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/env.ts web
git commit -m "feat(web): route RELEASED_ env reads through legacyEnv accessors"
```

---

## Task 5: wrangler dual-binding + discovery var rename (monorepo)

**Operator prerequisite must be done first** (store secret + GH secret created), or `wrangler deploy` will fail on the new binding.

**Files (modify):**

- `workers/api/wrangler.jsonc` — prod block (~289-292) and staging block (~515-518)
- `workers/mcp/wrangler.jsonc` — prod (~78-80) and staging (~136-138)
- `workers/discovery/wrangler.jsonc` — prod (~86-88) and staging (~167-169); plus the plain `vars` `RELEASED_API_URL` (prod ~23, staging ~122)

- [ ] **Step 1: Add the second secret binding in all 6 blocks**

Beside each existing entry, add (same `store_id`):

```jsonc
{
  "binding": "RELEASES_API_KEY",
  "store_id": "a887a71cab084105b79706df23380723",
  "secret_name": "RELEASES_API_KEY",
},
```

Keep the existing `RELEASED_API_KEY` entry in place (removed later in the teardown follow-up).

- [ ] **Step 2: Rename the discovery `vars` API URL**

In `workers/discovery/wrangler.jsonc`, rename the `vars` key `RELEASED_API_URL` → `RELEASES_API_URL` (prod value `https://api.releases.sh`, staging `https://api-staging.releases.sh`). Worker code already reads `RELEASES_API_URL ?? RELEASED_API_URL` (Task 3), so this is atomic and safe.

- [ ] **Step 3: Validate config parses**

Run: `bunx wrangler deploy --dry-run --config workers/discovery/wrangler.jsonc --outdir /tmp/wr-dry 2>&1 | tail -5`
Expected: dry-run completes (or fails only on auth/network, not on JSONC parse / binding shape). Repeat for api and mcp if quick.

- [ ] **Step 4: Commit**

```bash
git add workers/api/wrangler.jsonc workers/mcp/wrangler.jsonc workers/discovery/wrangler.jsonc
git commit -m "feat(workers): add RELEASES_API_KEY binding (dual) + rename discovery API_URL var"
```

---

## Task 6: Scripts (monorepo)

Route script reads through `config.*()` (Task 2) instead of `process.env.RELEASED_*`. For scripts that legitimately need a raw read with no config accessor, use `legacyEnv` directly.

**Files (modify):**

- `scripts/lib/admin-client.ts:27,28` → `config.apiUrl()` / `config.apiKey()`
- `scripts/mint-token.ts:16,17` → `config.apiUrl()` / `config.apiKey()`
- `scripts/upload-org-avatars.ts:154,155,161,165` → `config.apiUrl()` / `config.apiKey()`
- `scripts/run-eval-task.ts:10,65,66` → `config.stagingApiUrl()` (line 10/65) and `config.apiKey()` or keep `requireEnv` but check both names; simplest: `config.stagingApiUrl()` + `config.apiKey()`
- `scripts/sync-agent-skills.ts:677,690,737` → `config.agentModel()` (677/737) and `config.workerAgentModel()` (690)
- `scripts/backfill-changelog-tokens.ts:33,218`, `scripts/backfill-month-only-dates.ts:29,223`, `scripts/populate-fetch-quirks.ts:63`, `scripts/probe-change-detectors.ts:62`, `scripts/rediscover-feeds.ts:60` → `config.apiUrl()`

- [ ] **Step 1: Apply the transforms**

Import `config` from `@releases/lib/config` (or `@buildinternet/releases-lib/config` matching each file's existing import style) and replace `process.env.RELEASED_API_URL` → `config.apiUrl()`, `process.env.RELEASED_API_KEY` → `config.apiKey()`, model reads → the matching accessor. Where a script throws if the value is missing (e.g. `requireEnv("RELEASED_API_KEY")`), preserve the throw by checking the accessor result and erroring with a message that names `RELEASES_API_KEY`.

- [ ] **Step 2: Type-check + grep**

Run:

```bash
npx tsc --noEmit && rg -n 'process\.env\.RELEASED_' scripts
```

Expected: tsc clean; grep shows only `scripts/install.sh` is untouched here (handled in Task 7) — no `.ts` matches remain.

- [ ] **Step 3: Commit**

```bash
git add scripts
git commit -m "refactor(scripts): read API url/key/models via config accessors"
```

---

## Task 7: Non-TS config sites (monorepo)

**Files (modify):**

- `drizzle.config.ts:5` — `process.env.RELEASES_DATA_DIR ?? process.env.RELEASED_DATA_DIR ?? <existing default>` (inline; this file runs before package resolution in some contexts — keep it dependency-free)
- `workers/discovery/Dockerfile:12` — `ENV RELEASED_DATA_DIR=/app/data` → `ENV RELEASES_DATA_DIR=/app/data` (the discovery image runs the worker; data dir is set for the bundled tooling — single canonical name is fine inside our own image)
- `scripts/install.sh:8` — `INSTALL_DIR="${RELEASES_INSTALL_DIR:-${RELEASED_INSTALL_DIR:-/usr/local/bin}}"`
- `package.json:12` — `preview:web` script: `RELEASED_API_URL=${RELEASED_API_URL:-...}` → `RELEASES_API_URL=${RELEASES_API_URL:-${RELEASED_API_URL:-http://localhost:8787}}`

- [ ] **Step 1: Apply the four edits above.**

- [ ] **Step 2: Verify**

Run: `bash -n scripts/install.sh && node -e "require('./package.json')" && echo ok`
Expected: `ok` (script syntax valid, package.json parses).

- [ ] **Step 3: Commit**

```bash
git add drizzle.config.ts workers/discovery/Dockerfile scripts/install.sh package.json
git commit -m "feat: standardize RELEASES_ in drizzle/docker/install/preview"
```

---

## Task 8: GitHub Actions (monorepo)

**Files:** `.github/workflows/deploy-workers.yml:229,230,238,239,243,247`

- [ ] **Step 1: Edit the webhook e2e smoke-test env block**

```yaml
env:
  RELEASES_API_URL: https://api.releases.sh
  RELEASES_API_KEY: ${{ secrets.RELEASES_API_KEY || secrets.RELEASED_API_KEY }}
  SUBSCRIPTION_ID: ${{ secrets.WEBHOOK_E2E_SUBSCRIPTION_ID }}
```

Then update the shell body to use the new names: `AUTH="Authorization: Bearer $RELEASES_API_KEY"` and every `$RELEASED_API_URL` → `$RELEASES_API_URL`.

- [ ] **Step 2: Lint the workflow**

Run: `rg -n 'RELEASED_API' .github/workflows/deploy-workers.yml`
Expected: no matches (the `||` keeps `secrets.RELEASED_API_KEY` as the only legacy reference — confirm that's the sole remaining mention and it's the fallback expression).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-workers.yml
git commit -m "ci: use RELEASES_API_KEY (fallback to RELEASED_) in webhook e2e"
```

---

## Task 9: Templates + grep gate (monorepo)

**Files (modify):** `.env.example`, `web/.env.example`

- [ ] **Step 1: Update templates**

In `.env.example`: rename every `RELEASED_*` to `RELEASES_*` (`RELEASES_API_URL`, `RELEASES_API_KEY`, `RELEASES_DATA_DIR`, `RELEASES_INGEST_MODEL`, `RELEASES_QUERY_MODEL`). **Remove** the dead `RELEASED_DISCOVERY_URL` line entirely. In `web/.env.example`: rename `RELEASED_API_URL`, `RELEASED_API_KEY`, `RELEASED_DEV_MODE` → `RELEASES_*`.

- [ ] **Step 2: Repo-wide grep gate**

Run:

```bash
rg -n 'RELEASED_' --glob '!docs/superpowers/**' --glob '!**/CHANGELOG.md' \
  | rg -v 'RELEASES_API_KEY \?\? .*RELEASED_API_KEY|RELEASES_API_URL \?\? .*RELEASED_API_URL|RELEASES_DATA_DIR \?\? .*RELEASED_DATA_DIR|secret_name|legacyEnv\(|legacy-env|secrets\.RELEASED_API_KEY|RELEASES_INSTALL_DIR:-.*RELEASED_INSTALL_DIR|RELEASES_API_URL:-.*RELEASED_API_URL'
```

Expected: every remaining hit is either (a) a legacy `binding`/`secret_name: "RELEASED_API_KEY"` dual-binding entry in wrangler, or (b) docs being updated in Task 10. No bare code reads should remain. Investigate anything else.

- [ ] **Step 3: Commit**

```bash
git add .env.example web/.env.example
git commit -m "feat: standardize env templates on RELEASES_, drop dead DISCOVERY_URL"
```

---

## Task 10: Docs (monorepo)

**Files (modify):** `AGENTS.md` (91, 154 + "Legacy naming" section), `CONTRIBUTING.md` (15, 24, 38, 40), `docs/architecture/agents.md` (79), `docs/architecture/mcp.md` (24), `docs/architecture/remote-mode.md` (3, 11, 12), `docs/architecture/maintenance-workspace.md` (13, 34), `README.md` (per `feedback_check_readme` — always include), `workers/webhooks/test/echo-subscriber/README.md` (41), `src/agent/skills/generating-release-content/SKILL.md` (228-229), `src/agent/skills/maintaining-orgs/SKILL.md` (216, 219), `src/agent/skills/seeding-playbooks/SKILL.md` (229)

- [ ] **Step 1: Rename in prose + examples**

Replace `RELEASED_API_KEY`/`RELEASED_API_URL`/`RELEASED_DATA_DIR` with the `RELEASES_` names in all docs and curl/shell examples (`$RELEASED_API_KEY` → `$RELEASES_API_KEY`).

- [ ] **Step 2: Rewrite the AGENTS.md "Legacy naming" env-var bullet**

Replace the bullet that says env vars keep the `RELEASED_` prefix with: env vars are standardized on `RELEASES_`; legacy `RELEASED_` names are still honored via a warn-once fallback until the teardown follow-up (link #1122); only Cloudflare _resources_ (`released-db`, `released-media`) and the historical store `secret_name` remain deliberately on the old name. Note the `RELEASES_API_KEY` Secrets Store binding is dual during transition.

- [ ] **Step 3: Grep docs**

Run: `rg -n 'RELEASED_(API_KEY|API_URL|DATA_DIR)' AGENTS.md CONTRIBUTING.md README.md docs src/agent/skills workers/webhooks/test`
Expected: remaining hits only where prose intentionally references the legacy name as legacy (e.g. the AGENTS.md fallback explanation).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md CONTRIBUTING.md README.md docs src/agent/skills workers/webhooks/test
git commit -m "docs: standardize RELEASED_->RELEASES_ env var references"
```

---

## Task 11: Tests + full monorepo verification

**Files (modify):** test fixtures that set `RELEASED_API_KEY`/`RELEASED_API_URL` — `tests/api/*.test.ts`, `tests/unit/mcp-auth.test.ts` (per inventory). Switch the canonical fixtures to `RELEASES_API_KEY`; keep one explicit regression test that sets only `RELEASED_API_KEY` and asserts auth still succeeds (proves the fallback).

- [ ] **Step 1: Flip fixtures to the new binding name**

In each test that constructs a worker `env` with `RELEASED_API_KEY: "..."`, rename the property to `RELEASES_API_KEY`. In `tests/api/middleware.test.ts` (or `auth-tokens.test.ts`), add one test that sets only `RELEASED_API_KEY` on the env and asserts the same authenticated behavior, to lock the fallback.

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 3: Type-check everything**

Run: `npx tsc --noEmit && for w in api mcp discovery webhooks; do (cd workers/$w && npx tsc --noEmit) || echo "FAIL $w"; done && (cd web && npx tsc --noEmit)`
Expected: no errors, no `FAIL` lines.

- [ ] **Step 4: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. If format flags files, run `bun run format` and amend.

- [ ] **Step 5: Final grep gate (authoritative)**

Run:

```bash
rg -n 'process\.env\.RELEASED_|env\.RELEASED_API' --glob '!tests/**' --glob '!docs/superpowers/**' \
  | rg -v 'RELEASES_API_KEY \?\? .*env\.RELEASED_API_KEY|RELEASES_API_URL \?\? .*RELEASED_API_URL'
```

Expected: no matches outside the documented `??` fallback sites.

- [ ] **Step 6: Commit**

```bash
git add tests
git commit -m "test: fixtures use RELEASES_API_KEY + fallback regression"
```

---

## Task 12: CLI `legacyEnv` helper

Switch to the CLI repo. `cd ~/Code/releases-cli && git checkout -b feat/releases-env-prefix`. **Run `bun install` in this repo if node_modules is absent** (per repo memory: a fresh checkout/worktree needs its own install).

**Files:**

- Create: `packages/lib/src/legacy-env.ts`
- Modify: `packages/lib/package.json` (export, if it uses an exports map; else import relatively)
- Test: `tests/unit/legacy-env.test.ts`

- [ ] **Step 1–5: Mirror Task 1** — same helper source, same tests, importing the CLI's logger (`@releases/lib/logger` or the relative path the CLI uses; confirm via `rg "from .*logger" packages/lib/src`). Run `bun test --isolate tests/unit/legacy-env.test.ts` (the `--isolate` flag is required in this repo per memory). Commit `feat(lib): legacyEnv helper for RELEASED_->RELEASES_ fallback`.

---

## Task 13: CLI runtime shims

**Files (modify):**

- `src/lib/mode.ts:18` — `resolveCredential`: `const envKey = legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY")`
- `src/lib/mode.ts:43` — `getApiUrl`: `const url = legacyEnv("RELEASES_API_URL", "RELEASED_API_URL") || DEFAULT_API_URL`
- `src/lib/mode.ts:52,65,67` — update warning/error strings to name `RELEASES_API_KEY` / `RELEASES_API_URL`
- `src/lib/telemetry.ts:121` — replace the duplicate `process.env.RELEASED_API_URL` read with a call to `getApiUrl()` from `mode.ts` (single source); if a circular import results, use `legacyEnv` here too
- `src/lib/telemetry.ts:46` — `RELEASED_TELEMETRY_DISABLED` → `legacyEnv("RELEASES_TELEMETRY_DISABLED", "RELEASED_TELEMETRY_DISABLED")`; update strings at 106, 170
- `src/lib/telemetry.ts:71,75,76,77` — `RELEASED_CLIENT_{KIND,SESSION_ID,AGENT,MODEL}` → `legacyEnv("RELEASES_CLIENT_X", "RELEASED_CLIENT_X")`
- `src/cli/completion/hint.ts:29,53` — `RELEASED_CLIENT_KIND` → `legacyEnv(...)`
- `src/cli/commands/onboard.ts:27` — `RELEASED_DISCOVERY_ENGINE` → `legacyEnv("RELEASES_DISCOVERY_ENGINE", "RELEASED_DISCOVERY_ENGINE")`

- [ ] **Step 1: Apply the shims** (import `legacyEnv` from the CLI helper path).

- [ ] **Step 2: Type-check + targeted tests**

Run: `npx tsc --noEmit && bun test --isolate tests/unit/mode-credential.test.ts tests/cli/auth.test.ts`
Expected: pass. Fixtures still set `RELEASED_*`; the fallback keeps them green.

- [ ] **Step 3: Commit** `feat(cli): resolve RELEASES_ env vars with RELEASED_ fallback`.

---

## Task 14: CLI user-facing strings + DATA_DIR

**Files (modify):**

- `packages/lib/src/config.ts:9` — `legacyEnv("RELEASES_DATA_DIR", "RELEASED_DATA_DIR") || join(homedir(), ".releases")`
- `src/cli/commands/auth.ts:147,150,176` — strings → `RELEASES_API_KEY`
- `src/index.ts:52` — startup-gate string → `RELEASES_API_KEY`
- `src/cli/program.ts:61` — string → `RELEASES_API_KEY`

- [ ] **Step 1: Apply edits.**
- [ ] **Step 2:** Run `npx tsc --noEmit && bun test --isolate`. Expected: full CLI suite green.
- [ ] **Step 3: Commit** `feat(cli): data-dir fallback + RELEASES_API_KEY in user-facing copy`.

---

## Task 15: CLI docs + changeset

**Files (modify):** `.env.example` (5, 8, 11), `README.md` (43, 161, 181, 189, 190, 191), `CONTRIBUTING.md` (44, 45, 46), `AGENTS.md` (27, 31, 45), `skills/releases-cli/SKILL.md` (46, 62, 88, 89, 96), `skills/releases-cli/references/admin.md` (3, 8). Leave `npm/**/CHANGELOG.md` untouched (historical record).

- [ ] **Step 1: Rename `RELEASED_*` → `RELEASES_*`** in all docs/examples, including the `RELEASED_INSTALL_DIR` README mention. Note the env vars now accept either prefix (legacy deprecated).
- [ ] **Step 2: Add a changeset**

```bash
cat > .changeset/releases-env-prefix.md <<'EOF'
---
"@buildinternet/releases": minor
---

Standardize environment variables on the `RELEASES_` prefix (`RELEASES_API_KEY`, `RELEASES_API_URL`, `RELEASES_DATA_DIR`, `RELEASES_TELEMETRY_DISABLED`, …). Legacy `RELEASED_`-prefixed names still work but now emit a one-time deprecation warning and will be removed in a future release.
EOF
```

- [ ] **Step 3: Commit** `docs(cli): standardize env vars on RELEASES_ + changeset`.

---

## Task 16: CLI verification + smoke

- [ ] **Step 1: Full suite** — `bun test --isolate`. Expected: green. (If the type-check-and-test job hangs, re-run — it is a known flake per repo memory.)
- [ ] **Step 2: Lint/format** — `bun run lint && bun run format:check` (match the CLI's actual script names; check `package.json`).
- [ ] **Step 3: Manual smoke (deprecation + fallback)**

```bash
# Legacy var: should authenticate AND print one deprecation notice to stderr
RELEASED_API_KEY="$RELEASES_API_KEY_ADMIN" bun src/index.ts whoami 2>&1 | rg -i 'deprecat|whoami|authenticated' | head
# New var: should authenticate with NO deprecation notice
RELEASES_API_KEY="$RELEASES_API_KEY_ADMIN" bun src/index.ts whoami 2>&1 | rg -i 'deprecat' || echo "no deprecation warning (correct)"
```

Expected: first prints the deprecation notice once; second prints nothing for the deprecation grep. (Use a real read-capable token; `whoami` is a safe read.)

- [ ] **Step 4: Push branch + open PR** (both repos) — see handoff below.

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — helper (T1/T12), config (T2/T14), workers+secret (T3/T5), web (T4), scripts/non-TS (T6/T7), GHA (T8), templates (T9), docs (T10/T15), tests/verify (T11/T16), CLI shims (T13). Cross-repo `CLIENT_*` consumer = T13; producer flip = out of scope (teardown).
- **Dead vars:** `RELEASED_DISCOVERY_URL` dropped (T9); `RELEASED_DEV_MODE` has no code read — template-only rename (T9), no accessor.
- **Fallback ordering:** workers use `??` (dual-binding makes warn inert); Node/CLI/web use `legacyEnv` warn-once. Consistent names: `legacyEnv`, `apiBaseUrl`, `serverApiKey`, `staticBaseUrlEnv`, `config.stagingApiUrl`, `config.workerAgentModel`.
- **Deploy safety:** code fallback (T3) ships before the binding exists; wrangler dual-binding (T5) gated on the operator prerequisite.
