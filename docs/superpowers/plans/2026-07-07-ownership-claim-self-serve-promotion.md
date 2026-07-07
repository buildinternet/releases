# Ownership Claim + Self-Serve Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user prove control of a listed domain (`.well-known` token OR DNS TXT, either passes) and then self-serve promote their stub org to `tracked` via the existing `promoteStubOrg` machinery.

**Architecture:** Two PRs. PR A adds the `org_claims` table + claim/verify/list routes in the existing `/v1/listing` namespace + web claim panel. PR B adds `POST /v1/listing/promote` behind a new `listing-self-serve-promotion-enabled` flag + web promote affordance. Spec: `docs/superpowers/specs/2026-07-07-ownership-claim-self-serve-promotion-design.md` (read it first — it is the contract).

**Tech Stack:** Hono routes in `workers/api`, Drizzle/D1 schema in `packages/core`, zod wire shapes in `packages/api-types`, Next.js web in `web/`, `bun test` in-process route tests.

## Global Constraints

- TDD: write the failing test first for every behavior; run `bun test workers/api` (own process) and `bun run check` before each commit.
- `schema.ts` edits need a paired migration in `workers/api/migrations/` (CI gate).
- Every non-2xx response: `throw` a `ReleasesError` subclass via `respondError` — never hand-roll `c.json({ error })`.
- Worker logging via `logEvent()` only.
- Fail closed: any ambiguous/unparseable verification response = not verified.
- No emojis in web UI; chips/icon components; error envelopes decoded inline.
- Repo is public: no PII in fixtures (use `@example.com`, `~/…`).
- Pattern files to imitate: `workers/api/src/routes/listing.ts` (guard/flag/limiter/OpenAPI shape), `workers/api/src/routes/me.ts` (session gate: `c.get("session")` → 401 `UnauthorizedError`), `workers/api/src/lib/well-known/{stub,promote}.ts`, existing listing route tests.

---

## PR A — Claim flow

### Task A1: `org_claims` schema + migration

**Files:**
- Modify: `packages/core/src/schema.ts` (new `orgClaims` table, exported, added to composite schema like `releaseLocations`)
- Create: `workers/api/migrations/NNNN_org_claims.sql` (next number in sequence)

**Interfaces (Produces):** `orgClaims` drizzle table with columns exactly per spec data-model section: `id` (PK, `clm_` + nanoid), `orgId` (FK organizations.id), `userId`, `method` (`well-known" | "dns-txt`, nullable until verified), `token`, `status` (`pending|verified|expired`, default `pending`), `createdAt`, `verifiedAt` (nullable), `expiresAt`. Index on `(org_id, user_id)`; index on `user_id`.

