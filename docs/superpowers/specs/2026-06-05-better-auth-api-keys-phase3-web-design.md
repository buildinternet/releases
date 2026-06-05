# Better Auth API Keys — Phase 3 (web self-serve + scope cap) — Design

**Date:** 2026-06-05
**Status:** Approved (design); pending implementation plan
**Surface:** API worker (`workers/api/`) — new session-authed self-serve routes, the self-serve scope cap, the public-read metering exemption, `/tokens/me` enrichment; web frontend (`web/`) — the self-serve panel; MCP worker (`workers/mcp/`) — one copy fix.
**Builds on:** [`2026-06-04-better-auth-api-keys-design.md`](./2026-06-04-better-auth-api-keys-design.md) (master design — §5 "Self-serve surface" and §10 step 4 are this phase) and [`2026-06-05-better-auth-api-keys-phase2-mcp-design.md`](./2026-06-05-better-auth-api-keys-phase2-mcp-design.md) (Phase 2 — MCP enforcement, shipped as #1435).

## Summary

Phases 1–2 made `relu_` user API keys real on the server: the `@better-auth/api-key` plugin is the system-of-record (flag-gated, `apikey` table landed), the API-worker middleware verifies + meters them, and the MCP worker enforces them through the `API` binding with a meter-once invariant. Everything ships **inert** today — `user-api-keys-enabled` is off and presented `relu_` keys resolve to anonymous.

Phase 3 is the **last build before flag-on**: let signed-in users mint, list, and revoke their **own** keys from the web app, with the **`admin` scope ceiling enforced server-side**, and resolve the carried-over product decision (public reads do **not** meter). It also folds in the two Phase-2 handoff loose ends (the `relu_`-aware `scopeError` copy; `/tokens/me` name + userId enrichment). No schema or migration (the `apikey` table already exists). The flag flip itself is an ops step, not code.

Two facts from the plugin's actual API shape the whole design (verified against the Better Auth api-key reference, 2026-06-05):

1. **The plugin's _client_ `create` cannot set `permissions` or `userId`** — both are server-only. A browser call to `authClient.apiKey.create()` can only ever receive the plugin's `defaultPermissions` (read-only). To let a user _choose_ read vs. write **and** cap at write, the create must run **server-side** (`auth.api.createApiKey({ body: { permissions, userId } })`). This is why Phase 3 wraps create rather than calling the plugin client directly.
2. **List/delete are simplest as direct Drizzle on the `apikey` table.** The plugin's `listApiKeys`/`deleteApiKey` are session-cookie-scoped, but with `storage: "database"` a query filtered by `referenceId = session.user.id` is equivalent, more explicit, and testable without forging a signed session cookie (a delete is complete — no secondary-storage eviction to defer to the plugin). So we own list/delete via Drizzle and reach for the plugin only on create (where it generates + hashes the key).

## Goals

- Authenticated users mint (name + scope), list, and revoke their **own** `relu_` keys from `releases.sh`, self-service.
- **`admin` scope ceiling enforced server-side**: a self-serve create accepts only `read` / `write`; `admin` (and anything else) is rejected with `400`. A logged-in user can never mint a key that outranks self-serve privilege.
- **Public reads do not meter** a presented `relu_` key — read as anonymous, no rate-limit/quota burn. `relu_` keys meter only on authenticated operations (writes, admin-gated routes, self-introspection) and on the MCP-native AI tools (Phase 2, unchanged).
- Surface the key correctly: full key revealed **exactly once** at creation; never retrievable again.
- Resolve the two Phase-2 loose ends (`scopeError` copy; `/tokens/me` enrichment).
- Ship inert behind the existing `user-api-keys-enabled` server flag plus a new `NEXT_PUBLIC_USER_API_KEYS` web reveal flag, so the panel stays dark until flag-on.

## Non-goals (named boundaries)

- **Flipping `user-api-keys-enabled` on.** That, plus creating the Flagship key in both apps (still pending) and setting `NEXT_PUBLIC_USER_API_KEYS=true` in Vercel, is the ops rollout — out of scope for the code change.
- **A published `UserApiKey` api-types wire shape.** Deferred (decided). The web uses a worker-local response type; publish in api-types when CLI Phase 4 (device-auth) needs cross-consumer parity.
- **Key rotation / edit-in-place / scope change after creation.** v1 is create + list + revoke. Changing a key's scope = revoke + re-create.
- **Tiers / quota self-selection.** All self-serve keys land on the single default tier (`metadata.plan = "default"`); `remaining`/refill stay operator-controlled.
- **CLI verbs** for user-key management — downstream `releases-cli`, later phase.
- **Organization-owned keys** — needs the held `organization` plugin (master-design non-goal, unchanged).
- **Migrating the `relk_` machine lane** — entirely untouched.

## Decisions and rationale

| Decision                    | Choice                                                                                        | Why                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where self-serve lives      | **`/v1/api-keys`** (top-level resource), session-authed                                       | Matches `routing.md`'s `/v1/<resource>` "Resource CRUD" bucket and parallels the sibling `/v1/tokens` machine lane; uses the design's own vocabulary (user **API keys** vs. machine **tokens**). No `account/`/`me/` namespace precedent exists. |
| Create path                 | **Wrapped server-side** `POST /v1/api-keys` calling `auth.api.createApiKey`                   | The plugin client `create` can't set `permissions`/`userId`; only a server call can both honor a read/write choice and cap at write.                                                                                                             |
| List / delete               | **Direct Drizzle** on `apikey` filtered by `referenceId = session.user.id`                    | Explicit, testable ownership; `storage: "database"` makes a direct delete complete; no need to thread the signed session cookie into the plugin's list/delete.                                                                                    |
| Scope cap                   | Reject `scope ∉ {read, write}` → `400`, server-side, before `createApiKey`                    | Explicit, auditable ceiling with a clean error — not a silent cap, not UI-only.                                                                                                                                                                  |
| Auth model for the resource | **Session cookie** (`requireSession`), a third bucket beyond public-read and admin            | These are first-party, browser, current-user operations; the session is the only user credential the browser holds.                                                                                                                              |
| CORS                        | Credentialed `authCorsMiddleware()` on `/v1/api-keys/*`, before the wildcard `publicReadCors` | Session cookies need a reflected origin + `Allow-Credentials`; mirrors the existing `/api/auth/*` carve-out exactly.                                                                                                                             |
| Metering on reads           | **Exempt** — `relu_` verified+metered only at the authenticated authorization point           | Decided. A key holder shouldn't burn budget for a read that's free to anonymous callers; also simpler (no verify on public reads).                                                                                                               |
| Metering placement          | Thread a `meterUserKeys` flag through resolution; `true` only on the auth-required path       | Today metering lives in the shared resolver the rate limiter also calls; the flag moves the single meter to the authorization decision so reads don't trip it.                                                                                   |
| `/tokens/me` enrichment     | Read the `apikey` row by id in the handler                                                    | Isolated; no AuthContext widening, no extra metering, no api-types change (fields fit `TokenIdentity`).                                                                                                                                          |
| Web client transport        | Plain `fetch(..., { credentials: "include" })` to `/v1/api-keys`, **not** `apiKeyClient()`    | We wrap the surface; registering the plugin client would add a second create path (default read-only) and bloat the bundle.                                                                                                                      |
| Panel reveal                | New `NEXT_PUBLIC_USER_API_KEYS` flag gating the panel                                         | Keeps the panel dark until the server flag is on; mirrors `NEXT_PUBLIC_AUTH_MAGIC_LINK`.                                                                                                                                                         |

## 1. The `/v1/api-keys` resource (API worker)

A new session-authed namespace, parallel to the admin `/v1/tokens` lane. New file `workers/api/src/routes/user-api-keys.ts` (`userApiKeyRoutes`; named to distinguish from the existing `api-tokens.ts` machine lane), mounted on the `v1` sub-app and **not** added to `publicReadRoutes` or `adminRoutes` (it is the new session bucket).

### `requireSession` middleware

A small middleware (worker-local, beside the other auth middleware):

1. If `user-api-keys-enabled` is off (Flagship → var → default-false) → `404 { error: "not_found" }`. Feature dark; the panel hides on this.
2. Resolve the Better Auth session: `auth.api.getSession({ headers: c.req.raw.headers })` (per-request `createAuth(c.env, waitUntil)`, same construction the verify path already uses).
3. No session → `401 { error: "unauthorized", message: "Sign in required" }`.
4. Attach the session to context (`c.set("session", session)`); extend the Hono `Env` `Variables` with an optional `session`.

### Endpoints (all session-gated; owner = `session.user.id`)

- **`POST /v1/api-keys`** — create. Body `{ name: string, scope: "read" | "write", expiresInDays?: number }`.
  - Validate `name` (non-empty after trim; plugin also enforces min/max length).
  - **Scope cap (the headline requirement):** `scope ∉ {read, write}` → `400 { error: "bad_request", message: "scope must be 'read' or 'write'" }`. `admin` is unreachable for self-serve.
  - `expiresInDays`, when present, must be a positive integer within the plugin's `keyExpiration` bounds (1–365 days) → else `400`; converted to `expiresIn` seconds.
  - `auth.api.createApiKey({ body: { name, permissions: scopeToPermissions(scope), userId: session.user.id, metadata: { plan: "default" }, ...(expiresIn ? { expiresIn } : {}) }, headers })`.
  - **Reveal-once** response `201 { key, id, name, start, scope, remaining, expiresAt, createdAt }` (the only time `key` is returned). `scope` is derived back via `apiScopesFromPermissions` → top ladder label.
- **`GET /v1/api-keys`** — list. `db.select().from(apikey).where(eq(apikey.referenceId, session.user.id))`. Project each row to `{ id, name, start, scope, enabled, remaining, lastRequest, createdAt, expiresAt }` (scope via `apiScopesFromPermissions(JSON.parse(row.permissions))`; timestamps → ISO). The hashed `key` column is never read into the projection.
- **`DELETE /v1/api-keys/:id`** — revoke (hard delete). `db.delete(apikey).where(and(eq(apikey.id, id), eq(apikey.referenceId, session.user.id))).returning()`; **the `referenceId` clause is the ownership check.** Zero rows deleted → `404 { error: "not_found" }` (one indistinct response for "absent" and "not yours" — no cross-user existence oracle).

### CORS + rate limit + mounting

- Register `authCorsMiddleware()` for `/v1/api-keys/*` **before** the wildcard `publicReadCors`, and add `/v1/api-keys/` to the wildcard's carve-out predicate (today it skips `/api/auth/`). This gives the resource credentialed, origin-reflecting CORS so the browser sends the cross-subdomain session cookie.
- Apply the existing per-IP `publicRateLimitMiddleware` to the namespace for parity on the read (`GET` list) path. Note it no-ops on non-safe methods, so it does **not** throttle `POST`/`DELETE`; create/delete are session-gated (a logged-in user spamming their own key list is low-risk), and a dedicated create-rate limiter is deferred hardening.
- `routing.md` gains a short note: `/v1/api-keys` is the session-authed self-serve bucket — gated by `requireSession`, intentionally absent from both allowlist arrays and from the public-read OpenAPI coverage gate.

## 2. Metering model — exempt public reads (API worker)

Today `relu_` metering is a side effect of `verifyUserKey` (→ Better Auth `verifyApiKey`, which increments the rate counter and decrements `remaining`), and that runs inside the shared `resolveAuth` the **rate limiter** also calls. So a `relu_` key on a public GET currently meters. There is no non-metering verify in the plugin, so "exempt reads" cannot mean "verify without metering" — it means **do not verify `relu_` at all except where the route genuinely requires auth.**

Refactor `workers/api/src/middleware/auth.ts` to thread a `meterUserKeys: boolean` through resolution. The `relu_` branch in `resolveAuthUncached` verifies + meters **only when `meterUserKeys === true`**; otherwise it returns anonymous (`{ kind: "none", skip: false }`) without touching the plugin. The memo is keyed per request **and** per mode so each mode resolves at most once (one meter per request maximum).

Callers:

| Caller                                                                                                                                                                           | `meterUserKeys` | Effect on `relu_`                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Rate limiter (`resolveAuthIdentity` / `hasValidAuth`)                                                                                                                            | `false`         | Not verified/metered; treated as anonymous for per-IP exemption.                                                                |
| `isValidBearerAuth` (admin-field unlock on public reads)                                                                                                                         | `false`         | A `relu_` key caps at write and can never unlock admin fields, so resolving it is pointless — don't meter to learn "not admin". |
| Public-read attach branch (`allowPublicReads && SAFE_METHODS`)                                                                                                                   | `false`         | Public catalog GET reads as anonymous — **no budget burn.**                                                                     |
| Auth-required path (`createAuthMiddleware` non-public block: the write branch of `publicReadAuthMiddleware`, the admin `authMiddleware`, and `requireReadAuth` for `/tokens/me`) | `true`          | Verify + **meter once**.                                                                                                        |

Net behavior, one sentence: **`relu_` keys meter only on authenticated operations (writes, admin-gated routes, self-introspection); public catalog reads are free.** Result matrix:

- Public catalog `GET` + `relu_` → ignored, no meter, anonymous read.
- `POST`/`PATCH`/`DELETE` (write) + `relu_` → verify + meter once → `200`/`403`/`429`.
- Admin-gated route + `relu_` → verify + meter once, then `403` (caps at write). Metering a doomed admin attempt is a rare, acceptable wart.
- `GET /tokens/me` + `relu_` → verify + meter once (introspection; low frequency) → enrichment (§3).
- MCP native AI tools + `relu_` → meter once (Phase 2, unchanged); MCP forwarding tools defer to the API worker, so the read exemption propagates for free.

Known trade-off (documented, accepted): `relu_` holders are no longer exempt from the per-IP **read** limiter (we can't resolve identity without metering through the plugin). The per-key limit remains the intended control on writes; the per-IP read limit rarely bites a single authenticated user.

## 3. `/tokens/me` enrichment (loose end #2)

In `apiTokenRoutes.get("/tokens/me")`, the `relu_` branch currently returns `name: "user-api-key"`, `principalId: null`. Enrich: strip the prefix from `auth.tokenId` → `keyId`; read the `apikey` row by id (`db.select().from(apikey).where(eq(apikey.id, keyId)).get()`); return:

- `name: row.name`
- `principalId: row.referenceId` (the Better Auth user id)
- `expiresAt: row.expiresAt`
- `lastUsedAt: row.lastRequest`
- `scopes` from `auth.scopes` (already resolved), `kind: "token"`, `principalType: "user"`.

All fields fit the existing `TokenIdentity` — **no api-types change.** If the row is gone (revoked between verify and this read), fall back to the current minimal identity rather than 500.

## 4. MCP `scopeError` copy (loose end #1)

`workers/mcp/src/mcp-agent.ts` `scopeError()` currently reads `…Present one via Authorization: Bearer relk_…`. Update the text to name **both** lanes so a live `relu_` holder gets accurate guidance, e.g.:

> `insufficient_scope: this MCP tool requires a '<scope>'-scoped API key. Present a write-capable key via Authorization: Bearer (relk_… machine token or relu_… user key).`

Copy-only; no behavior change.

## 5. Web — self-serve panel

- **Page:** new `web/src/app/account/page.tsx` (server component shell), gated on `AUTH_UI_ENABLED` + `NEXT_PUBLIC_BETTER_AUTH_URL` (same guard as `AccountNav`). Renders the panel only client-side once a session resolves; signed-out → redirect/link to `/login`. (The web _page_ path `/account` is the user-facing settings URL and is a separate namespace from the _API resource_ path `/v1/api-keys` — the `routing.md` `/v1/<resource>` convention governs the API path, not web page routes.)
- **Reveal flag:** a new `NEXT_PUBLIC_USER_API_KEYS` (default off) gates whether the API Keys panel renders at all, so the surface stays dark until the server flag is on. Mirrors `NEXT_PUBLIC_AUTH_MAGIC_LINK`.
- **`ApiKeysPanel`** (client component):
  - **List:** name · `start•••` · scope chip · `remaining` · last used · created · expires, each with a revoke control. Loading / empty / locked / error states.
  - **Create:** name input + scope radio (read / write) + optional expiry → `POST` → render the full key **once** in a copyable box with a "Copy" button and an "I've saved it" dismiss; the key is cleared from state on dismiss and never shown again.
  - **Revoke:** inline two-step confirm (no `window.confirm` / browser dialog — house rule), then `DELETE`, then refetch.
  - Stone palette, no emojis / arrow glyphs (house rules).
- **Transport:** a small `web/src/lib/api-keys.ts` calling `${NEXT_PUBLIC_BETTER_AUTH_URL-origin}/v1/api-keys` with `fetch(..., { credentials: "include" })`. Not the plugin client.
- **Nav:** add an "API keys" link to the `AccountNav` dropdown (desktop + mobile) → `/account`, shown only when `NEXT_PUBLIC_USER_API_KEYS` is on.

## 6. Flags, schema, config

- **Server flag:** `user-api-keys-enabled` (existing) gates `requireSession` (404 when off) and the plugin registration (Phase 1). No new server flag.
- **Web flag:** `NEXT_PUBLIC_USER_API_KEYS` (new, default off) gates the panel + nav link.
- **Schema/migration:** none — the `apikey` table landed in Phase 1.
- **`.env.example`:** document `NEXT_PUBLIC_USER_API_KEYS` (web). No secret changes. (House rule: never edit `.env` directly.)

## 7. Security considerations

1. **Scope ceiling is server-side** — `400` on `scope ∉ {read, write}` before `createApiKey`; the UI offering only read/write is convenience, not the control.
2. **Ownership** — every query is filtered by `referenceId = session.user.id` (list/delete) and create passes `userId: session.user.id` (the plugin's server-only field); the owner is always the session, never a client-supplied id, so a user can only mint/list/revoke their own keys. Delete of a non-owned/absent key returns an indistinct `404`.
3. **Reveal-once** — the full key is returned only from `POST`; list/get never include it; hashing stays on (`disableKeyHashing` false).
4. **Redaction** — the key / `Authorization` header never appear in `logEvent`, telemetry, or error traces; only `id`/`start` are loggable.
5. **CORS** — credentialed CORS is scoped to `/v1/api-keys/*` and reflects only the auth trusted-origins allow-list (releases.sh family + configured extras + loopback off-prod); it never widens the wildcard public CORS.
6. **Session-only** — the resource is reachable only with a valid session cookie; a `relu_`/`relk_` Bearer does not authenticate it (you manage keys as a human, not as a key).
7. **Metering integrity** — the `meterUserKeys` split keeps the meter-once invariant: at most one meter per request, only on authenticated operations; reads can't be made to over- or under-count by routing.
8. **Instant revocation** — D1-backed, no verification cache; a deleted key fails on the next authenticated request.

## 8. Testing

- **Scope cap (unit, db-helper fixtures):** create with `admin` / garbage → `400`; `read` → `{ api: ["read"] }`; `write` → `{ api: ["read","write"] }`; created key verifies at the expected scope.
- **Ownership:** user A cannot delete user B's key (→ `404`); list returns only the caller's keys.
- **Reveal-once / projection:** `POST` returns `key`; `GET` list never contains `key`; `scope` derived correctly from permissions.
- **`requireSession`:** no session → `401`; flag off → `404`.
- **Metering model:** public `GET` + `relu_` → not metered (remaining unchanged); write + `relu_` → metered once; `GET /tokens/me` + `relu_` → metered once; `relk_`/root unaffected and unmetered.
- **`/tokens/me` enrichment:** returns real `name` + `referenceId`; missing row → graceful minimal identity.
- **MCP `scopeError`:** asserts the message names both lanes.
- **Web:** create→reveal-once→list→revoke under a session; locked state when `NEXT_PUBLIC_USER_API_KEYS` off.
- Existing `relk_` / root / constant-time / Phase-2 meter-once tests stay green.

## 9. Rollout (code ships inert)

1. Merge Phase 3 — panel dark (`NEXT_PUBLIC_USER_API_KEYS` off), `requireSession` returns `404` (`user-api-keys-enabled` off). No behavior change.
2. **(Pending, ops)** create `user-api-keys-enabled` OFF in both Flagship apps (`releases-platform`, `releases-platform-staging`).
3. Enable in **staging**: smoke create→reveal→list→revoke; confirm write meters, public read does not, `/tokens/me` enriches; confirm `relk_`/root untouched.
4. Set `NEXT_PUBLIC_USER_API_KEYS=true` in Vercel and flip `user-api-keys-enabled` ON in prod Flagship; mint the first user keys.

Rollback at any step: flip `user-api-keys-enabled` off (whole user-key path) or `NEXT_PUBLIC_USER_API_KEYS` off (panel only); `API_TOKENS_DISABLED=true` disables both token lanes, leaving the static root key as break-glass.

## 10. Future work

- Published `UserApiKey` api-types shape + OSS CLI verbs (CLI Phase 4 device-auth).
- Key edit-in-place (rename) / scope change / rotation.
- Per-key usage view (request counts, last-used trend) once metering history is worth surfacing.
- `/tokens/me` `remaining` field (needs an api-types `TokenIdentity` addition).
