# Stub-tier phase 2 — self-serve listing (validate + activate)

Design for phase 2 of the stub-tier epic ([#1947](https://github.com/buildinternet/releases/issues/1947)):
the public front door where an owner of an **unlisted** domain publishes
`/.well-known/releases.json`, validates it live, and activates an instant stub
listing. This is the activation-semantics half of the fast-lane submission idea
([#1910](https://github.com/buildinternet/releases/issues/1910)) built on the
releases.json v2 manifest ([#1908](https://github.com/buildinternet/releases/issues/1908)).

## Scope decisions (settled in brainstorm, 2026-07-06)

- **In scope:** public validate/preview endpoint + self-serve stub activation,
  designed together as one user journey.
- **Deferred:** the ambient daily-sweep creating stubs for unlisted domains
  (the sweep has no unlisted-domain candidate feed yet); the domain-verification
  claim flow (phase 3); self-serve Tier-1 materialization; owner accounts.
- **Auth posture: fully anonymous activation.** The manifest is host-scoped —
  you can only declare for a domain you control — which is a stronger gate than
  a free account. Stubs are cheap, demotable, and deletable. Quarantine
  (hidden-until-curator) machinery exists (mobile-discovery candidates) and is
  held in reserve; it is NOT used here because it would break the
  "publish the file, you're listed" promise.
- **Beyond the stub: request-tracking signal, no self-serve promotion.**
  Activation can record "owner requested tracking" as a demand signal for the
  promotion loop. Actual promotion stays curator-driven
  (`admin org promote`). Self-serve Tier-1 waits for domain-verified ownership.
- **Web front door: extend `/submit`.** One page, two paths — the existing
  recommendation form, plus the owner fast lane. No dedicated validator page in
  phase 2 (may emerge later if the iterate-loop gets real usage).
- **Endpoint shape: dedicated public namespace `/v1/listing/*` (option B).**
  Chosen over reusing `POST /v1/orgs/stub-from-domain` anonymously because:
  (1) the owner-facing surface will grow — the #1908 claim flow and eventual
  self-serve Tier-1 want a coherent owner-session-shaped home; (2) the public
  wire contract must evolve independently of the internal materialization plan
  object; (3) a dedicated path gets its own kill switch / WAF posture, so the
  anonymous lane can be shut off in an incident without touching the curator
  route; (4) anonymous-only side effects (tracking signal, future Turnstile)
  would otherwise accrete as caller-type branches in one handler. This is a
  distinct public product surface sharing library internals — not a
  permission-gated CRUD duplicate, so it does not violate the no-duplicate-
  namespace convention. Admin routes are unchanged.

## Backend

New route file `workers/api/src/routes/listing.ts`; both routes public
(no auth), JSON in/out with the standard nested error envelope.

### `POST /v1/listing/validate` — `{ domain }`

Read-only; works for ANY domain (listed or not) — this is the
"check my work" loop an owner re-runs while editing their file.

1. Fetch `https://<domain>/.well-known/releases.json` live, under the existing
   well-known guards (SSRF protections, 64KB cap, 5s timeout).
2. Zod-validate against the v2 manifest schema. Invalid → structured,
   actionable errors (path + message per issue), not a bare 422.
3. Classify each locator via the existing `classifyLocation()` machinery and
   return a purpose-built projection — NOT the internal materialization plan:
   - manifest validity + per-issue errors;
   - org identity fields and `products[]` as they would land;
   - per-locator: the locator, its classification
     (`tier1-live | tier2-paused-review | invalid`), and a short
     human-readable "what this becomes";
   - `domainStatus: "unlisted" | "listed" | "stub"` with an org pointer
     (slug + web URL) when listed or stub.

Response schema `ListingValidationResult` lives in
`@buildinternet/releases-api-types` (additive minor bump). It is the stable
public contract; the internal `EntityMaterializationPlan` remains free to
change.

### `POST /v1/listing/activate` — `{ domain, requestTracking? }`

1. Re-runs the full validation server-side (never trusts a prior validate
   call).
2. Branch on `domainStatus`:
   - **Unlisted** → `createStubFromManifest` (`basis: "declared"`), the same
     library path the admin `stub-from-domain` route uses. Returns the created
     org (slug, status, web URL, location/product counts).
   - **Stub** (already a stub) → no org write, but `requestTracking: true`
     updates the tracking-request stamp — the one carve-out, so an owner can
     raise their hand after the fact. Returns the existing org pointer.
   - **Listed (tracked)** → conflict envelope with the existing org pointer
     ("already listed; manifest changes reconcile via the daily sweep").
     No anonymous sync-now trigger in phase 2 (admin sync route covers
     support cases).
3. Idempotent by domain: re-activating an unlisted→now-stub domain lands in
   the stub branch.

### Request-tracking signal

- New nullable column `organizations.tracking_requested_at` (TEXT ISO
  timestamp; paired migration per the schema gate). Internal — not exposed on
  public read surfaces in phase 2.
- Written by activate when `requestTracking: true` (on creation or on the stub
  carve-out). Repeat requests refresh the timestamp.
- Curator visibility: a filter on the existing admin org listing surface
  (exact shape decided at implementation), NOT a new digest email.

### Abuse gates

- **Rate limits** on the CF-native limiter pattern (`rate-limit-tiers`
  family): per-IP across both routes (tight, ~10/min), plus per-domain on
  `activate` (~3/day) so a hostile loop cannot churn one domain. 429 via the
  standard envelope.
- **Kill switch:** one new Flagship flag `listing-self-serve-enabled` gating
  BOTH routes (404-style refusal when off). This clears the flag-restraint
  bar: a genuine kill switch for an external-facing anonymous write surface,
  and the operational lever that motivated the dedicated namespace. Create the
  key in both Flagship apps per convention.
- **Integrity gate** is host-scoping itself: the manifest must be served from
  the domain being declared. No Turnstile in phase 2; the design leaves the
  slot open.

## Web (`/submit` extension)

The existing recommendation form remains. The page gains an owner path
("Own this product?") with a single domain input, driving the two routes
client-side:

1. **Validate** → three states:
   - **Invalid / missing manifest** — inline per-issue errors with what to
     fix, a link to `/docs/listing`, and a copyable minimal `releases.json`
     starter. This state is the iterate loop.
   - **Valid + unlisted** — preview card: org identity, products, locator list
     badged by outcome ("live source when tracked" / "queued for review"),
     plus a short stub → tracked ladder explanation. Below: **Activate
     listing** button and a "Request tracking" checkbox (unchecked by
     default — the instant stub is the headline; tracking is the ask).
   - **Valid + listed/stub** — "Already listed" with the org link; for stubs,
     the request-tracking affordance still shows.
2. **Activate** → success state linking the new stub org page, with
   "what happens next" copy (visible in the catalog now; tracking is
   demand-driven).

House rules: no emojis; tier badges use chips/icon components; stub org pages
remain `noindex` (shipped in phase 1); error envelopes decode inline as the
web client does elsewhere.

## CLI

`releases json validate <domain|path>` — read-only, top-level (not `admin`)
per the command-shape convention:

- **Domain form** calls public `POST /v1/listing/validate` (no auth), so web
  and CLI agree by construction.
- **Path form** validates a local file offline against the same api-types zod
  schema (pre-publish check).

No CLI activate verb in phase 2 — curators have
`admin org create-stub-from-domain`; owners use the web flow. The CLI's
api-types pin bumps when this verb lands (OSS repo, separate PR).

## Testing

- **Route tests** (`workers/api`): validate/activate across unlisted, listed,
  stub, invalid-manifest, and fetch-failure domains; rate-limit 429; flag-off
  refusal; `requestTracking` stamping incl. the stub carve-out and timestamp
  refresh; idempotent re-activation; projection never leaks internal plan
  fields.
- **Projection fixtures:** fixture-driven tests keep `ListingValidationResult`
  classification in lockstep with `classifyLocation()`.
- **Web:** component/state tests for the three validate states + activation
  success per existing patterns.
- **api-types:** schema tests for the new additive shapes.

## Delivery slices

1. **Backend + api-types:** routes, migration, rate limits, flag, tests;
   publish api-types (additive minor).
2. **Web:** `/submit` owner path against the deployed routes.
3. **CLI:** `releases json validate` in the OSS repo (pin bump + changeset).

## Non-goals

- No ambient sweep creating stubs for unlisted domains.
- No domain-verification claim flow (phase 3; the `/v1/listing/*` namespace is
  its intended home).
- No self-serve Tier-1 materialization; no owner accounts/sessions.
- No Turnstile; no new digest emails; no anonymous sync-now for listed orgs.
- No change to admin stub routes, reconciliation rules, or the processed
  pipeline.
