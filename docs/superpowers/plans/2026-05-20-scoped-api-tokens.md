# Scoped API Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opaque, database-backed, scoped API tokens to the API worker — alongside the existing static `RELEASED_API_KEY` (kept as implicit root) — so multiple actors can hold revocable, expiring, least-privilege credentials.

**Architecture:** Pure token primitives (generate/parse/hash/scope-check) live in a new runtime-neutral module `@buildinternet/releases-core/api-token`. A new `api_tokens` D1 table stores a public `lookup_id` plus a `SHA-256` hash of the secret. The API worker's auth middleware gains a DB-token validation path with constant-time, uniform-failure verification and per-route scope enforcement. Admin-gated `/v1/tokens` endpoints manage tokens. The MCP worker is out of scope (Phase 2) but reuses the shared primitives later.

**Tech Stack:** Bun, TypeScript (strict), Hono, Cloudflare D1 + Drizzle ORM, Web Crypto (`crypto.subtle`), nanoid (`customAlphabet`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-20-scoped-api-tokens-design.md` (rides in the same PR as this work).

---

## File Structure

**Create:**

- `packages/core/src/api-token.ts` — pure helpers: scope vocabulary, `scopeSatisfies`, `generateApiToken`, `parseApiToken`, `hashSecret`, `constantTimeEqual`, `DUMMY_TOKEN_HASH`.
- `workers/api/src/middleware/token-store.ts` — worker-side `verifyApiToken` (DB lookup + checks) and `touchLastUsed`.
- `workers/api/src/routes/api-tokens.ts` — admin `/v1/tokens` CRUD router.
- `scripts/mint-token.ts` — operator script to mint a token via the admin endpoint.
- `tests/unit/api-token.test.ts` — pure-helper tests.
- `tests/api/token-store.test.ts` — `verifyApiToken` / `touchLastUsed` DB tests.
- `tests/api/api-tokens-route.test.ts` — management endpoint tests.
- `workers/api/migrations/20260520020000_api_tokens.sql` — table + indexes.

**Modify:**

- `packages/core/src/id.ts` — add `newApiTokenId`.
- `packages/core/package.json` — add `./api-token` export.
- `packages/core/src/schema.ts` — add `apiTokens` table.
- `workers/api/src/middleware/auth.ts` — DB-token path, scope enforcement, `hasValidAuth`, updated `isValidBearerAuth`.
- `workers/api/src/middleware/rate-limit.ts` — bypass via `hasValidAuth`.
- `workers/api/src/index.ts` — add `API_TOKENS_DISABLED` binding + `auth` context variable to `Env`.
- `workers/api/src/route-namespaces.ts` — add `"tokens"` to `adminRoutes`.
- `workers/api/src/v1-routes.ts` — mount `apiTokenRoutes`.
- `tests/api/middleware.test.ts` — add DB-token middleware cases (or a new file; see Task 7).
- `docs/architecture/remote-mode.md`, `AGENTS.md` — document the token system.

---

### Task 1: `tok_` typed ID + scope vocabulary

**Files:**

- Modify: `packages/core/src/id.ts`
- Create: `packages/core/src/api-token.ts`
- Test: `tests/unit/api-token.test.ts`, `tests/unit/id.test.ts`

- [ ] **Step 1: Write failing tests for the scope helpers and id**

Create `tests/unit/api-token.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import {
  API_SCOPES,
  ROOT_SCOPE,
  isApiScope,
  scopeSatisfies,
} from "@buildinternet/releases-core/api-token";
import { newApiTokenId } from "@buildinternet/releases-core/id";

describe("scope vocabulary", () => {
  it("exposes the closed v1 vocabulary", () => {
    expect([...API_SCOPES]).toEqual(["read", "write", "admin"]);
  });

  it("isApiScope accepts known scopes and rejects others", () => {
    expect(isApiScope("read")).toBe(true);
    expect(isApiScope("admin")).toBe(true);
    expect(isApiScope("*")).toBe(false);
    expect(isApiScope("orgs:write")).toBe(false);
  });
});

describe("scopeSatisfies", () => {
  it("wildcard satisfies everything", () => {
    expect(scopeSatisfies([ROOT_SCOPE], "admin")).toBe(true);
    expect(scopeSatisfies([ROOT_SCOPE], "read")).toBe(true);
  });

  it("higher scopes satisfy lower ones (admin ⊇ write ⊇ read)", () => {
    expect(scopeSatisfies(["admin"], "write")).toBe(true);
    expect(scopeSatisfies(["admin"], "read")).toBe(true);
    expect(scopeSatisfies(["write"], "read")).toBe(true);
  });

  it("lower scopes do NOT satisfy higher ones", () => {
    expect(scopeSatisfies(["read"], "write")).toBe(false);
    expect(scopeSatisfies(["write"], "admin")).toBe(false);
  });

  it("unknown scopes grant nothing", () => {
    expect(scopeSatisfies(["orgs:write"], "read")).toBe(false);
    expect(scopeSatisfies([], "read")).toBe(false);
  });
});

describe("newApiTokenId", () => {
  it("has the tok_ prefix", () => {
    expect(newApiTokenId()).toMatch(/^tok_/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/api-token.test.ts`
Expected: FAIL — module `@buildinternet/releases-core/api-token` not found.

- [ ] **Step 3: Add `newApiTokenId` to `packages/core/src/id.ts`**

Add after line 28 (`newLocalEventId`):

```ts
export const newApiTokenId = () => `tok_${nanoid()}`;
```

- [ ] **Step 4: Create `packages/core/src/api-token.ts` with the scope helpers**

```ts
/**
 * Pure, runtime-neutral primitives for opaque scoped API tokens.
 * Token format: `relk_<lookupId>_<secret>` (see api-token design spec).
 * Web Crypto only — safe in Workers, Bun, and Node 18+.
 */

/** Closed scope vocabulary for v1. Stored per-token as a JSON array. */
export const API_SCOPES = ["read", "write", "admin"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Root wildcard — only the static key holds it; never minted on a DB token. */
export const ROOT_SCOPE = "*";

const SCOPE_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export function isApiScope(s: string): s is ApiScope {
  return (API_SCOPES as readonly string[]).includes(s);
}

/**
 * True if a token holding `tokenScopes` satisfies `required`. The wildcard `*`
 * grants everything; otherwise any held scope of equal-or-higher rank satisfies
 * the requirement (admin ⊇ write ⊇ read). Unknown scopes rank 0 (grant nothing)
 * so future namespaced scopes never accidentally satisfy the v1 ladder.
 */
export function scopeSatisfies(tokenScopes: string[], required: ApiScope): boolean {
  if (tokenScopes.includes(ROOT_SCOPE)) return true;
  const reqRank = SCOPE_RANK[required] ?? Number.POSITIVE_INFINITY;
  return tokenScopes.some((s) => (SCOPE_RANK[s] ?? 0) >= reqRank);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/api-token.test.ts tests/unit/id.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/id.ts packages/core/src/api-token.ts tests/unit/api-token.test.ts
git commit -m "feat(core): add api-token scope vocabulary and tok_ id"
```

---

### Task 2: Token generation and parsing (base62)

**Files:**

- Modify: `packages/core/src/api-token.ts`
- Test: `tests/unit/api-token.test.ts`

- [ ] **Step 1: Add failing tests for generate/parse**

Append to `tests/unit/api-token.test.ts`:

```ts
import {
  API_TOKEN_PREFIX,
  generateApiToken,
  parseApiToken,
  isApiTokenShaped,
} from "@buildinternet/releases-core/api-token";

describe("generateApiToken", () => {
  it("produces relk_<12>_<32> with base62 fields", () => {
    const { token, lookupId, secret } = generateApiToken();
    expect(token).toBe(`${API_TOKEN_PREFIX}${lookupId}_${secret}`);
    expect(lookupId).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(secret).toMatch(/^[0-9A-Za-z]{32}$/);
  });

  it("is unique across calls", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe("parseApiToken", () => {
  it("round-trips a generated token", () => {
    const { token, lookupId, secret } = generateApiToken();
    expect(parseApiToken(token)).toEqual({ lookupId, secret });
  });

  it("trims surrounding whitespace", () => {
    const { token, lookupId, secret } = generateApiToken();
    expect(parseApiToken(`  ${token}  `)).toEqual({ lookupId, secret });
  });

  it("returns null for malformed input", () => {
    expect(parseApiToken("")).toBeNull();
    expect(parseApiToken("relk_short_secret")).toBeNull();
    expect(parseApiToken("nope_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeNull();
    expect(parseApiToken("relk_aaaaaaaaaaaa")).toBeNull(); // no secret segment
  });
});

describe("isApiTokenShaped", () => {
  it("matches the prefix without validating content", () => {
    expect(isApiTokenShaped("relk_anything")).toBe(true);
    expect(isApiTokenShaped("some-other-secret")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/api-token.test.ts`
Expected: FAIL — `generateApiToken` etc. not exported.

- [ ] **Step 3: Implement generate/parse in `packages/core/src/api-token.ts`**

Add at the top of the file (after the doc comment):

```ts
import { customAlphabet } from "nanoid";
```

Add below the scope helpers:

```ts
/** Wire prefix for Releases API keys — distinct and secret-scanning friendly. */
export const API_TOKEN_PREFIX = "relk_";

// Base62 excludes `_` and `-` (which nanoid's default alphabet includes), so the
// `_` between lookupId and secret is an unambiguous delimiter.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LOOKUP_LEN = 12; // ~71 bits; non-secret, unique-indexed
const SECRET_LEN = 32; // ~190 bits; CSPRNG

const genLookup = customAlphabet(BASE62, LOOKUP_LEN);
const genSecret = customAlphabet(BASE62, SECRET_LEN);

const TOKEN_RE = new RegExp(
  `^${API_TOKEN_PREFIX}([0-9A-Za-z]{${LOOKUP_LEN}})_([0-9A-Za-z]{${SECRET_LEN}})$`,
);

export interface GeneratedApiToken {
  /** Full token string — show to the caller exactly once. */
  token: string;
  /** Public, non-secret identifier. Stored plaintext, indexed. */
  lookupId: string;
  /** High-entropy secret. Never stored — only its hash. */
  secret: string;
}

export function generateApiToken(): GeneratedApiToken {
  const lookupId = genLookup();
  const secret = genSecret();
  return { token: `${API_TOKEN_PREFIX}${lookupId}_${secret}`, lookupId, secret };
}

export interface ParsedApiToken {
  lookupId: string;
  secret: string;
}

export function parseApiToken(raw: string): ParsedApiToken | null {
  const m = raw.trim().match(TOKEN_RE);
  if (!m) return null;
  return { lookupId: m[1], secret: m[2] };
}

/** Cheap prefix check used to route a credential to the DB-token path. */
export function isApiTokenShaped(raw: string): boolean {
  return raw.startsWith(API_TOKEN_PREFIX);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/api-token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api-token.ts tests/unit/api-token.test.ts
git commit -m "feat(core): add api-token generate/parse (base62 split format)"
```

---

### Task 3: Hashing + constant-time compare

**Files:**

- Modify: `packages/core/src/api-token.ts`
- Test: `tests/unit/api-token.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/api-token.test.ts`:

```ts
import {
  hashSecret,
  constantTimeEqual,
  DUMMY_TOKEN_HASH,
} from "@buildinternet/releases-core/api-token";

describe("hashSecret", () => {
  it("returns a 64-char lowercase hex SHA-256", async () => {
    const h = await hashSecret("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // SHA-256("abc")
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic and differs by input", async () => {
    expect(await hashSecret("x")).toBe(await hashSecret("x"));
    expect(await hashSecret("x")).not.toBe(await hashSecret("y"));
  });
});

describe("constantTimeEqual", () => {
  it("true for equal strings, false otherwise", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeEqual("abc", "abcdef")).toBe(false);
  });

  it("DUMMY_TOKEN_HASH is a 64-char hex string", () => {
    expect(DUMMY_TOKEN_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/api-token.test.ts`
Expected: FAIL — `hashSecret` etc. not exported.

- [ ] **Step 3: Implement hashing helpers in `packages/core/src/api-token.ts`**

Append:

```ts
/** SHA-256 of the secret as lowercase hex. Web Crypto — runtime-neutral. */
export async function hashSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Content-constant-time string comparison. Loops over the longer length and
 * folds a length mismatch into the result so neither timing nor early-return
 * reveals where two strings diverge.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Fixed dummy hash used on the not-found / malformed path so a real miss runs
 * the same comparison work as a wrong-secret on an existing row — no timing or
 * response-shape enumeration oracle.
 */
export const DUMMY_TOKEN_HASH = "0".repeat(64);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/api-token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api-token.ts tests/unit/api-token.test.ts
git commit -m "feat(core): add SHA-256 hashing and constant-time compare for api tokens"
```

---

### Task 4: Export the module from `@buildinternet/releases-core`

**Files:**

- Modify: `packages/core/package.json`

- [ ] **Step 1: Add the export entry**

In `packages/core/package.json`, inside `"exports"`, add after the `"./id"` line:

```json
    "./api-token": "./src/api-token.ts",
```

- [ ] **Step 2: Verify the subpath resolves**

Run: `bun -e 'import("@buildinternet/releases-core/api-token").then(m => console.log(Object.keys(m).sort().join(",")))'`
Expected: prints a list including `API_SCOPES,API_TOKEN_PREFIX,DUMMY_TOKEN_HASH,constantTimeEqual,generateApiToken,hashSecret,isApiScope,isApiTokenShaped,parseApiToken,scopeSatisfies`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json
git commit -m "feat(core): export @buildinternet/releases-core/api-token"
```

---

### Task 5: `api_tokens` schema table + migration

**Files:**

- Modify: `packages/core/src/schema.ts`
- Create: `workers/api/migrations/20260520020000_api_tokens.sql`
- Test: `tests/api/token-store.test.ts` (schema smoke portion)

- [ ] **Step 1: Write a failing schema smoke test**

Create `tests/api/token-store.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

describe("api_tokens schema", () => {
  it("inserts and reads back a token row", () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_test1",
        lookupId: "lookuptest12",
        tokenHash: "a".repeat(64),
        name: "test",
        scopes: JSON.stringify(["read"]),
      })
      .run();
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_test1")).get();
    expect(row?.lookupId).toBe("lookuptest12");
    expect(row?.principalType).toBe("internal"); // default
    expect(row?.active).toBe(true); // default
    expect(JSON.parse(row!.scopes)).toEqual(["read"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/api/token-store.test.ts`
Expected: FAIL — `apiTokens` not exported from schema (and no such table in fixture).

- [ ] **Step 3: Add the `apiTokens` table to `packages/core/src/schema.ts`**

At the end of the file, add (the `text`, `integer`, `index`, `uniqueIndex`, `sqliteTable` imports already exist; `newApiTokenId` must be added to the existing import from `./id`):

```ts
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey().$defaultFn(newApiTokenId),
    // Public, non-secret identifier embedded in the token. Indexed; safe to log.
    lookupId: text("lookup_id").notNull(),
    // SHA-256 hex of the secret. Never the plaintext.
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    // JSON array of scope strings, e.g. ["read","write"].
    scopes: text("scopes").notNull(),
    // Ownership: whom the token acts as. `internal` for systems/scripts.
    principalType: text("principal_type", { enum: ["internal", "agent", "user"] })
      .notNull()
      .default("internal"),
    // Typed id of the owning entity when one exists (user_…, agent id). Null for internal.
    principalId: text("principal_id"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    revokedAt: text("revoked_at"),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // Provenance: who minted it ("static-key", a minting token's id, later a user id).
    createdBy: text("created_by"),
    metadata: text("metadata").default("{}"),
  },
  (table) => [
    uniqueIndex("idx_api_tokens_lookup_id").on(table.lookupId),
    index("idx_api_tokens_principal").on(table.principalType, table.principalId),
  ],
);
```

Confirm `newApiTokenId` is in the `./id` import at the top of `schema.ts` (add it to the existing `import { ... } from "./id.js"` / `"./id"` line — match the file's exact import path/extension).

- [ ] **Step 4: Create the migration `workers/api/migrations/20260520020000_api_tokens.sql`**

```sql
-- Scoped, DB-backed API tokens. Opaque split format: a public lookup_id plus a
-- SHA-256 hash of the secret. See
-- docs/superpowers/specs/2026-05-20-scoped-api-tokens-design.md
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  lookup_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  principal_type TEXT NOT NULL DEFAULT 'internal',
  principal_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  metadata TEXT DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_lookup_id ON api_tokens (lookup_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_principal ON api_tokens (principal_type, principal_id);
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run: `bun test tests/api/token-store.test.ts`
Expected: PASS (the test fixture in `tests/db-helper.ts` applies every `.sql` under `workers/api/migrations/` in sorted order, so the new table is present).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema.ts workers/api/migrations/20260520020000_api_tokens.sql tests/api/token-store.test.ts
git commit -m "feat(db): add api_tokens table and migration"
```

---

### Task 6: Worker-side `verifyApiToken` + `touchLastUsed`

**Files:**

- Create: `workers/api/src/middleware/token-store.ts`
- Test: `tests/api/token-store.test.ts`

- [ ] **Step 1: Add failing tests for verification + last-used**

Append to `tests/api/token-store.test.ts`:

```ts
import { verifyApiToken, touchLastUsed } from "../../workers/api/src/middleware/token-store.js";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

async function seedToken(
  db: TestDatabase["db"],
  overrides: Partial<typeof apiTokens.$inferInsert> = {},
) {
  const { token, lookupId, secret } = generateApiToken();
  const tokenHash = await hashSecret(secret);
  db.insert(apiTokens)
    .values({
      id: overrides.id ?? "tok_seed",
      lookupId,
      tokenHash,
      name: "seed",
      scopes: JSON.stringify(["read"]),
      ...overrides,
    })
    .run();
  return { token, lookupId, secret, tokenHash };
}

describe("verifyApiToken", () => {
  it("accepts a valid token and returns its scopes", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_ok",
      scopes: JSON.stringify(["read", "write"]),
    });
    const res = await verifyApiToken(h.db, token);
    expect(res).toEqual({ ok: true, tokenId: "tok_ok", scopes: ["read", "write"] });
  });

  it("rejects a wrong/unknown token", async () => {
    h = createTestDb();
    await seedToken(h.db, { id: "tok_ws" });
    const other = generateApiToken();
    const res = await verifyApiToken(h.db, other.token); // unknown lookupId
    expect(res.ok).toBe(false);
  });

  it("rejects a malformed token", async () => {
    h = createTestDb();
    const res = await verifyApiToken(h.db, "relk_not_a_real_token");
    expect(res.ok).toBe(false);
  });

  it("rejects a revoked token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, { id: "tok_rev", active: false });
    const res = await verifyApiToken(h.db, token);
    expect(res.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_exp",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await verifyApiToken(h.db, token);
    expect(res.ok).toBe(false);
  });

  it("accepts a not-yet-expired token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_future",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await verifyApiToken(h.db, token);
    expect(res.ok).toBe(true);
  });
});

describe("touchLastUsed", () => {
  it("sets last_used_at when null", async () => {
    h = createTestDb();
    await seedToken(h.db, { id: "tok_touch" });
    await touchLastUsed(h.db, "tok_touch");
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_touch")).get();
    expect(row?.lastUsedAt).toBeTruthy();
  });

  it("does not update again within the 60s throttle window", async () => {
    h = createTestDb();
    await seedToken(h.db, {
      id: "tok_throttle",
      lastUsedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const before = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_throttle")).get();
    await touchLastUsed(h.db, "tok_throttle");
    const after = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_throttle")).get();
    expect(after?.lastUsedAt).toBe(before?.lastUsedAt);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/api/token-store.test.ts`
Expected: FAIL — `token-store.ts` module not found.

- [ ] **Step 3: Implement `workers/api/src/middleware/token-store.ts`**

```ts
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { apiTokens } from "@buildinternet/releases-core/schema";
import {
  constantTimeEqual,
  DUMMY_TOKEN_HASH,
  hashSecret,
  parseApiToken,
} from "@buildinternet/releases-core/api-token";
import type { D1Db } from "../db.js";

export type TokenVerifyResult = { ok: true; tokenId: string; scopes: string[] } | { ok: false };

/** How long after a successful auth before we rewrite last_used_at again. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Validate a presented `relk_…` token against the DB. Runs a constant-time hash
 * comparison on every path (including not-found / malformed) so timing and the
 * returned shape are uniform — no enumeration oracle. Returns scopes on success.
 */
export async function verifyApiToken(
  db: D1Db,
  raw: string,
  now: Date = new Date(),
): Promise<TokenVerifyResult> {
  const parsed = parseApiToken(raw);
  // Always hash so timing doesn't branch on parse success.
  const presentedHash = await hashSecret(parsed?.secret ?? "");

  if (!parsed) {
    constantTimeEqual(presentedHash, DUMMY_TOKEN_HASH);
    return { ok: false };
  }

  const row = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.lookupId, parsed.lookupId))
    .get();

  if (!row) {
    constantTimeEqual(presentedHash, DUMMY_TOKEN_HASH);
    return { ok: false };
  }

  if (!constantTimeEqual(presentedHash, row.tokenHash)) return { ok: false };
  if (!row.active) return { ok: false };
  if (row.expiresAt && row.expiresAt <= now.toISOString()) return { ok: false };

  let scopes: string[] = [];
  try {
    const parsedScopes = JSON.parse(row.scopes);
    if (Array.isArray(parsedScopes)) {
      scopes = parsedScopes.filter((s): s is string => typeof s === "string");
    }
  } catch {
    scopes = [];
  }
  return { ok: true, tokenId: row.id, scopes };
}

/**
 * Record last-used, throttled: only rewrites if the previous value is null or
 * older than the throttle window. Single conditional UPDATE — safe to call
 * fire-and-forget via waitUntil on the hot path.
 */
export async function touchLastUsed(
  db: D1Db,
  tokenId: string,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - LAST_USED_THROTTLE_MS).toISOString();
  await db
    .update(apiTokens)
    .set({ lastUsedAt: now.toISOString() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, cutoff)),
      ),
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/api/token-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/middleware/token-store.ts tests/api/token-store.test.ts
git commit -m "feat(api): add verifyApiToken + touchLastUsed token store"
```

---

### Task 7: Auth middleware DB-token path + scope enforcement

**Files:**

- Modify: `workers/api/src/middleware/auth.ts`
- Modify: `workers/api/src/index.ts` (Env: add `API_TOKENS_DISABLED` + `auth` variable)
- Test: `tests/api/auth-tokens.test.ts` (new)

- [ ] **Step 1: Add `API_TOKENS_DISABLED` and `auth` variable to `Env` in `workers/api/src/index.ts`**

In the `Bindings` object of `export type Env` (around line 42), add:

```ts
    API_TOKENS_DISABLED?: string;
```

Add a `Variables` member to `Env` (alongside `Bindings`). If `Env` has no `Variables` key yet, add it; import the type at the top of the file:

```ts
import type { AuthContext } from "./middleware/auth.js";
```

and in the `Env` type:

```ts
  Variables: {
    auth?: AuthContext;
  };
```

(If `Variables` already exists, add the `auth?: AuthContext;` field to it instead of duplicating the key.)

- [ ] **Step 2: Write failing middleware tests**

Create `tests/api/auth-tokens.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

const { authMiddleware, publicReadAuthMiddleware } =
  (await import("../../workers/api/src/middleware/auth.js")) as unknown as {
    authMiddleware: MiddlewareHandler;
    publicReadAuthMiddleware: MiddlewareHandler;
  };

function mockSecret(value: string) {
  return { get: () => Promise.resolve(value) };
}

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

async function seed(db: TestDatabase["db"], scopes: string[], extra: Record<string, unknown> = {}) {
  const { token, lookupId, secret } = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: (extra.id as string) ?? `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "t",
      scopes: JSON.stringify(scopes),
      ...extra,
    })
    .run();
  return token;
}

describe("authMiddleware with DB tokens (requires admin)", () => {
  function call(db: TestDatabase["db"]) {
    const a = new Hono();
    a.use("*", authMiddleware);
    a.get("/admin-thing", (c) => c.json({ ok: true }));
    return (token: string) =>
      a.request(
        "/admin-thing",
        { headers: { Authorization: `Bearer ${token}` } },
        { DB: db, RELEASED_API_KEY: mockSecret("root-secret") },
      );
  }

  it("admin-scoped token passes", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["admin"]);
    expect((await call(h.db)(token)).status).toBe(200);
  });

  it("read-only token gets 403 insufficient_scope", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    const res = await call(h.db)(token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("revoked token gets 401", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["admin"], { id: "tok_rev", active: false });
    expect((await call(h.db)(token)).status).toBe(401);
  });

  it("static root key still passes", async () => {
    h = createTestDb();
    expect((await call(h.db)("root-secret")).status).toBe(200);
  });

  it("unknown token is 401 (same as wrong secret)", async () => {
    h = createTestDb();
    expect((await call(h.db)(generateApiToken().token)).status).toBe(401);
  });
});

describe("publicReadAuthMiddleware with DB tokens (write needs `write`)", () => {
  function makeApp(db: TestDatabase["db"]) {
    const a = new Hono();
    a.use("*", publicReadAuthMiddleware);
    a.get("/thing", (c) => c.json({ ok: true }));
    a.post("/thing", (c) => c.json({ ok: true }));
    return a;
  }
  const env = (db: TestDatabase["db"]) => ({ DB: db, RELEASED_API_KEY: mockSecret("root-secret") });

  it("GET passes with no token", async () => {
    h = createTestDb();
    const res = await makeApp(h.db).request("/thing", {}, env(h.db));
    expect(res.status).toBe(200);
  });

  it("POST with write-scoped token passes", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["write"]);
    const res = await makeApp(h.db).request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      env(h.db),
    );
    expect(res.status).toBe(200);
  });

  it("POST with read-only token gets 403", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    const res = await makeApp(h.db).request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      env(h.db),
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/api/auth-tokens.test.ts`
Expected: FAIL — middleware doesn't yet validate DB tokens / enforce scope.

- [ ] **Step 4: Rewrite `workers/api/src/middleware/auth.ts`**

Replace the file contents with:

```ts
import type { Context, MiddlewareHandler } from "hono";
import { getSecret } from "@releases/lib/secrets";
import {
  type ApiScope,
  isApiTokenShaped,
  ROOT_SCOPE,
  scopeSatisfies,
} from "@buildinternet/releases-core/api-token";
import { createDb } from "../db.js";
import { touchLastUsed, verifyApiToken } from "./token-store.js";
import type { Env } from "../index.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Custom header carrying the trusted-proxy shared secret. */
export const PROXY_KEY_HEADER = "X-Releases-Proxy-Key";

/** Resolved identity attached to the Hono context for downstream handlers. */
export interface AuthContext {
  kind: "root" | "token";
  tokenId?: string;
  scopes: string[];
}

type ResolvedAuth =
  | { kind: "root"; scopes: string[] }
  | { kind: "token"; tokenId: string; scopes: string[] }
  // skip=true means "local dev, no secret configured" — preserve open access.
  | { kind: "none"; skip: boolean };

function bearer(c: Context<Env>): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Resolve a presented credential to an identity. `relk_…` tokens go to the DB
 * path only; everything else compares to the static RELEASED_API_KEY (root).
 * No credential is eligible for both paths.
 */
async function resolveAuth(c: Context<Env>, presented: string): Promise<ResolvedAuth> {
  if (isApiTokenShaped(presented)) {
    if (c.env.API_TOKENS_DISABLED === "true") return { kind: "none", skip: false };
    const result = await verifyApiToken(createDb(c.env.DB), presented);
    if (result.ok) return { kind: "token", tokenId: result.tokenId, scopes: result.scopes };
    return { kind: "none", skip: false };
  }

  const secret = await getSecret(c.env.RELEASED_API_KEY);
  if (!secret) return { kind: "none", skip: true }; // local dev — no secret configured
  if (presented && presented === secret) return { kind: "root", scopes: [ROOT_SCOPE] };
  return { kind: "none", skip: false };
}

/**
 * True iff the request carries ANY valid identity — the static root key or an
 * active DB token of any scope. Used by the rate limiter to exempt known
 * callers. Does NOT imply admin-level access.
 */
export async function hasValidAuth(c: Context<Env>): Promise<boolean> {
  const presented = bearer(c);
  if (!presented) return false;
  const auth = await resolveAuth(c, presented);
  return auth.kind === "root" || auth.kind === "token";
}

/**
 * True iff the request carries ADMIN-level auth — the static root key or a DB
 * token whose scopes satisfy `admin`. Gates writes elsewhere and unlocks
 * internal fields (e.g. org playbook) on public-read routes. A read/write-only
 * token returns false here so it can't escalate to admin-only content.
 */
export async function isValidBearerAuth(c: Context<Env>): Promise<boolean> {
  const presented = bearer(c);
  if (!presented) return false;
  const auth = await resolveAuth(c, presented);
  if (auth.kind === "root") return true;
  if (auth.kind === "token") return scopeSatisfies(auth.scopes, "admin");
  return false;
}

/**
 * True iff the request carries an `X-Releases-Proxy-Key` header matching the
 * configured `RELEASES_PROXY_KEY`. Server-trust signal only — exempts the web
 * frontend's server-to-server traffic from the per-IP rate limit. Does NOT
 * unlock admin-gated content.
 */
export async function isTrustedProxy(c: Context<Env>): Promise<boolean> {
  const header = c.req.header(PROXY_KEY_HEADER);
  if (!header) return false;
  const secret = await getSecret(c.env.RELEASES_PROXY_KEY);
  if (!secret) return false;
  return header === secret;
}

/** Requires `admin` scope (or root) for all requests. 401 if no identity, 403 if under-scoped. */
export const authMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: false,
  requiredScope: "admin",
});

/**
 * GET/HEAD/OPTIONS pass without auth. POST/PATCH/DELETE require `write` scope
 * (or higher / root).
 */
export const publicReadAuthMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: true,
  requiredScope: "write",
});

function createAuthMiddleware(opts: {
  allowPublicReads: boolean;
  requiredScope: ApiScope;
}): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (opts.allowPublicReads && SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const auth = await resolveAuth(c, bearer(c));

    if (auth.kind === "none") {
      if (auth.skip) {
        await next();
        return;
      }
      // RFC 7235: 401 carries a WWW-Authenticate challenge so clients (incl.
      // AI agents) can discover the scheme without docs.
      c.header("WWW-Authenticate", 'Bearer realm="releases-api"');
      return c.json({ error: "unauthorized", message: "Invalid or missing API key" }, 401);
    }

    if (!scopeSatisfies(auth.scopes, opts.requiredScope)) {
      return c.json(
        { error: "insufficient_scope", message: `Requires '${opts.requiredScope}' scope` },
        403,
      );
    }

    c.set("auth", {
      kind: auth.kind,
      tokenId: auth.kind === "token" ? auth.tokenId : undefined,
      scopes: auth.scopes,
    });

    if (auth.kind === "token") {
      const tokenId = auth.tokenId;
      c.executionCtx?.waitUntil(touchLastUsed(createDb(c.env.DB), tokenId).catch(() => undefined));
    }

    await next();
  };
}
```

- [ ] **Step 5: Run the new auth tests + the existing middleware tests**

Run: `bun test tests/api/auth-tokens.test.ts tests/api/middleware.test.ts`
Expected: PASS. (The existing static-key tests in `middleware.test.ts` still pass: a non-`relk_` token compares to the static secret exactly as before. Those tests don't pass a `DB` binding, but a non-`relk_` credential never reaches the DB path, so that's fine.)

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/auth.ts workers/api/src/index.ts tests/api/auth-tokens.test.ts
git commit -m "feat(api): validate DB-backed scoped tokens in auth middleware"
```

---

### Task 8: Rate-limit bypass uses `hasValidAuth`

**Files:**

- Modify: `workers/api/src/middleware/rate-limit.ts`
- Test: `tests/api/rate-limit.test.ts`

- [ ] **Step 1: Confirm the call sites of `isValidBearerAuth`**

Run: `grep -rn "isValidBearerAuth" workers/api/src`
Expected: appears in `rate-limit.ts` and any field-unlock site (e.g. a GraphQL resolver). The field-unlock sites must KEEP `isValidBearerAuth` (admin-level). Only `rate-limit.ts` changes to the broader `hasValidAuth`. If `grep` shows additional admin-gate callers, leave them on `isValidBearerAuth` — its admin-level meaning is preserved by Task 7.

- [ ] **Step 2: Add a failing test for read-only token bypass**

Open `tests/api/rate-limit.test.ts` and mirror its existing harness (it already builds the limiter middleware and a mock `PUBLIC_RATE_LIMITER` whose `.limit` is a spy). Add a case: seed a `["read"]` token exactly as `seed(...)` does in `tests/api/auth-tokens.test.ts` (import `createTestDb`, `apiTokens`, `generateApiToken`, `hashSecret`), present it as a Bearer header on a GET, pass `{ DB: db, PUBLIC_RATE_LIMITER: <spy binding>, RATE_LIMIT_ENABLED: "true" }` in the env, and assert:

```ts
// the limiter binding is never consulted for an authenticated caller …
expect(limitSpy).not.toHaveBeenCalled();
// … and the request is allowed through.
expect(res.status).toBe(200);
```

Use the exact spy/env construction already present in the file for the existing "valid Bearer bypasses" test — copy that test and swap the static key for the seeded read-only token.

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: FAIL — a read-only token currently does not bypass (old `isValidBearerAuth` was admin-only / static-key-only).

- [ ] **Step 4: Point the limiter at `hasValidAuth`**

In `workers/api/src/middleware/rate-limit.ts`, change the import to include `hasValidAuth` and replace the bypass check:

```ts
import { hasValidAuth, isTrustedProxy } from "./auth.js";
```

Replace the existing `if (await isValidBearerAuth(c)) { … skip … }` branch with:

```ts
// Authenticated callers (static root key or any active DB token) bypass.
if (await hasValidAuth(c)) {
  await next();
  return;
}
```

Leave the `isTrustedProxy` branch unchanged. Remove the now-unused `isValidBearerAuth` import from this file if it is no longer referenced here.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/rate-limit.ts tests/api/rate-limit.test.ts
git commit -m "feat(api): rate-limit bypass for any valid token via hasValidAuth"
```

---

### Task 9: Management endpoints `/v1/tokens`

**Files:**

- Create: `workers/api/src/routes/api-tokens.ts`
- Modify: `workers/api/src/v1-routes.ts`
- Modify: `workers/api/src/route-namespaces.ts`
- Test: `tests/api/api-tokens-route.test.ts`

- [ ] **Step 1: Write failing endpoint tests**

Create `tests/api/api-tokens-route.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokenRoutes } from "../../workers/api/src/routes/api-tokens.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { parseApiToken, hashSecret } from "@buildinternet/releases-core/api-token";
import { eq } from "drizzle-orm";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

function call(db: TestDatabase["db"]) {
  const a = new Hono();
  // Simulate the admin middleware having attached a root identity.
  a.use("*", async (c, next) => {
    c.set("auth", { kind: "root", scopes: ["*"] });
    await next();
  });
  a.route("/", apiTokenRoutes);
  return (path: string, init?: RequestInit) => a.request(path, init, { DB: db });
}

describe("POST /v1/tokens", () => {
  it("mints a token, returns it once, stores only the hash", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "CI", scopes: ["write"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; id: string; scopes: string[] };
    expect(body.token).toMatch(/^relk_/);
    expect(body.scopes).toEqual(["write"]);

    const parsed = parseApiToken(body.token)!;
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, body.id)).get();
    expect(row?.tokenHash).toBe(await hashSecret(parsed.secret));
    expect(row?.principalType).toBe("internal");
    // The stored row never contains the plaintext secret.
    expect(JSON.stringify(row)).not.toContain(parsed.secret);
  });

  it("rejects missing scopes", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects the wildcard scope", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: ["*"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/tokens", () => {
  it("lists tokens without secret or hash", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_l",
        lookupId: "lookuplist01",
        tokenHash: "a".repeat(64),
        name: "n",
        scopes: '["read"]',
      })
      .run();
    const res = await call(h.db)("/tokens");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("a".repeat(64)); // no hash leak
    const body = JSON.parse(text) as { tokens: Array<{ id: string }> };
    expect(body.tokens.map((t) => t.id)).toContain("tok_l");
  });
});

describe("POST /v1/tokens/:id/revoke", () => {
  it("flips active to false and sets revoked_at", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_r",
        lookupId: "lookuprevoke",
        tokenHash: "a".repeat(64),
        name: "n",
        scopes: '["read"]',
      })
      .run();
    const res = await call(h.db)("/tokens/tok_r/revoke", { method: "POST" });
    expect(res.status).toBe(200);
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_r")).get();
    expect(row?.active).toBe(false);
    expect(row?.revokedAt).toBeTruthy();
  });

  it("404 for unknown id", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens/tok_missing/revoke", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/tokens/:id", () => {
  it("edits scopes", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_p",
        lookupId: "lookuppatch1",
        tokenHash: "a".repeat(64),
        name: "n",
        scopes: '["read"]',
      })
      .run();
    const res = await call(h.db)("/tokens/tok_p", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read", "write"] }),
    });
    expect(res.status).toBe(200);
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_p")).get();
    expect(JSON.parse(row!.scopes)).toEqual(["read", "write"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/api/api-tokens-route.test.ts`
Expected: FAIL — `api-tokens.ts` route module not found.

- [ ] **Step 3: Implement `workers/api/src/routes/api-tokens.ts`**

```ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import {
  API_SCOPES,
  generateApiToken,
  hashSecret,
  isApiScope,
} from "@buildinternet/releases-core/api-token";
import { newApiTokenId } from "@buildinternet/releases-core/id";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";

export const apiTokenRoutes = new Hono<Env>();

const PRINCIPAL_TYPES = ["internal", "agent", "user"] as const;

/** Public projection — never exposes token_hash or the secret. */
function toPublicRow(row: typeof apiTokens.$inferSelect) {
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    scopes = [];
  }
  return {
    id: row.id,
    lookupId: row.lookupId,
    name: row.name,
    scopes,
    principalType: row.principalType,
    principalId: row.principalId,
    active: row.active,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

apiTokenRoutes.post("/tokens", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "bad_request", message: "name is required" }, 400);

  const scopes = Array.isArray(body.scopes) ? (body.scopes as unknown[]) : null;
  if (!scopes || scopes.length === 0) {
    return c.json({ error: "bad_request", message: "scopes is required and non-empty" }, 400);
  }
  if (!scopes.every((s): s is string => typeof s === "string" && isApiScope(s))) {
    return c.json(
      { error: "bad_request", message: `scopes must be a subset of: ${API_SCOPES.join(", ")}` },
      400,
    );
  }

  const principalType = typeof body.principalType === "string" ? body.principalType : "internal";
  if (!(PRINCIPAL_TYPES as readonly string[]).includes(principalType)) {
    return c.json({ error: "bad_request", message: "invalid principalType" }, 400);
  }
  const principalId = typeof body.principalId === "string" ? body.principalId : null;

  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return c.json({ error: "bad_request", message: "expiresAt must be ISO-8601" }, 400);
  }

  const { token, lookupId, secret } = generateApiToken();
  const tokenHash = await hashSecret(secret);
  const id = newApiTokenId();
  const auth = c.get("auth");
  const createdBy = auth?.kind === "token" ? (auth.tokenId ?? "token") : "static-key";

  const db = createDb(c.env.DB);
  await db.insert(apiTokens).values({
    id,
    lookupId,
    tokenHash,
    name,
    scopes: JSON.stringify(scopes),
    principalType: principalType as (typeof PRINCIPAL_TYPES)[number],
    principalId,
    expiresAt,
    createdBy,
  });

  logEvent("info", {
    component: "api-tokens",
    event: "minted",
    tokenId: id,
    scopes,
    principalType,
  });

  const row = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  // The full token is returned exactly once and is never retrievable again.
  return c.json({ token, ...toPublicRow(row!) }, 201);
});

apiTokenRoutes.get("/tokens", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(apiTokens).all();
  return c.json({ tokens: rows.map(toPublicRow) });
});

apiTokenRoutes.get("/tokens/:id", async (c) => {
  const db = createDb(c.env.DB);
  const row = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, c.req.param("id")))
    .get();
  if (!row) return c.json({ error: "not_found", message: "token not found" }, 404);
  return c.json(toPublicRow(row));
});

apiTokenRoutes.patch("/tokens/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  if (!existing) return c.json({ error: "not_found", message: "token not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }

  const patch: Partial<typeof apiTokens.$inferInsert> = {};
  if (typeof body.name === "string") {
    if (!body.name.trim())
      return c.json({ error: "bad_request", message: "name cannot be empty" }, 400);
    patch.name = body.name.trim();
  }
  if (Array.isArray(body.scopes)) {
    const scopes = body.scopes as unknown[];
    if (
      scopes.length === 0 ||
      !scopes.every((s): s is string => typeof s === "string" && isApiScope(s))
    ) {
      return c.json(
        {
          error: "bad_request",
          message: `scopes must be a non-empty subset of: ${API_SCOPES.join(", ")}`,
        },
        400,
      );
    }
    patch.scopes = JSON.stringify(scopes);
  }
  if (body.expiresAt === null) {
    patch.expiresAt = null;
  } else if (typeof body.expiresAt === "string") {
    if (Number.isNaN(Date.parse(body.expiresAt))) {
      return c.json({ error: "bad_request", message: "expiresAt must be ISO-8601" }, 400);
    }
    patch.expiresAt = body.expiresAt;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "bad_request", message: "no editable fields provided" }, 400);
  }

  await db.update(apiTokens).set(patch).where(eq(apiTokens.id, id));
  const updated = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  return c.json(toPublicRow(updated!));
});

