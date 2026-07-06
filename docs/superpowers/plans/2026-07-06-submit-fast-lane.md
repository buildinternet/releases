# Submit Fast Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two front-door consumers of the live self-serve listing endpoints: a teach-first fast lane on web `/submit`, and the domain form of the CLI's `releases json validate`.

**Architecture:** Two independent lanes in two repos. Lane A (this monorepo) adds a client component to `/submit` that calls `POST /v1/listing/validate` / `POST /v1/listing/activate` on the API worker **directly from the browser** (the routes are in `publicWriteRoutes`, covered by wildcard CORS; a Next proxy would collapse every user onto one IP and defeat the per-IP rate limit). Lane B (releases-cli) replaces the deferred-domain stub in `runValidate` with a real call to the same validate endpoint.

**Tech Stack:** Next.js app router client component + Tailwind (existing stone palette); commander + chalk CLI; `@buildinternet/releases-api-types` 0.39.0 listing schemas.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-submit-fast-lane-design.md` — read it first.
- Teach-first: the fast lane assumes the visitor has never heard of `releases.json`; explainer + `/docs/listing` link (including its "Let an agent write it" section, anchor `#let-an-agent-write-it`) come before the domain input.
- Always send `requestTracking: true` on activate; no UI control for it.
- No emojis in web UI (incl. ↗); reuse existing chip/button styling from the stone palette.
- Web must not runtime-import the api-types barrel (Next bundler limitation) — use `import type` only, inline any value-level decode.
- Monorepo: `bun run check` + `bun test web/` must pass. CLI: repo's own check/test scripts + a changeset targeting `@buildinternet/releases`.
- This repo is public: no PII, no absolute home-dir paths in committed content.

---

## Lane A — web `/submit` fast lane (monorepo)

### Task A1: `listing-fast-lane.tsx` component

**Files:**
- Create: `web/src/app/submit/listing-fast-lane.tsx`
- Test: `web/src/app/submit/listing-fast-lane.test.tsx` (only if `web/` already has component tests to pattern-match — check `ls web/src/**/*.test.tsx`; the API route tests like `web/src/app/api/recommendations/route.test.ts` are NOT the pattern. If no component-test harness exists, skip the file and verify via preview in Task A3.)

**Interfaces:**
- Consumes: `POST {apiBase}/v1/listing/validate` and `POST {apiBase}/v1/listing/activate` where `apiBase` comes from `apiBase()` in `@/lib/user-api` (strips trailing `/v1`). Wire shapes: `import type { ListingValidationResult, ListingActivateResult } from "@buildinternet/releases-api-types"` (type-only import).
- Produces: `export function ListingFastLane()` — client component, no props.

- [ ] **Step 1: Write the component.** `"use client"`. State machine mirroring `submit-source-form.tsx`'s discriminated-union style:

```tsx
type LaneState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "result"; domain: string; result: ListingValidationResult }
  | { phase: "activating"; domain: string; result: ListingValidationResult }
  | { phase: "activated"; result: ListingActivateResult }
  | { phase: "error"; message: string };
```

Behavior:
- Static explainer header (teach-first): one sentence on what `releases.json` is, link to `/docs/listing` ("write it by hand or hand the prompt to your coding agent"), then the input labeled as the already-have-one step: "Already publish one? Check your listing".
- Domain input + "Check my listing" button. Normalize before send: `domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()`.
- `POST ${apiBase()}/v1/listing/validate` with `{ domain }`, `Content-Type: application/json`. Non-2xx: read the nested envelope inline — `json?.error?.message` string fallback "Something went sideways. Please try again." 429 → "Too many checks. Please try again in a minute." (match on status, not code).
- Result rendering:
  - `!result.valid` → list `errors[]` (path in `font-mono`, message in prose), link to `/docs/listing`, "Check again" resets to idle keeping the domain in the input.
  - `valid && domainStatus === "unlisted"` → preview: identity (name / slug / domain), products (name + locationCount), locations table (locator mono truncated, kind chip, `becomes` string, and a classification chip: `tier1-live` → "goes live", `tier2-paused-review` → "reviewed first"). Below: "Activate listing" button.
  - `valid && (domainStatus === "listed" || "stub")` → same preview, activate replaced by "This domain is already listed." + link to `result.org.webUrl`.
- Activate: `POST ${apiBase()}/v1/listing/activate` with `{ domain, requestTracking: true }`. Success: org name, link to `result.org.webUrl`, line "Your listing is live as a catalog entry. Live release tracking is enabled after a curator review." Same rendering when `activated: false` (existing-stub re-activation), minus any "created" wording.
- Styling: copy the input/button/label classes from `submit-source-form.tsx` verbatim; chips styled like existing kind badges elsewhere in `web/src/components` (grep for `uppercase tracking` chip patterns).

