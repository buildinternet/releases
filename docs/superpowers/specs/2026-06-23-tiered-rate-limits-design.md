# Tiered API + MCP Rate Limits — Design

**Date:** 2026-06-23
**Status:** Design approved (incl. admin-observability requirement); proceeding to implementation plan
**Scope:** Single implementation plan

## Problem

Authenticated users get no rate-limit advantage over anonymous ones. We want
anonymous/free callers to retain a decent quota, but unlock a higher quota once
someone creates a free account and authenticates.

A premise in the original ask — "rate limiting is in D1, move it to KV for
throughput" — is incorrect and worth recording so it doesn't resurface:

- **The general API request limiter is already on Cloudflare's native Rate
  Limiting bindings** (`ratelimit` unsafe bindings in
  `workers/api/wrangler.jsonc`), which are purpose-built per-colo counters and
  strictly better than KV for high-throughput request counting (KV is
  eventually-consistent with write-rate caps — moving counters to KV would be a
  regression). No change of counter backend is needed or wanted.
- **The only rate limiter in D1** is Better Auth's brute-force protection for
  `/api/auth/*` (the `rate_limit` table, 5 attempts/60s, fail-closed in prod).
  That is low-volume and correctly placed; it is out of scope here.

### Why authenticated == anonymous today

The limiter (`workers/api/src/middleware/rate-limit.ts`) recognizes three
outcomes via `resolveAuthIdentity`:

- `root` and trusted proxy → exempt
- `kind: "token"` → per-token bucket (600/min, `TOKEN_RATE_LIMITER`)
- anonymous / invalid → per-IP bucket (120/min, `PUBLIC_RATE_LIMITER`)

`resolveAuthIdentity` calls `resolveAuth(c, presented, /* meterUserKeys */ false)`.
Under `meterUserKeys=false`, a `relu_`-shaped user API key returns
`{ kind: "none" }` (`workers/api/src/middleware/auth.ts:259-261`) — deliberately,
so a public GET never burns the key's metered budget. The side effect: a
signed-in user's `relu_` key drops into the **anonymous per-IP bucket**. Only
`relk_` machine tokens reach the elevated 600 tier. That is exactly the observed
symptom.

So the work is not "move D1 → KV." It is: **give authenticated human principals
their own bucket on the CF rate-limiter that already exists**, between the
anonymous-IP rung and the machine-token rung.

## Quota ladder

| Tier        | Principal                                | Limit (req/min) | Bucket key         | Binding                 | Status    |
| ----------- | ---------------------------------------- | --------------- | ------------------ | ----------------------- | --------- |
| Anonymous   | no / invalid credential                  | 120             | `cf-connecting-ip` | `PUBLIC_RATE_LIMITER`   | exists    |
| **Account** | valid `relu_` key **or** OAuth-JWT user  | **300**         | **`userId`**       | **`USER_RATE_LIMITER`** | **new**   |
| Machine     | `relk_` token                            | 600             | `tokenId`          | `TOKEN_RATE_LIMITER`    | exists    |
| Exempt      | static root key, trusted proxy (web SSR) | ∞               | —                  | —                       | unchanged |

The two existing endpoints (120, 600) are unchanged; the 300 account rung slots
between them.

