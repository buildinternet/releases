# Ownership claim + self-serve Tier-1 promotion

Design for the final two items of the stub-tier epic
([#1947](https://github.com/buildinternet/releases/issues/1947)): a
domain-control ownership claim flow, and self-serve promotion of a claimed
stub org to `tracked`. Decisions settled in brainstorm, 2026-07-07.

## Settled decisions

- **Verification mechanism: both, either passes.** A claim can be proven via a
  `.well-known` token file OR a DNS TXT record — whichever the owner can
  publish. One token serves both.
- **Claims bind to a signed-in user.** Anonymous claims would be meaningless —
  activation is already anonymous. The principal gate is the existing user
  gate used by `/v1/me/*`: Better Auth session OR Bearer user principal
  (`relu_` key / OAuth JWT). Machine tokens (`relk_`) and root do not claim.
- **A verified claim unlocks self-serve Tier-1 promotion** (this is epic
  item 3) plus a `tracking_requested_at` demand-signal stamp. It does NOT
  unlock org edit rights or a public verified badge in this phase.
- **Promotion is automatic behind a kill switch.** Verified claim + probe
  success = live sources immediately; tier-2 locators still land paused for
  curator review. Probes are the quality gate.
- **Two PRs, one design.** PR A = claim flow; PR B = self-serve promotion.

## Data model

New table `org_claims` (+ paired migration; schema source of truth in
`packages/core`):

| column        | type | notes                                           |
| ------------- | ---- | ----------------------------------------------- |
| `id`          | TEXT | `clm_` + nanoid                                 |
| `org_id`      | TEXT | FK → organizations                              |
| `user_id`     | TEXT | Better Auth user id                             |
| `method`      | TEXT | `well-known` \| `dns-txt` — set at verification |
| `token`       | TEXT | `relv_` + nanoid, the proof value               |
| `status`      | TEXT | `pending` \| `verified` \| `expired`            |
| `created_at`  | TEXT | ISO                                             |
| `verified_at` | TEXT | nullable ISO                                    |
| `expires_at`  | TEXT | ISO; pending claims expire 7 days after mint    |

Multiple pending claims may coexist; at most one `verified` claim per
(org, user) — re-verifying is idempotent. Verified state is read from this
table; no new column on `organizations`.

## Routes

All in the existing `/v1/listing` namespace (`publicWriteRoutes` bucket),
user-auth-gated inside the handler (the namespace itself stays unauthenticated
at the middleware layer, matching validate/activate). Standard nested error
envelope throughout.

### `POST /v1/listing/claim { domain }` — start a claim

1. Requires a user principal; 401 otherwise.
2. `resolveDomainOrg(domain)` — the org must exist (stub or tracked); 404
   envelope for unlisted domains ("activate a listing first").
3. If the caller already has a `verified` claim on the org → return it
   (idempotent, no new token).
4. Otherwise mint a `pending` claim (fresh `relv_` token, 7-day expiry) and
   return it with BOTH proof instructions:
   - **Well-known:** serve the token as the exact body of
     `https://<domain>/.well-known/releases-verify.txt` (`text/plain`).
   - **DNS TXT:** publish a TXT record at `_releases-challenge.<domain>`
     whose value is the token.

### `POST /v1/listing/claim/verify { claimId }` — check the proof

1. Requires a user principal; the claim must belong to the caller (404
   otherwise — no existence oracle).
2. Expired pending claim → flip `status: "expired"`, return a conflict-shaped
   error telling the owner to start a new claim.
3. Check both mechanisms; **either passes**, well-known checked first:
   - **Well-known fetch** reuses the existing well-known guards — HTTPS only,
     `isPrivateOrLocalHost` SSRF screen, response-size cap, 5s timeout.
     Passes iff the trimmed body equals the token exactly.
   - **DNS TXT** via Cloudflare DoH JSON
     (`https://cloudflare-dns.com/dns-query?name=_releases-challenge.<domain>&type=TXT`,
     `accept: application/dns-json`). Passes iff any answer's unquoted value
     equals the token.
4. **Fail closed** (repo convention): any ambiguous or unparseable response —
   an HTML anti-bot challenge, a DoH error, a malformed body — counts as
   not-verified, never as verified. The response distinguishes
   `checked: { wellKnown, dnsTxt }` per-mechanism outcomes
   (`ok | mismatch | unreachable`) so the owner can debug.
5. On success: stamp `verified_at`, set `method` to whichever passed, and
   refresh `organizations.tracking_requested_at` (verified owner = strongest
   demand signal).

### `GET /v1/listing/claims` — the caller's claims

User-gated list of the caller's own claims with org pointers and status.
Lazily expires overdue pending rows on read.

### `POST /v1/listing/promote { domain }` — self-serve Tier-1 (PR B)

1. Requires a user principal AND a `verified` claim by the caller on the
   resolved org; 403 envelope otherwise.
2. Runs the shipped `promoteStubOrg` (atomic `promoting_at` claim, 409 on
   contention, tier-1 locators → live sources, tier-2 → paused for curator
   review, locator stamping, idempotent already-`tracked` no-op).
3. Returns the promote result projection: promoted flag, created/matched
   source counts, and per-locator outcomes ("live" / "queued for review") —
   NOT the internal materialization plan.

## Gates

- **Flags:** claim/verify/list reuse `listing-self-serve-enabled` (same lane,
  same incident posture). Promotion gets ONE sibling kill switch,
  `listing-self-serve-promotion-enabled` — justified as a genuine incident
  lever because promotion creates live fetching sources (real spend), unlike
  the zero-cost stub lane. Create the key in both Flagship apps per
  convention.
- **Rate limits** (CF-native, per the existing listing pattern): the per-IP
  listing limiter covers all new routes; verify additionally gets a
  per-domain limiter (3/min) so the token check cannot be used as a hammering
  oracle; promote gets per-domain 3/min as well.
- **Auth:** user principals only (see above). Root/`relk_` callers use the
  existing admin promote route instead.

## Web

The stub org page gains a signed-in "Own this domain?" affordance:

1. Start claim → panel showing both proof instructions with copy buttons for
   the token, filename, and TXT record name.
2. **Verify** button → per-mechanism outcome display on failure (from
   `checked`), verified state on success.
3. Once verified (PR B): **Enable tracking** button — shows the tier-1/tier-2
   locator preview (reusing the existing validate projection rendering from
   `/submit`) and calls promote; success links to the now-tracked org.

House rules: no emojis; chips/icon components for badges; stub pages stay
`noindex`; error envelopes decode inline as elsewhere in the web client.

## api-types

Additive shapes, minor bump + publish: `OrgClaim`, claim/verify/list
request-responses (incl. the `checked` per-mechanism outcome enum), and the
promote request/response projection.

## Testing

- **Route tests** (`workers/api`, in-process pattern): 401 unauthenticated;
  unlisted-domain 404; idempotent claim mint (verified short-circuit); expiry
  flip; verify via well-known only, DNS only, both, neither; **fail-closed
  cases** — HTML challenge body, DoH 500, malformed dns-json, token
  mismatch; ownership check (other user's claimId → 404); promote without
  verified claim → 403; promote happy path (mocked probes) + already-tracked
  no-op + 409 contention; flag-off refusal for both flags; rate-limit 429.
  DoH + well-known fetches injected via `fetchImpl` like existing well-known
  tests.
- **Schema/migration:** paired migration; `org_claims` in the drizzle
  composite schema.
- **Web:** component/state tests for claim panel states per existing
  patterns.

## Delivery

- **PR A — claim flow:** migration + schema, claim/verify/list routes,
  api-types shapes + publish, web claim panel, tests.
- **PR B — self-serve promotion:** promote route + flag +
  per-domain limiter, web promote affordance, tests. Small — the promotion
  machinery already exists.

## Non-goals

- No org edit rights, avatar changes, or public "verified" badge surface.
- No claim-transfer or multi-owner management; no claim revocation UI
  (curators can delete rows).
- No change to admin promote/stub routes or reconciliation rules.
- No email notifications; no Turnstile.
- No CLI verbs in this phase (owners use the web flow; curators keep
  `admin org promote`).