- [ ] **Step 2: Type-check + lint.** Run: `bun run check`. Expected: clean.
- [ ] **Step 3: Commit.** `git add web/src/app/submit/listing-fast-lane.tsx && git commit -m "feat(web): listing fast-lane component for /submit (#1947 phase 3)"`

### Task A2: two-lane `/submit` page layout

**Files:**
- Modify: `web/src/app/submit/page.tsx`

**Interfaces:**
- Consumes: `ListingFastLane` from Task A1.

- [ ] **Step 1: Rework the content section.** Fast lane in the existing bordered section styling on top; below it a divider block: heading "Not your product, or no manifest?" + one line "Suggest a changelog, feed, or GitHub releases URL and a curator will take a look." + the existing `<SubmitSourceForm />`. Update sidebar lead paragraph to teach-first framing (manifest explained as the way to own your listing; recommendation form as the fallback). Keep metadata, the "Own your listing" sidebar block, and `/docs/listing` links.
- [ ] **Step 2: Check.** Run: `bun run check`. Expected: clean.
- [ ] **Step 3: Commit.** `git commit -am "feat(web): two-lane /submit — teach-first fast lane above recommendation form"`

### Task A3: verify against local dev

- [ ] **Step 1:** Start `dev:api` + `dev:web` (portless; worktree-prefixed hosts). Local API needs `listing-self-serve-enabled` default-on (it fails open to the wrangler var — check `workers/api/wrangler.jsonc` var; if staging/local var is false, note it and test the kill-switch rendering too).
- [ ] **Step 2:** Exercise: invalid domain (no manifest) → error list; a real manifest domain (`releases.sh` itself publishes one — check `web/public/.well-known/releases.json` or use a domain with a known manifest) → preview → activate on a throwaway only IF local DB (never prod). Screenshot the three states.
- [ ] **Step 3:** `bun test web/` passes. Commit any fixes.

## Lane B — CLI `releases json validate <domain>` (releases-cli repo)

### Task B1: wire the domain form to the live endpoint

**Files:**
- Modify: `src/cli/commands/json.ts` (replace the deferred-domain block in `runValidate`, lines ~192–217)
- Modify: `package.json` — bump `@buildinternet/releases-api-types` to `^0.39.0` (then `bun install`)
- Test: extend `tests/cli/json-validate.test.ts`
- Create: `.changeset/<name>.md` targeting `"@buildinternet/releases": minor`

**Interfaces:**
- Consumes: `POST {getApiUrl()}/v1/listing/validate` `{ domain }` (no auth header needed; anonymous route). `import type { ListingValidationResult } from "@buildinternet/releases-api-types"`.
- Produces: domain form now exits 0 (valid), 1 (invalid manifest or transport error) instead of the old unconditional exit 2; `--json` output gains `domainStatus`, `identity`, `products`, `locations` fields on the domain form. Keep the existing `ValidateResult` shape for the file form untouched.

- [ ] **Step 1: Write failing tests** in `tests/cli/json-validate.test.ts`, following the existing mocked-fetch convention in that file (test base `https://test.example.com` — `getApiUrl()` memoizes process-wide). Cases: (1) domain form POSTs `/v1/listing/validate` and renders valid summary + locations, exit 0; (2) invalid manifest → error list with paths, exit 1; (3) 429 envelope → friendly rate-limit message, exit 1; (4) `--json` emits the raw `ListingValidationResult` merged with `{ target }`.
- [ ] **Step 2: Run tests, verify they fail.** `bun test tests/cli/json-validate.test.ts` — new cases fail (old ones still pass).
- [ ] **Step 3: Implement.** Replace the deferred block: fetch the endpoint; on 2xx render with the existing `printSummary`-style helpers — valid headline, identity lines, products count, then a locations list (`locator`, `kind`, classification rendered as `goes live` / `reviewed first`, and the `becomes` text), plus `domainStatus` line; when `domainStatus` is `unlisted` and valid, end with `Activate at https://releases.sh/submit`. On non-2xx read the nested envelope `error.message`; 429 gets a friendly retry-in-a-minute message. Network failure → `logger.error`, exit 1.
- [ ] **Step 4: Tests pass.** `bun test tests/cli/json-validate.test.ts`, then the repo's full check (`bun run check` or as its package.json defines).
- [ ] **Step 5: Changeset + commit.** Changeset summary: "`releases json validate <domain>` now validates live against the registry's listing endpoint (previously deferred)." Commit: `feat: wire json validate domain form to /v1/listing/validate`.

## Self-review notes

- Spec coverage: teach-first framing (A1/A2), three states (A1), always-send requestTracking (A1), already-listed carve-out (A1), CLI validate-only (B1), changeset (B1), testing (A1/A3/B1). CLI verb shape updated from spec's `releases listing validate` to the pre-existing `releases json validate <domain>` stub — same backend, surface already shipped, #1910 explicitly planned this.
- No new API surface anywhere; both lanes consume shipped endpoints.