apiTokenRoutes.post("/tokens/:id/revoke", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const row = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  if (!row) return c.json({ error: "not_found", message: "token not found" }, 404);
  await db
    .update(apiTokens)
    .set({ active: false, revokedAt: new Date().toISOString() })
    .where(eq(apiTokens.id, id));
  logEvent("info", { component: "api-tokens", event: "revoked", tokenId: id });
  const updated = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  return c.json(toPublicRow(updated!));
});
```

- [ ] **Step 4: Mount the router in `workers/api/src/v1-routes.ts`**

Add the import near the other route imports:

```ts
import { apiTokenRoutes } from "./routes/api-tokens.js";
```

Add the mount alongside the other `v1.route("/", …)` calls:

```ts
v1.route("/", apiTokenRoutes);
```

- [ ] **Step 5: Gate the namespace in `workers/api/src/route-namespaces.ts`**

Add `"tokens"` to the `adminRoutes` array (so `authMiddleware` — `admin` scope — gates every method):

```ts
  "tokens",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/api/api-tokens-route.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/routes/api-tokens.ts workers/api/src/v1-routes.ts workers/api/src/route-namespaces.ts tests/api/api-tokens-route.test.ts
git commit -m "feat(api): add admin /v1/tokens management endpoints"
```

---

### Task 10: Operator mint script

**Files:**

- Create: `scripts/mint-token.ts`

- [ ] **Step 1: Implement the script**

```ts
#!/usr/bin/env bun
/**
 * Mint a scoped API token via POST /v1/tokens using the static root key.
 * Requires RELEASED_API_URL and RELEASED_API_KEY in the environment (.env auto-loads).
 *
 * Usage:
 *   bun scripts/mint-token.ts --name "CI deploy" --scopes write
 *   bun scripts/mint-token.ts --name "reader" --scopes read --principal-type agent
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const apiUrl = process.env.RELEASED_API_URL;
const apiKey = process.env.RELEASED_API_KEY;
if (!apiUrl || !apiKey) {
  console.error("Set RELEASED_API_URL and RELEASED_API_KEY (the static root key) first.");
  process.exit(1);
}

const name = arg("--name");
const scopes = (arg("--scopes") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const principalType = arg("--principal-type") ?? "internal";
if (!name || scopes.length === 0) {
  console.error('Required: --name "<label>" --scopes <read|write|admin[,...]>');
  process.exit(1);
}

const res = await fetch(`${apiUrl}/v1/tokens`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ name, scopes, principalType }),
});

if (!res.ok) {
  console.error(`Mint failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const body = (await res.json()) as { token: string; id: string; scopes: string[] };
console.log("Token minted. This is the ONLY time the full token is shown:\n");
console.log(`  ${body.token}\n`);
console.log(`id: ${body.id}  scopes: ${body.scopes.join(", ")}`);
```

- [ ] **Step 2: Verify it parses and shows usage**

Run: `bun scripts/mint-token.ts` (no args)
Expected: prints the "Set RELEASED_API_URL…" or required-args error and exits non-zero (no network call). This confirms the script parses and runs.

- [ ] **Step 3: Commit**

```bash
git add scripts/mint-token.ts
git commit -m "feat(scripts): add mint-token operator script"
```

---

### Task 11: Documentation + full verification

**Files:**

- Modify: `docs/architecture/remote-mode.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `docs/architecture/remote-mode.md` auth section**

Add a subsection after the existing "Auth model" paragraph:

```markdown
### Scoped API tokens

Alongside the single static `RELEASED_API_KEY` (now treated as implicit **root** —
all scopes, break-glass), the API worker accepts **DB-backed scoped tokens** in
the `Authorization: Bearer relk_<lookupId>_<secret>` form. Each token (`api_tokens`
table) carries a JSON set of scopes (`read` ⊂ `write` ⊂ `admin`), can be revoked
(`active=0`) or expired (`expires_at`), records `last_used_at`, and is attributed
to a principal (`principal_type`: `internal | agent | user`, plus optional
`principal_id`). Only the `SHA-256` hash of the secret is stored; the public
`lookup_id` is the indexed handle. Validation lives in
`workers/api/src/middleware/token-store.ts` (constant-time, uniform-failure) and
`middleware/auth.ts` (scope enforcement: writes need `write`, admin routes need
`admin`). Manage via admin-gated `/v1/tokens` (mint/list/revoke/patch); mint with
`scripts/mint-token.ts`. Kill switch: `API_TOKENS_DISABLED=true` falls back to the
static key only. See `docs/superpowers/specs/2026-05-20-scoped-api-tokens-design.md`.
```

- [ ] **Step 2: Add a conventions bullet to `AGENTS.md`**

Under the `## Conventions` list, add:

```markdown
- Scoped API tokens (`api_tokens` table): opaque `relk_<lookupId>_<secret>` Bearer tokens, stored as a `lookup_id` (public, indexed) + `SHA-256(secret)` hash. Scope ladder `read ⊂ write ⊂ admin`; static `RELEASED_API_KEY` is implicit root (`*`). Pure helpers in `@buildinternet/releases-core/api-token`; worker validation in `workers/api/src/middleware/{token-store,auth}.ts`; admin CRUD at `/v1/tokens`. Kill switch `API_TOKENS_DISABLED`. MCP enforcement is Phase 2.
```

- [ ] **Step 3: Run the full verification suite**

Run each and confirm clean output:

```bash
bun test
bun run lint
bun run format:check
npx tsc --noEmit
( cd workers/api && npx tsc --noEmit )
```

Expected: all pass. If `format:check` flags the new files, run `bun run format` and re-stage.

- [ ] **Step 4: Apply the migration to staging and smoke-test**

```bash
bunx wrangler d1 migrations apply DB --env staging --remote --config workers/api/wrangler.jsonc
```

Then mint + use a token against staging (staging requires the access-key header; the static root key is the staging `RELEASED_API_KEY`). Confirm a `read` token gets 403 on an admin route and 200 on a public GET.

- [ ] **Step 5: Commit docs**

```bash
git add docs/architecture/remote-mode.md AGENTS.md
git commit -m "docs: document scoped API tokens"
```

---

## Self-Review

**Spec coverage:**

- §1 data model → Task 5 (timestamps as ISO text per schema convention). ✅
- §2 token format → Task 2. ✅
- §3 scope model → Task 1. ✅
- §4 validation flow (uniform failure, constant-time, no cache, last-used throttle, shared pure module) → Tasks 3, 6, 7. ✅
- §5 middleware integration (`resolveAuth`, `isValidBearerAuth` admin-level, `isTrustedProxy`, local-dev skip) → Task 7; rate-limit bypass → Task 8. ✅
- §6 management surface (`POST/GET/GET:id/PATCH/revoke`, scopes required, `*` rejected, `created_by`, kill switch, adminRoutes, mint script) → Tasks 9, 10. ✅
- §7 testing (pure, middleware, endpoint, security: no-hash-leak, uniform 401) → Tasks 1–3, 6, 7, 9. ✅
- §8 out-of-scope boundaries → respected (no MCP/JWT/pepper/cache/self-service work). ✅

**Notable correctness decision (beyond the spec):** `isValidBearerAuth` is kept **admin-level** (root or `admin`-scoped token) because existing callers use it to unlock internal fields; a separate `hasValidAuth` (any valid token) drives the rate-limit bypass. This prevents a read-only token from escalating to admin-only content while still honoring spec caveat #8 (any valid token bypasses rate limiting). Task 8 Step 1 verifies no other call site needs the broad predicate.

**Placeholder scan:** Task 8 Step 2 references the existing `rate-limit.ts` harness rather than reprinting it — that file already contains a mock `PUBLIC_RATE_LIMITER` with `.limit` assertions; the seed helper to copy is shown verbatim in `tests/api/auth-tokens.test.ts`. All other steps contain complete code.

**Type consistency:** `verifyApiToken` returns `{ ok: true; tokenId; scopes } | { ok: false }` (Task 6) and is consumed accordingly in Task 7. `AuthContext` is defined in `auth.ts` (Task 7 Step 4) and referenced by `Env.Variables` (Task 7 Step 1). `apiTokens` columns (Task 5) match every `.values()` / `.set()` usage in Tasks 6, 9. `scopeSatisfies(string[], ApiScope)`, `generateApiToken()`, `hashSecret()`, `parseApiToken()`, `isApiScope()`, `isApiTokenShaped()`, `newApiTokenId()` signatures are consistent across all tasks.