Steps: mirror how `releaseLocations` (#1947 phase 1) was added — same file region, same ID helper from `@buildinternet/releases-core/id` (add a `clm` prefix there if the helper is prefix-typed). Migration SQL mirrors the phase-1 migration. Commit: `feat(core): org_claims table for ownership claims (#1947)`.

### Task A2: api-types shapes

**Files:**
- Modify: `packages/api-types/src/` (wherever `ListingValidateBodySchema` etc. live — add sibling schemas)

**Interfaces (Produces):**
- `ListingClaimBodySchema` `{ domain: string }`
- `ListingClaimVerifyBodySchema` `{ claimId: string }`
- `OrgClaimSchema` `{ id, org: { slug, name, webUrl }, status, token, method?, createdAt, verifiedAt?, expiresAt, instructions: { wellKnownUrl, dnsRecordName } }` (token+instructions only present while pending or on mint)
- `ClaimCheckOutcome = "ok" | "mismatch" | "unreachable"`, `ClaimVerifyResultSchema` `{ verified: boolean, checked: { wellKnown: ClaimCheckOutcome, dnsTxt: ClaimCheckOutcome }, claim: OrgClaimSchema }`
- `ListingClaimsResultSchema` `{ claims: OrgClaim[] }`

Additive only; version bump to next minor in `package.json` (publish happens at integration, manual). Commit: `feat(api-types): listing claim shapes (#1947)`.

### Task A3: claim verification checker (lib)

**Files:**
- Create: `workers/api/src/lib/listing/claim-verify.ts`
- Test: `workers/api/src/lib/listing/claim-verify.test.ts`

**Interfaces (Produces):**
```ts
export type ClaimCheckOutcome = "ok" | "mismatch" | "unreachable";
export interface ClaimVerifyChecks { wellKnown: ClaimCheckOutcome; dnsTxt: ClaimCheckOutcome }
export async function verifyDomainControl(
  domain: string,
  token: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ verified: boolean; method: "well-known" | "dns-txt" | null; checked: ClaimVerifyChecks }>
```
Behavior:
- Well-known: GET `https://<domain>/.well-known/releases-verify.txt` reusing the well-known fetch guards (import/reuse the guard helpers used by the manifest fetch in `workers/api/src/lib/well-known/fetch.ts` — HTTPS only, `isPrivateOrLocalHost` screen, size cap, 5s timeout). `ok` iff `body.trim() === token`. Non-200 / thrown / oversized / HTML-looking → `unreachable`; 200 with different text → `mismatch`.
- DNS TXT: GET `https://cloudflare-dns.com/dns-query?name=_releases-challenge.<domain>&type=TXT` with `accept: application/dns-json` via `opts.fetchImpl ?? fetch`. `ok` iff any `Answer[].data` (strip surrounding quotes, also handle multi-string concatenation) equals token. NXDOMAIN/no answers → `mismatch`; non-200/parse failure → `unreachable`.
- `verified = wellKnown === "ok" || dnsTxt === "ok"`; check well-known first but ALWAYS run both so `checked` is complete for debugging. `method` = first that passed.
- Fail closed: any doubt maps to `mismatch`/`unreachable`, never `ok`.

TDD: table-driven tests with injected `fetchImpl` covering: well-known exact match, trailing-newline body (still ok via trim), mismatch, HTML challenge page (unreachable), fetch throw, private-host refusal; DoH ok (quoted + unquoted data), NXDOMAIN, DoH 500, malformed JSON; either-passes; neither. Commit: `feat(api): domain-control verification checker (#1947)`.

### Task A4: claim routes

**Files:**
- Modify: `workers/api/src/routes/listing.ts` (or split a `listing-claims.ts` mounted on the same router if listing.ts would exceed ~500 lines — prefer the split, register in the same place `listingRoutes` is mounted)
- Create/extend route tests next to the existing listing route tests (find them via `grep -rl "listing/validate" workers/api`)

**Interfaces (Consumes):** A1 table, A2 schemas, A3 `verifyDomainControl`, existing `guardListing`/`requireListingEnabled`, `resolveDomainOrg`, `normalizeListingDomain`, session gate pattern from `me.ts`.

Routes per spec (reread the Routes section for exact semantics):
- `POST /listing/claim`: `requireListingEnabled` → session gate (`c.get("session")`, else `UnauthorizedError`) → normalize domain → `resolveDomainOrg` (else `NotFoundError` "…activate a listing first") → existing verified claim by this user? return 200 with it → insert pending claim (token `relv_` + nanoid via crypto-safe generator already used for ids, 7-day `expiresAt`) → 201 `OrgClaim` incl. both instructions.
- `POST /listing/claim/verify`: gates as above; load claim by id AND `userId = session.user.id` (else `NotFoundError` — no existence oracle); already verified → 200 idempotent; expired (`expiresAt < now` while pending) → flip status `expired`, throw `ConflictError` "claim expired; start a new claim"; per-domain limiter `LISTING_DOMAIN_RATE_LIMITER` key `claim-verify:<domain>`; run `verifyDomainControl`; on success set `status:"verified", verifiedAt, method` and stamp `organizations.trackingRequestedAt` (+`updatedAt`); return `ClaimVerifyResult` (200 whether or not verified — `verified:false` is a valid outcome, not an error).
- `GET /listing/claims`: gates (flag+IP limiter+session); lazily flip overdue pending rows to `expired`; return the caller's claims (org pointer join), pending ones include token+instructions.

OpenAPI `describeRoute` blocks in the style of the existing routes (keeps the coverage gate green). `logEvent` on mint/verify (`component: "listing"`, events `claim-created` / `claim-verified` / `claim-verify-failed`).

TDD test matrix (in-process route pattern — mounted router + injected session, mirroring how `me.ts` handlers are tested): flag-off 404; unauthenticated 401 on all three; unlisted domain 404; mint 201 + instructions; idempotent verified short-circuit; verify happy path via well-known / via DNS (mock fetchImpl); verified stamps `tracking_requested_at`; fail-closed cases return `verified:false` with correct `checked`; other user's claim 404; expired flip + 409; lazy expiry on list; rate-limit 429 per-domain on verify. Commit: `feat(api): listing claim + verify routes (#1947)`.

### Task A5: web claim panel

**Files:**
- Modify: the stub org page component (find via `grep -rl "noindex" web/src/app` + the stub badge rendering; the stub page shipped in #1956)
- Create: `web/src/components/claim-panel.tsx` (or colocated per web conventions)
- Test: component tests per existing web test patterns (see `web/src/**/passkeys-panel` or `/submit` fast-lane tests for shape)

Behavior per spec Web section: signed-in users see "Own this domain?" on stub org pages → start claim (POST claim) → instruction card with copy buttons (token, `/.well-known/releases-verify.txt` path, `_releases-challenge.<domain>` TXT name) → Verify button → success state, or per-mechanism failure display from `checked` (`unreachable` vs `mismatch` copy). Signed-out: sign-in prompt link. Browser calls the API worker directly (same as `/submit` fast lane — preserves per-IP limiting). No emojis. Commit: `feat(web): ownership claim panel on stub org pages (#1947)`.

### Task A6: PR A finalization

- `bun run check`, `bun test tests/ web/ workers/discovery workers/mcp workers/webhooks && bun test workers/api`
- Update `docs/architecture/well-known-config.md` with a "Ownership claims" subsection + one-line AGENTS.md conventions entry (one line + doc pointer, per convention).
- Branch `claude/1947-ownership-claims`, push, PR titled `feat(api,web): ownership claim flow for listed domains (#1947)` referencing the epic, `--body-file`. Request CodeRabbit review (`coderabbit:review` label) — auth-adjacent anonymous-lane change qualifies.

---

## PR B — Self-serve promotion (branch on top of PR A)

### Task B1: flag + promote route

**Files:**
- Modify: `@releases/lib/flags` registry (`listingSelfServePromotionEnabled`, kebab key `listing-self-serve-promotion-enabled`, default false), the api worker `wrangler.jsonc` var if the listing flag has one (`LISTING_SELF_SERVE_PROMOTION_ENABLED`), `Env` typing.
- Modify: the claim routes file (add promote route)
- Test: route tests alongside A4's.

**Interfaces (Consumes):** `promoteStubOrg(db, orgId, { fetchImpl?, githubToken?, probe? })` from `workers/api/src/lib/well-known/promote.ts` — already handles atomic claim, 409 contention, tier-1 live / tier-2 paused, idempotent already-tracked.

`POST /listing/promote { domain }`: `requireListingEnabled` → promotion flag check (off → 404) → session gate → normalize domain → `resolveDomainOrg` (404) → verified claim by caller exists (else `ForbiddenError`-equivalent from the error taxonomy — check `packages/core/src/errors.ts` for the right subclass) → per-domain limiter key `listing-promote:<domain>` (3/min semantics of the existing limiter binding) → `promoteStubOrg` → map result to public projection `{ promoted, alreadyTracked?, sources: { created, matched }, locators: [{ locator, outcome: "live" | "queued-for-review" }] }` derived from `plan.sources` actions + pause state — do NOT return the raw plan. api-types: `ListingPromoteBodySchema` / `ListingPromoteResultSchema` (additive).

TDD matrix: promotion-flag-off 404 (while listing flag on); 401; no verified claim 403; verified claim happy path with mocked `probe`/`fetchImpl` (tier-1 feed locator → created live, bare URL → paused/queued); already-tracked no-op 200; 409 contention passthrough; rate limit 429; verify projection leaks no internal plan fields. Commit: `feat(api): self-serve stub promotion for verified owners (#1947)`.

### Task B2: web promote affordance

**Files:** extend `claim-panel.tsx` (verified state): "Enable tracking" button → shows locator preview (reuse the `/submit` validate-projection rendering component if extractable, else a compact list with tier chips) → calls promote → success links org page with "sources are live / queued for review" summary. Handle 403/409/flag-off envelope decoding. Component tests. Commit: `feat(web): verified-owner enable-tracking flow (#1947)`.

### Task B3: PR B finalization

- Full test + check commands as A6.
- Docs: extend the well-known-config.md claims subsection with promotion; note the new flag in `docs/architecture/feature-flags.md` per-flag reference.
- PR `feat(api,web): self-serve Tier-1 promotion for verified owners (#1947)`, based on PR A's branch, `--body-file`.
- Post-merge ops note in PR body: create `listing-self-serve-promotion-enabled` in BOTH Flagship apps (prod + staging).

---

## Self-review notes

- Spec coverage: data model → A1; routes claim/verify/list → A4; checker + fail-closed → A3; promote → B1; gates/flags/limiters → A4+B1; web → A5+B2; api-types → A2+B1; testing matrix distributed per task. No CLI work (spec non-goal).
- Types: `ClaimCheckOutcome` defined once in api-types (A2) and re-exported/consumed by A3's lib (keep one source: lib imports the type from api-types).
