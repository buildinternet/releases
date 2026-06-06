# Phase 4 — Publish `UserApiKey` wire shape + `releases keys` CLI verbs

**Issue:** [#1445](https://github.com/buildinternet/releases/issues/1445)
**Date:** 2026-06-06
**Depends on:** Phase 1 (#1434), Phase 2 (#1435), Phase 3 (#1444, merged), read-only cap (#1448). Prod has live `relu_` keys (flag `user-api-keys-enabled` ON; rollout #1446 closed).

## Goal

Close out the user API key (`relu_`) work by surfacing two things deferred during Phase 3:

1. **Publish** the `UserApiKey` / `CreatedUserApiKey` wire shapes from `@buildinternet/releases-api-types` so the CLI and any other consumer share one definition instead of the web's local copy.
2. **Add `releases keys` verbs** (`create` / `list` / `revoke`) to the OSS CLI (`buildinternet/releases-cli`), authenticating against the session-gated `/v1/api-keys` endpoints.

This spec spans two repos: the monorepo (Part 1) and `releases-cli` (Part 2). Part 1 publishes the types that Part 2's typed client consumes, so Part 1 lands (and publishes) first.

## Background — the auth constraint that shapes Part 2

The `/v1/api-keys` management endpoints (`workers/api/src/routes/user-api-keys.ts`) sit behind `requireSession` — they require a **Better Auth session**, honored as a session bearer token via the `bearer()` plugin. They are **not** satisfied by a `relu_` API key (an apikey credential) or a `relk_` machine token.

The CLI's `login` command (device authorization, RFC 8628) today exchanges the device-flow **session token** for a durable read-only `relu_` key and stores _only that key_ (`StoredCredential.token`). The session token is discarded. So the CLI currently holds no credential that can reach the management endpoints.

**Decision (brainstormed):** persist the session token at login and reuse it for `keys` verbs, with transparent re-login on expiry. Rejected alternatives: on-demand device login per command (browser popup on every `keys list` — poor UX).

## Part 1 — Publish the wire shape (monorepo)

### Types to add — `packages/api-types/src/api-types.ts`

Plain interfaces, mirroring the existing `ListResponse<T>` style in this file. `scope` reuses `ApiScope` from `@buildinternet/releases-core/api-token` (already published in the `^0.23.0` range this package pins — **no core co-bump**).

```ts
import type { ApiScope } from "@buildinternet/releases-core/api-token";

/** A user-owned API key (relu_) as returned by GET /v1/api-keys. */
export interface UserApiKey {
  id: string;
  name: string | null;
  start: string | null;
  scope: ApiScope | null;
  enabled: boolean | null;
  remaining: number | null;
  lastRequest: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  expiresAt: string | null; // ISO 8601
}

/** Create response — includes the full key string exactly once. */
export interface CreatedUserApiKey extends Omit<UserApiKey, "enabled" | "lastRequest"> {
  key: string;
}

/** GET /v1/api-keys response envelope. */
export interface ListUserApiKeysResponse {
  apiKeys: UserApiKey[];
}

/** POST /v1/api-keys request body. Self-serve mints are capped at read server-side. */
export interface CreateUserApiKeyBody {
  name: string;
  scope?: ApiScope;
  expiresInDays?: number;
}
```

These match the server route's `GET`/`POST` responses and the web local type field-for-field:

- **List item:** `{ id, name, start, scope, enabled, remaining, lastRequest, createdAt, expiresAt }`
- **Create (reveal-once):** `{ key, id, name, start, scope, remaining, expiresAt, createdAt }`

### Publish

- Bump `packages/api-types/package.json` `0.30.0 → 0.31.0` (minor, additive). The version bump on push to `main` is what fires `publish-*.yml` (OIDC).
- Do **not** co-bump `@buildinternet/releases-core` — no shared type is touched; `ApiScope` already exists in the published core.

### Swap the web local type — `web/src/lib/api-keys.ts`

- Import `UserApiKey`, `CreatedUserApiKey` (and optionally `ListUserApiKeysResponse`) from `@buildinternet/releases-api-types`.
- Delete the file's local `UserApiKey` / `CreatedUserApiKey` interface declarations.
- Keep the fetch helpers (`listApiKeys`, `createApiKey`, `revokeApiKey`) and the `UserApiKeyScope` display alias if still referenced; retype it to `ApiScope` or drop it in favor of the published type.
- Verify `web` type-checks against the published shape (the published `scope: ApiScope | null` is the same `"read" | "write" | "admin" | null` set the local type used).

> Note: the web build consumes api-types via `workspace:*`, so the swap type-checks locally against the new source before the npm publish completes. The published bump matters for the external CLI consumer, not the in-repo web build.

## Part 2 — `releases keys` CLI verbs (`releases-cli` repo)

### Credential model — `src/lib/credentials.ts`

Add an optional `sessionToken` to `StoredCredential`:

```ts
export interface StoredCredential {
  token: string; // durable read-only relu_ key — used for normal API calls
  sessionToken?: string; // device-flow session token — used for /v1/api-keys management
  name?: string;
  scopes?: string[];
  apiUrl: string;
  savedAt: string;
}
```

- The `readCredential()` trust-boundary validator gains: if `sessionToken` is present it must be a non-empty string, else the credential is rejected (consistent with the existing `token` validation).
- Stored at mode `0600` (unchanged write path). **Security note documented inline:** the session token is broader than the read-only `relu_` key — it can manage the account — so it lives in the same `0600` file and is cleared by `auth logout` / `clearCredential()`.

### Device-auth refactor — `src/lib/device-auth.ts`

Split today's `runDeviceLogin()` so the session can be obtained without minting a key:

- **New `runDeviceAuth(args): Promise<{ sessionToken: string; user: SessionUser | null }>`** — request device code → print/open URL → `pollForToken` → `getSessionUser`. Returns the session token. Mints nothing.
- **`runDeviceLogin()` becomes** `runDeviceAuth()` + `createUserApiKey()`, returning `{ token: created.key, sessionToken, name, scopes, apiUrl }` so `login` can persist both.

This guarantees the auto-reauth path (below) never creates a stray `relu_` key — important because extra keys count against `USER_API_KEY_MAX_ACTIVE` and clutter `keys list`.

### Session helper — `src/lib/credentials.ts` or a small `src/lib/session.ts`

```
getSessionToken(apiUrl, { interactive }): Promise<string>
```

1. Read `credentials.sessionToken`. If present, return it.
2. If absent → run `runDeviceAuth()` (browser), persist the new `sessionToken` onto the existing credential (or a fresh one), return it.
3. Callers retry **once** on a 401 from a management endpoint: clear the stale `sessionToken`, call `getSessionToken()` again (forces re-auth), retry the request. A second 401 is a hard error.

Better Auth sessions default to a ~7-day TTL refreshed on use, and the bearer session token is stable for the session's lifetime (not rotated per request), so a stored token survives normal intermittent CLI use; expiry surfaces as the 401 → re-auth path.

### Commands — `src/cli/commands/keys.ts`, registered in `src/cli/program.ts`

A `keys` command group with three subcommands, all calling `${apiUrl}/v1/api-keys` with `Authorization: Bearer <sessionToken>` and typed against the published api-types shapes:

- **`releases keys create --name <name> [--expires-in-days <N>]`**
  - `POST /v1/api-keys` with body `{ name, scope: "read"[, expiresInDays] }`.
  - **No `--scope` flag.** User keys are read-only (#1448); the server returns 400 for anything above read and the auth resolver clamps regardless. The CLI must not offer write/admin (mirrors the web panel + the issue's comment).
  - Prints the revealed-once `key` with a "store it now, it won't be shown again" warning. Supports `--json`.
- **`releases keys list`**
  - `GET /v1/api-keys`. Table: `id`, `name`, `scope`, `start` (key prefix), `created`, `expires`, `remaining`. `--json` passes through the envelope.
- **`releases keys revoke <id>`**
  - `DELETE /v1/api-keys/:id`. Confirm prompt (reuse `src/lib/confirm.ts`); `--yes`/`--force` to skip. 404 → "no such key" message (the route returns an indistinct 404 for non-owned/absent ids by design).

### Error surfaces

- `409 api_key_limit` on create → surface the server `message` ("active key limit reached"), not a generic failure.
- `400` on create (bad name / scope / expiresInDays) → surface the server `message`.
- Network/HTTP failures → the CLI's standard error formatting.

### Release

- `.changeset/*.md` targeting `@buildinternet/releases` (cascades to the published packages, per repo convention). Summary: "Add `releases keys` verbs (create/list/revoke) for self-serve user API keys."
- Pin api-types to the newly published `^0.31.0` in the CLI's dependency on `@buildinternet/releases-api-types`.

## Sequencing

1. **Part 1** lands in the monorepo and merges to `main` → `publish-*.yml` publishes `@buildinternet/releases-api-types@0.31.0`.
2. **Part 2** in `releases-cli` bumps its api-types pin to `^0.31.0`, implements the verbs, and is smoke-tested end-to-end against a real prod `relu_` flow.

## Testing

**Part 1 (monorepo):**

- `npx tsc --noEmit` (root + workers) and `web` type-check pass with the published shape.
- `bun test` for any api-types consumers unaffected.

**Part 2 (CLI):**

- Unit: `runDeviceAuth` returns a session token and mints nothing (mock fetch); `getSessionToken` returns the stored token, and on a simulated 401 forces re-auth and retries once.
- Unit: `credentials` validator accepts/rejects `sessionToken` correctly; round-trips the new field.
- Unit: each verb hits the right method/path/body and renders table + `--json` (mock client; mind `getApiUrl()` memoization — use `https://test.example.com` or match by path suffix per the known test gotcha).
- Manual smoke (post-publish, against prod): `login` → `keys list` (shows the login-minted key) → `keys create --name probe` (revealed once, read scope) → `keys list` (probe present) → `keys revoke <id>` → `keys list` (gone). Confirm a `relu_` key still cannot reach the management endpoints (only the session can).

## Out of scope

- No `--scope write/admin` (server-capped read-only).
- No web changes beyond the local-type swap.
- No change to the `relk_` machine-token lane or the static root key.
- No new server endpoints — Part 2 consumes the existing `/v1/api-keys` surface.

## Gotchas carried from Phase 1–3

- `workers/mcp` zod is pinned to the MCP SDK's nested zod — do not bump it or adopt `agents ≥0.14` while touching shared deps. (Part 1 touches api-types only; no MCP dep change.)
- `releases-cli` `getApiUrl()` memoizes its base URL process-wide — client-mock tests must use `https://test.example.com` or match by path suffix.
- The scope ladder is cumulative actions on one `api` permission resource; self-serve mints `read` only.