**Bucket on `userId`, not key id.** All of an account's credentials share one
fair per-account budget — the account is the unit being gated ("create _an
account_ to unlock"). For OAuth JWTs the bucket id is the `sub` claim; for
`relu_` keys it is the `userId` returned by verification.

## Establishing a real credential without re-metering

The limiter runs _before_ the route handler, and a `relu_` key on a public GET
is currently never verified. To grant the 300 tier we must confirm the
credential belongs to a real account **inside the limiter** — otherwise any
caller presenting a random `relu_`-shaped string would mint a fresh 300 bucket
and bypass the per-IP cap entirely.

Verification has two costs we must avoid paying on every read:

1. Better Auth's `verifyApiKey` **meters** the key (consumes its budget).
2. It performs a DB / plugin lookup.

### Solution: a short-TTL KV validation cache

A dedicated KV namespace, `CREDENTIAL_CACHE`, caches _validation results_ (not
counters — counters stay on the CF limiter):

1. When a Bearer credential is present and is not `relk_`/root-shaped, compute
   `SHA-256(credential)` as the cache key.
2. **Hit** → use the cached `{ valid, userId }`:
   - `valid: true` → enforce the 300 rung keyed on `userId`.
   - `valid: false` → fall through to the per-IP anonymous rung.
3. **Miss** → verify the credential **once, without metering** (see below), then
   cache the result with a ~60s TTL (positive and negative both cached).

Properties:

- **No bypass.** A junk `relu_`-shaped string verifies as invalid, is cached as
  invalid, and stays in the IP bucket. Valid accounts are the only path to 300.
- **No re-metering on reads.** Validation happens at most once per credential
  per ~60s; metering of the key's budget still happens only at the authenticated
  authorization point for writes (`meterUserKeys=true`), unchanged.
- **Bounded cost.** At most one verify per credential per TTL window.
- **Trade-off:** up to ~60s lag on the _rate tier_ for a freshly revoked key.
  This affects only which rate bucket applies, never auth itself — write
  authorization still verifies live every request.

### `validateOnly` verification path

Add a non-metering validation path used solely by the limiter:

- `relu_` keys: **primary** — a direct read of the `apikey` row keyed on the
  key's lookup id to confirm existence + active (non-revoked, non-expired) state
  and resolve `userId`, bypassing `verifyApiKey`'s metering entirely. (Only if a
  direct row read proves impractical do we fall back to `verifyApiKey` with a
  no-meter option, should Better Auth expose one.) Returns `{ valid, userId }`.
- OAuth JWTs: `verifyPresentedJwt` already validates locally against the AS JWKS
  — no DB, no metering. Returns `{ valid, userId: sub }`.

The limiter never grants the 300 tier on an unverified credential.

## Shared between API and MCP

The MCP worker (`workers/mcp/`) has **no rate limiting today** and is in scope.
To avoid divergence:

- Extract the rung table + bucket-resolution (`resolveTier()`) and the KV
  validation-cache helper into a small shared module in `packages/lib`.
- Both workers import it and apply the same three-rung enforcement.
- The MCP worker gains the CF rate-limit bindings + the `CREDENTIAL_CACHE` KV it
  currently lacks.

`resolveTier()` takes the resolved principal signals and returns
`{ limiter, key, policyName, quota }` (or an exempt signal). The per-worker
middleware wires it to that worker's bindings and emits the response headers.

## Wiring details

- **New CF binding** `USER_RATE_LIMITER` (namespace id `1006`,
  `simple: { limit: 300, period: 60 }`) in both `workers/api/wrangler.jsonc` and
  `workers/mcp/wrangler.jsonc`.
- **New KV namespace** `CREDENTIAL_CACHE` (dedicated, **not** reused — clean
  TTL/eviction reasoning for security-sensitive validation data) in both
  workers' `wrangler.jsonc`, with preview ids.
- **Enablement:** the account rung rides the existing `RATE_LIMIT_ENABLED` gate
  (it is part of the same public-read-limiting feature). **No new feature flag**
  (AGENTS.md: be judicious with flags). The machine `TOKEN_RATE_LIMITER` keeps
  its own existing `TOKEN_RATE_LIMIT_ENABLED` env var.
- **Headers:** extend the `RateLimit-Policy` advertisement to include the
  `"account"` policy (`"account";q=300;w=60`) so well-behaved agents self-pace.
- **Logging:** add an `account-throttled` `logEvent` mirroring the existing
  `token-throttled` / `ip-throttled` events. See **Admin observability** for the
  consumption stream the same emit feeds.

## Admin observability (consumption queryable later)

We don't expose limits in the UI, but admins must be able to query rate-limit
consumption "when the time comes." The CF rate-limit binding returns only
`{ success }` — it stores **no readable counts** — so the consumption signal has
to be emitted by us. Design for that now; build no admin route yet.

**Emit a structured decision signal on every limited request**, not just on
rejection, so consumption (used volume) is reconstructable per principal, not
only the ceiling-hit moments:

- Reuse the existing per-authenticated-request consumption event
  (`emitApiConsumption` → `logEvent`, already PII-clean via the hashed
  `consumerRef` from #1719). **Add two fields:** `tier`
  (`anonymous|account|machine`) and `rateLimited` (boolean outcome). No new
  event, no extra log volume on the authenticated path — the event already
  fires once per request.
- For the **anonymous** rung (no consumption event today), emit a lightweight
  `rate-limit` decision event carrying `tier:"anonymous"`, `rateLimited`, route
  family, and a **hashed** IP bucket id (consumerRef-style hash — never the raw
  IP in the consumption stream), **sampled** (e.g. 1-in-N + always-on for
  rejections) to bound public-read log volume.
- The `*-throttled` warn events stay as the operational abuse-investigation
  signal (these may retain the raw IP — short-retention operational logs, not
  the PII-clean consumption stream).

**Query surface:** Axiom is the admin query surface for worker logs today (the
`releases-cloudflare-logs` dataset, JSON in `body`). An admin can already slice
consumption by `consumerRef`, `tier`, and `rateLimited` there. A thin
`GET /v1/admin/rate-limit/consumption` route can be layered later — wrapping an
Axiom query, or a periodic rollup — **without any hot-path or schema change**,
because the per-principal, per-tier signal is already in the log stream. That
deferred route is explicitly out of scope here; the requirement satisfied now is
that the data exists and is keyed to support it.

The bucket key (`userId` for account, `tokenId` for machine, hashed IP for
anonymous) is the join key for all consumption queries — it matches the
rate-limit bucket exactly, so "how much of their quota is principal X using" maps
directly to a count of their events in the window.

## Dependencies and rollout notes

- `relu_` user API keys are gated behind `USER_API_KEYS_ENABLED`, **currently
  OFF**. At ship time the account tier is therefore **live for OAuth-JWT users**
  and **wired-but-dark for `relu_` keys** until that flag rolls out. The
  plumbing is correct regardless of flag state.
- The end-user "unlock" path = mint a free read-only `relu_` key (or use device
  login / "Sign in with Releases" OAuth). That UX already exists; it is not built
  here.
- Production rollout sequence is independent of this change: flip
  `RATE_LIMIT_ENABLED` on (it currently defaults off) to begin enforcing the
  public-read + account rungs. The machine-token rung is already on.

## Out of scope

- Web browsing tiers. Web reads route through the trusted-proxy exemption
  (logged in or not); giving logged-in browsing a per-user limit would require
  the web frontend to forward a per-user identity and is explicitly deferred.
- Moving any counter to KV. Counters stay on CF native Rate Limiting bindings.
- The Better Auth `/api/auth/*` brute-force limiter (stays on D1).
- Per-account paid/higher tiers beyond the single 300 account rung.
- The admin consumption **query route** (`GET /v1/admin/rate-limit/consumption`)
  and any rollup job — deferred. We only guarantee the underlying signal exists
  and is keyed to support it (see Admin observability).

## Testing

- `resolveTier()` unit tests: each principal class → correct
  `{ limiter, key, quota, policyName }`; root/proxy → exempt.
- KV validation-cache: hit (valid → 300/`userId`), hit (invalid → IP), miss →
  verify-once-then-cache, negative caching of junk credentials.
- **Bypass guard:** a junk `relu_`-shaped string → IP bucket, never 300.
- OAuth-JWT principal → 300 bucket keyed on `sub`, no DB/metering call.
- `relu_` `validateOnly` path does not increment the key's metered usage.
- Existing CF binding `{ success }` shape is mocked (matches current tests);
  no live binding needed.
- Header assertions: `RateLimit-Policy` advertises `account`; 429 response
  carries `Retry-After`.
- **Consumption signal:** the consumption event carries `tier` + `rateLimited`
  for each principal class; the anonymous decision event hashes the IP (no raw
  IP in the consumption stream) and respects sampling (rejections always
  emitted).

## Files touched (anticipated)

- `packages/lib/src/rate-limit-tiers.ts` (new) — `resolveTier()` + KV cache
  helper, shared.
- `workers/api/src/middleware/rate-limit.ts` — wire the account rung via the
  shared helper.
- `workers/api/src/middleware/auth.ts` — add the `validateOnly` (non-metering)
  resolution path.
- `workers/api/wrangler.jsonc` — `USER_RATE_LIMITER` binding + `CREDENTIAL_CACHE`
  KV.
- `workers/mcp/` — apply the shared limiter middleware; add the same bindings.
- `workers/mcp/wrangler.jsonc` — `USER_RATE_LIMITER` + `CREDENTIAL_CACHE`.
- `workers/api/src/middleware/auth.ts` (consumption emit) — add `tier` +
  `rateLimited` to the consumption payload; the limiter passes the resolved tier
  - outcome through. The anonymous decision event is emitted from the limiter.
- Tests alongside the above.
