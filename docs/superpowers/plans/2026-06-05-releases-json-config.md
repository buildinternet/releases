# releases.json (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an org/repo owner self-declare listing metadata via a `$schema`-validated `releases.json`, hosted on their domain (`.well-known/releases.json` → org identity) or in a repo root (`releases.json` → that source's product mapping), reconciled onto existing columns without ever clobbering curator/editorial fields.

**Architecture:** A new zod schema in `api-types` is the source of truth; the public JSON Schema is generated from it with zod 4's native `z.toJSONSchema()`. A fail-closed fetch helper pulls the file; pure diff functions compute field updates under a self-declared/curator precedence rule; thin apply functions write through existing helpers (`resolveCategoryInput`, `setNoticeInMetadata`, `getOrCreateTagsD1`, `ingestOrgAvatar`, product find-or-create). An on-demand route (`POST /v1/orgs/:slug/sync-well-known`, with `?dryRun`) and a flag-gated daily two-pass cron drive it.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Worker + Hono, Drizzle/D1, zod 4.4.3, Cloudflare Flagship flags, R2.

**Spec:** `docs/superpowers/specs/2026-06-05-releases-json-design.md`

---

## File structure

| File                                                          | Responsibility                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/api-types/src/schemas/well-known.ts` (create)       | `ReleasesJsonConfigSchema` zod + `ReleasesJsonConfig` type                                     |
| `packages/api-types/src/api-types.ts` (modify)                | Re-export the new schema + type                                                                |
| `packages/api-types/src/schemas/well-known.test.ts` (create)  | zod accept/reject tests                                                                        |
| `scripts/gen-releases-json-schema.ts` (create)                | Generate JSON Schema → `web/public/schemas/releases.json`                                      |
| `web/public/schemas/releases.json` (create, generated)        | Public `$schema` document                                                                      |
| `package.json` (modify)                                       | `gen:releases-schema` script                                                                   |
| `workers/api/src/lib/well-known/self-declared.ts` (create)    | Pure parse/set of `metadata.selfDeclared`                                                      |
| `workers/api/src/lib/well-known/fetch.ts` (create)            | `fetchReleasesJson` fail-closed fetch                                                          |
| `workers/api/src/lib/well-known/reconcile-org.ts` (create)    | Pure `computeOrgIdentityUpdates` + `applyOrgReconciliation` + `syncOrgWellKnown`               |
| `workers/api/src/lib/well-known/reconcile-source.ts` (create) | `parseGitHubRepo` + pure `computeProductPlan` + `applySourceReconciliation` + `syncSourceRepo` |
| `workers/api/src/lib/well-known/*.test.ts` (create)           | Unit + integration tests for each module                                                       |
| `workers/api/src/routes/orgs.ts` (modify)                     | `POST /orgs/:slug/sync-well-known` route                                                       |
| `workers/api/test/orgs-sync-well-known.test.ts` (create)      | Route test                                                                                     |
| `packages/lib/src/flags.ts` (modify)                          | `wellKnownSyncEnabled` flag (default **true**)                                                 |
| `workers/api/src/cron/well-known-sync.ts` (create)            | Two-pass sweep entrypoint                                                                      |
| `workers/api/src/cron/well-known-sync.test.ts` (create)       | Cron test                                                                                      |
| `workers/api/src/index.ts` (modify)                           | Dispatch the new cron + `WELL_KNOWN_SYNC_ENABLED` env field                                    |
| `workers/api/wrangler.jsonc` (modify)                         | New `0 6 * * *` cron trigger                                                                   |
| `docs/architecture/well-known-config.md` (create)             | Architecture doc + examples                                                                    |
| `AGENTS.md` (modify)                                          | One-line conventions entry                                                                     |

Conventions for any new worker code: log via `logEvent` from `@releases/lib/log-event`; D1 handle via `createDb(env.DB)`; gates fail closed.

---

### Task 1: api-types `ReleasesJsonConfigSchema`

**Files:**

- Create: `packages/api-types/src/schemas/well-known.ts`
- Modify: `packages/api-types/src/api-types.ts`
- Test: `packages/api-types/src/schemas/well-known.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api-types/src/schemas/well-known.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { ReleasesJsonConfigSchema } from "./well-known.js";

describe("ReleasesJsonConfigSchema", () => {
  it("accepts an empty object (no-op file)", () => {
    expect(ReleasesJsonConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a full org-scope file", () => {
    const r = ReleasesJsonConfigSchema.safeParse({
      $schema: "https://releases.sh/schemas/releases.json",
      name: "Acme",
      description: "CI for teams.",
      category: "developer-tools",
      avatar: "https://acme.com/logo.png",
      tags: ["ci", "observability"],
      social: { twitter: "acmehq", github: "acme" },
      notice: { message: "Docs moved", href: "https://acme.com/docs" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a product-scope file", () => {
    const r = ReleasesJsonConfigSchema.safeParse({
      product: { name: "Acme Cloud", slug: "acme-cloud", category: "cloud", kind: "saas" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-https avatar", () => {
    expect(ReleasesJsonConfigSchema.safeParse({ avatar: "http://acme.com/x.png" }).success).toBe(
      false,
    );
  });

  it("rejects a product with no name", () => {
    expect(ReleasesJsonConfigSchema.safeParse({ product: { slug: "x" } }).success).toBe(false);
  });

  it("rejects an over-long notice message", () => {
    const r = ReleasesJsonConfigSchema.safeParse({ notice: { message: "x".repeat(281) } });
    expect(r.success).toBe(false);
  });

  it("strips unknown top-level keys", () => {
    const r = ReleasesJsonConfigSchema.parse({ name: "Acme", bogus: 1 });
    expect("bogus" in r).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/api-types/src/schemas/well-known.test.ts`
Expected: FAIL — `Cannot find module './well-known.js'`.

- [ ] **Step 3: Create the schema**

Create `packages/api-types/src/schemas/well-known.ts`:

```ts
import { z } from "zod";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { NoticeSchema } from "./shared.js";

/** A single social handle/URL. Bare handles allowed; URLs must be https. */
const SocialValueSchema = z.string().min(1).max(200);

/** Product-scope block: declares the hosting repo's source belongs to this product. */
export const ReleasesJsonProductSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    // Accepted leniently as a string; resolved/validated against CATEGORIES at apply time.
    category: z.string().min(1).max(120).optional(),
    kind: z.string().min(1).max(60).optional(),
  })
  .strict();

/**
 * One file name, two hosting scopes. Org-identity keys are honored only from a
 * domain `.well-known/releases.json`; `product` is honored only from a repo-root
 * file. The server enforces which keys it honors based on the host the file came
 * from — this schema only validates shape.
 */
export const ReleasesJsonConfigSchema = z
  .object({
    $schema: z.url().optional(),
    // Org scope
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    category: z.string().min(1).max(120).optional(),
    avatar: z
      .url()
      .refine((u) => u.startsWith("https://"), "avatar must be an https URL")
      .optional(),
    tags: z.array(z.string().min(1).max(60)).max(50).optional(),
    social: z.record(z.string().min(1).max(40), SocialValueSchema).optional(),
    notice: NoticeSchema.optional(),
    // Source/product scope
    product: ReleasesJsonProductSchema.optional(),
  })
  .strip();

export type ReleasesJsonConfig = z.infer<typeof ReleasesJsonConfigSchema>;
export type ReleasesJsonProduct = z.infer<typeof ReleasesJsonProductSchema>;

/** Re-exported so the gen script can stamp $id/title without importing CATEGORIES. */
export const RELEASES_JSON_CATEGORIES = CATEGORIES;
```

- [ ] **Step 4: Re-export from the barrel**

In `packages/api-types/src/api-types.ts`, add after the `./schemas/orgs.js` export block:

```ts
export { ReleasesJsonConfigSchema, ReleasesJsonProductSchema } from "./schemas/well-known.js";
export type { ReleasesJsonConfig, ReleasesJsonProduct } from "./schemas/well-known.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/api-types/src/schemas/well-known.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api-types/src/schemas/well-known.ts packages/api-types/src/schemas/well-known.test.ts packages/api-types/src/api-types.ts
git commit -m "feat(api-types): ReleasesJsonConfig schema for releases.json"
```

---

### Task 2: Generate + commit the public JSON Schema

**Files:**

- Create: `scripts/gen-releases-json-schema.ts`
- Create (generated): `web/public/schemas/releases.json`
- Modify: `package.json` (root)

- [ ] **Step 1: Write the generator script**

Create `scripts/gen-releases-json-schema.ts`:

```ts
#!/usr/bin/env bun
// Generates the public JSON Schema for releases.json from the api-types zod
// source of truth (zod 4 native z.toJSONSchema). Run: bun run gen:releases-schema
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ReleasesJsonConfigSchema } from "../packages/api-types/src/schemas/well-known.js";

const OUT = join(import.meta.dir, "..", "web", "public", "schemas", "releases.json");

const base = z.toJSONSchema(ReleasesJsonConfigSchema, { target: "draft-2020-12" });
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://releases.sh/schemas/releases.json",
  title: "releases.json configuration",
  description:
    "Owner-declared listing metadata for the Releases registry. Host at " +
    "https://{domain}/.well-known/releases.json (org identity) or in a repo root " +
    "as releases.json (that source's product mapping).",
  ...base,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${OUT}`);
```

- [ ] **Step 2: Add the npm script**

In root `package.json` `scripts`, add:

```json
"gen:releases-schema": "bun scripts/gen-releases-json-schema.ts"
```

- [ ] **Step 3: Run the generator**

Run: `bun run gen:releases-schema`
Expected: prints `wrote .../web/public/schemas/releases.json`; the file exists and contains a `properties` object with `name`, `description`, `category`, `avatar`, `tags`, `social`, `notice`, `product`.

- [ ] **Step 4: Sanity-check the output**

Run: `bun -e "const s=require('./web/public/schemas/releases.json'); if(!s.properties.product||!s.properties.notice) throw new Error('missing props'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-releases-json-schema.ts web/public/schemas/releases.json package.json
git commit -m "feat(web): publish releases.json JSON Schema at /schemas/releases.json"
```

---

### Task 3: `selfDeclared` metadata helpers (pure)

**Files:**

- Create: `workers/api/src/lib/well-known/self-declared.ts`
- Test: `workers/api/src/lib/well-known/self-declared.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/src/lib/well-known/self-declared.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseSelfDeclared, setSelfDeclaredInMetadata } from "./self-declared.js";

describe("selfDeclared metadata helpers", () => {
  it("returns null for empty/invalid metadata", () => {
    expect(parseSelfDeclared(null)).toBeNull();
    expect(parseSelfDeclared("{}")).toBeNull();
    expect(parseSelfDeclared("not json")).toBeNull();
  });

  it("round-trips a marker and preserves other keys", () => {
    const meta = JSON.stringify({ notice: { message: "hi" } });
    const out = setSelfDeclaredInMetadata(meta, {
      fields: ["description"],
      source: "well-known",
      configHash: "abc",
      syncedAt: "2026-06-05T00:00:00.000Z",
    });
    const parsed = JSON.parse(out);
    expect(parsed.notice).toEqual({ message: "hi" });
    expect(parseSelfDeclared(out)?.fields).toEqual(["description"]);
    expect(parseSelfDeclared(out)?.source).toBe("well-known");
  });

  it("ignores a malformed marker", () => {
    const meta = JSON.stringify({ selfDeclared: { fields: "nope" } });
    expect(parseSelfDeclared(meta)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/well-known/self-declared.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `workers/api/src/lib/well-known/self-declared.ts`:

```ts
/** Provenance marker stored at `metadata.selfDeclared` on orgs and sources. */
export interface SelfDeclared {
  /** Single-value fields this reconciler last wrote from the owner file. */
  fields: string[];
  /** Which host the authoritative file came from. */
  source: "well-known" | "github";
  /** Hash of the last applied file, to short-circuit unchanged re-syncs. */
  configHash: string;
  /** ISO timestamp of the last successful apply. */
  syncedAt: string;
}

export function parseSelfDeclared(metadata: string | null | undefined): SelfDeclared | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = (parsed as Record<string, unknown>).selfDeclared;
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.fields) || !s.fields.every((f) => typeof f === "string")) return null;
  if (s.source !== "well-known" && s.source !== "github") return null;
  if (typeof s.configHash !== "string" || typeof s.syncedAt !== "string") return null;
  return {
    fields: s.fields as string[],
    source: s.source,
    configHash: s.configHash,
    syncedAt: s.syncedAt,
  };
}

export function setSelfDeclaredInMetadata(
  metadata: string | null | undefined,
  marker: SelfDeclared,
): string {
  let base: Record<string, unknown> = {};
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (typeof parsed === "object" && parsed !== null) base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  base.selfDeclared = marker;
  return JSON.stringify(base);
}

/** Stable FNV-1a hash of a config object's JSON (order-insensitive enough for our use). */
export function configHash(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/well-known/self-declared.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/well-known/self-declared.ts workers/api/src/lib/well-known/self-declared.test.ts
git commit -m "feat(api): selfDeclared provenance metadata helpers"
```

---

### Task 4: Fail-closed fetch helper

**Files:**

- Create: `workers/api/src/lib/well-known/fetch.ts`
- Test: `workers/api/src/lib/well-known/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/src/lib/well-known/fetch.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { fetchReleasesJson } from "./fetch.js";

function resp(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("fetchReleasesJson", () => {
  it("returns parsed json on success", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp(JSON.stringify({ name: "Acme" })),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.json).toEqual({ name: "Acme" });
  });

  it("no-ops on 404", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("skips invalid json", async () => {
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp("{not json"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_json");
  });

  it("skips bodies over the size cap", async () => {
    const big = JSON.stringify({ description: "x".repeat(70_000) });
    const r = await fetchReleasesJson("https://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp(big),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
  });

  it("refuses non-https urls", async () => {
    const r = await fetchReleasesJson("http://acme.com/.well-known/releases.json", {
      fetchImpl: async () => resp("{}"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked");
  });

  it("refuses private/loopback hosts", async () => {
    const r = await fetchReleasesJson("https://127.0.0.1/.well-known/releases.json", {
      fetchImpl: async () => resp("{}"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/well-known/fetch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `workers/api/src/lib/well-known/fetch.ts`:

```ts
import { isPrivateOrLocalHost } from "../avatar-ingest.js";

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;

export type FetchSkipReason =
  | "blocked"
  | "not_found"
  | "http_error"
  | "network_error"
  | "too_large"
  | "invalid_json";

export type FetchReleasesJsonResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: FetchSkipReason; detail?: string };

export interface FetchReleasesJsonOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** HTTPS-only, SSRF-screened, size- and time-capped JSON fetch. Every failure
 *  is a safe no-op (never throws). */
export async function fetchReleasesJson(
  url: string,
  opts: FetchReleasesJsonOptions = {},
): Promise<FetchReleasesJsonResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "blocked", detail: "unparseable url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "blocked", detail: "not https" };
  if (isPrivateOrLocalHost(parsed.hostname))
    return { ok: false, reason: "blocked", detail: "private host" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(parsed.toString(), {
      redirect: "manual",
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "releases.sh well-known sync" },
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: "network_error" };
  }
  clearTimeout(timer);

  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (res.status >= 300) return { ok: false, reason: "http_error", detail: String(res.status) };

  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > MAX_BYTES) return { ok: false, reason: "too_large" };
    return parseJson(text);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return { ok: false, reason: "network_error" };
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(chunk.value);
  }
  return parseJson(new TextDecoder().decode(concat(chunks, total)));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function parseJson(text: string): FetchReleasesJsonResult {
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/well-known/fetch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/well-known/fetch.ts workers/api/src/lib/well-known/fetch.test.ts
git commit -m "feat(api): fail-closed fetch helper for releases.json"
```

---

### Task 5: Org-identity diff (pure)

**Files:**

- Create: `workers/api/src/lib/well-known/reconcile-org.ts` (pure part only this task)
- Test: `workers/api/src/lib/well-known/reconcile-org.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/src/lib/well-known/reconcile-org.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { computeOrgIdentityUpdates } from "./reconcile-org.js";
import type { ReleasesJsonConfig } from "@buildinternet/releases-api-types";

// resolveCategory stub: accept known slugs, reject everything else.
const resolveCategory = (input: string) =>
  ["developer-tools", "cloud", "ai"].includes(input) ? input : null;

function org(over: Partial<Record<string, unknown>> = {}) {
  return {
    name: "Acme",
    description: null,
    category: null,
    avatarUrl: null,
    metadata: "{}",
    ...over,
  } as any;
}

describe("computeOrgIdentityUpdates", () => {
  it("fills empty fields and marks them self-declared", () => {
    const cfg: ReleasesJsonConfig = { description: "CI for teams.", category: "developer-tools" };
    const plan = computeOrgIdentityUpdates(org(), cfg, { resolveCategory });
    expect(plan.columnUpdates.description).toBe("CI for teams.");
    expect(plan.columnUpdates.category).toBe("developer-tools");
    expect(plan.selfDeclaredFields.sort()).toEqual(["category", "description"]);
  });

  it("never clobbers a curator-set field (non-empty, not self-declared)", () => {
    const plan = computeOrgIdentityUpdates(
      org({ description: "Curator wrote this" }),
      { description: "owner override" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.description).toBeUndefined();
    expect(plan.skipped).toContain("description");
  });

  it("updates a field that was previously self-declared", () => {
    const meta = JSON.stringify({
      selfDeclared: {
        fields: ["description"],
        source: "well-known",
        configHash: "x",
        syncedAt: "x",
      },
    });
    const plan = computeOrgIdentityUpdates(
      org({ description: "old owner value", metadata: meta }),
      { description: "new owner value" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.description).toBe("new owner value");
  });

  it("ignores an unresolvable category but proceeds", () => {
    const plan = computeOrgIdentityUpdates(
      org(),
      { description: "ok", category: "not-a-category" },
      { resolveCategory },
    );
    expect(plan.columnUpdates.category).toBeUndefined();
    expect(plan.columnUpdates.description).toBe("ok");
    expect(plan.skipped).toContain("category");
  });

  it("collects additive tags and socials without precedence", () => {
    const plan = computeOrgIdentityUpdates(
      org(),
      { tags: ["ci"], social: { twitter: "acmehq" } },
      { resolveCategory },
    );
    expect(plan.tagsToAdd).toEqual(["ci"]);
    expect(plan.socialsToAdd).toEqual([{ platform: "twitter", handle: "acmehq" }]);
  });

  it("plans an avatar mirror when avatarUrl is empty", () => {
    const plan = computeOrgIdentityUpdates(
      org(),
      { avatar: "https://acme.com/logo.png" },
      { resolveCategory },
    );
    expect(plan.avatarSourceUrl).toBe("https://acme.com/logo.png");
  });

  it("does not touch name when config omits it", () => {
    const plan = computeOrgIdentityUpdates(org(), { description: "x" }, { resolveCategory });
    expect(plan.columnUpdates.name).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/well-known/reconcile-org.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure function**

Create `workers/api/src/lib/well-known/reconcile-org.ts`:

```ts
import { parseNotice, setNoticeInMetadata, type Notice } from "@buildinternet/releases-core/notice";
import type { ReleasesJsonConfig } from "@buildinternet/releases-api-types";
import { parseSelfDeclared } from "./self-declared.js";

/** Minimal shape of an organizations row the diff needs. */
export interface OrgLike {
  name: string;
  description: string | null;
  category: string | null;
  avatarUrl: string | null;
  metadata: string | null;
}

export interface OrgIdentityPlan {
  /** Direct column writes (name/description/category). Notice goes via metadata. */
  columnUpdates: Partial<{ name: string; description: string; category: string }>;
  /** New notice to merge into metadata, or undefined to leave as-is. */
  notice?: Notice;
  /** Remote image to mirror to R2, or undefined. */
  avatarSourceUrl?: string;
  /** Additive — never subject to no-clobber. */
  tagsToAdd: string[];
  socialsToAdd: { platform: string; handle: string }[];
  /** Single-value fields written this run (for the selfDeclared marker). */
  selfDeclaredFields: string[];
  /** Honored single-value fields skipped because a curator owns them or invalid. */
  skipped: string[];
}

export interface OrgReconcileDeps {
  /** Resolve a category input to a canonical slug, or null if invalid. */
  resolveCategory: (input: string) => string | null;
}

/** Single-value fields under the precedence rule. `notice`/`avatar` are stored
 *  off-column but follow the same rule via custom getters below. */
const SINGLE_VALUE_FIELDS = ["name", "description", "category", "avatar", "notice"] as const;

export function computeOrgIdentityUpdates(
  org: OrgLike,
  config: ReleasesJsonConfig,
  deps: OrgReconcileDeps,
): OrgIdentityPlan {
  const marker = parseSelfDeclared(org.metadata);
  const declared = new Set(marker?.fields ?? []);
  const plan: OrgIdentityPlan = {
    columnUpdates: {},
    tagsToAdd: [],
    socialsToAdd: [],
    selfDeclaredFields: [...declared],
    skipped: [],
  };

  // Current emptiness + desired value, per honored single-value field.
  const isEmpty: Record<(typeof SINGLE_VALUE_FIELDS)[number], boolean> = {
    name: !org.name, // name is NOT NULL, so effectively never empty
    description: !org.description,
    category: !org.category,
    avatar: !org.avatarUrl,
    notice: parseNotice(org.metadata) === null,
  };

  const writable = (field: (typeof SINGLE_VALUE_FIELDS)[number]) =>
    isEmpty[field] || declared.has(field);

  const mark = (field: string) => {
    if (!plan.selfDeclaredFields.includes(field)) plan.selfDeclaredFields.push(field);
  };

  // name
  if (config.name !== undefined) {
    if (writable("name")) {
      plan.columnUpdates.name = config.name;
      mark("name");
    } else plan.skipped.push("name");
  }
  // description
  if (config.description !== undefined) {
    if (writable("description")) {
      plan.columnUpdates.description = config.description;
      mark("description");
    } else plan.skipped.push("description");
  }
  // category (validate first; invalid → skip the field, not the sync)
  if (config.category !== undefined) {
    const resolved = deps.resolveCategory(config.category);
    if (!resolved) plan.skipped.push("category");
    else if (writable("category")) {
      plan.columnUpdates.category = resolved;
      mark("category");
    } else plan.skipped.push("category");
  }
  // avatar
  if (config.avatar !== undefined) {
    if (writable("avatar")) {
      plan.avatarSourceUrl = config.avatar;
      mark("avatar");
    } else plan.skipped.push("avatar");
  }
  // notice
  if (config.notice !== undefined) {
    if (writable("notice")) {
      plan.notice = config.notice;
      mark("notice");
    } else plan.skipped.push("notice");
  }

  // Additive collections.
  if (config.tags) plan.tagsToAdd = [...config.tags];
  if (config.social) {
    for (const [platform, handle] of Object.entries(config.social)) {
      plan.socialsToAdd.push({ platform, handle });
    }
  }

  return plan;
}

// Re-exported for the apply step (Task 6).
export { setNoticeInMetadata };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/well-known/reconcile-org.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/well-known/reconcile-org.ts workers/api/src/lib/well-known/reconcile-org.test.ts
git commit -m "feat(api): pure org-identity diff for releases.json"
```

---

### Task 6: Apply org reconciliation + `syncOrgWellKnown`

**Files:**

- Modify: `workers/api/src/lib/well-known/reconcile-org.ts` (add apply + orchestration)
- Test: `workers/api/src/lib/well-known/reconcile-org.apply.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `workers/api/src/lib/well-known/reconcile-org.apply.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, orgAccounts, orgTags } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { syncOrgWellKnown } from "./reconcile-org.js";

function fakeR2() {
  const store = new Map<string, unknown>();
  return {
    store,
    put: async (k: string, v: unknown) => void store.set(k, v),
    get: async (k: string) => store.get(k) ?? null,
  } as any;
}

describe("syncOrgWellKnown", () => {
  it("applies owner fields and records the selfDeclared marker", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", category: null, description: null });

    const res = await syncOrgWellKnown(db, "org_a", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            description: "CI for teams.",
            tags: ["ci"],
            social: { twitter: "acmehq" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      domain: "acme.com",
    });

    expect(res.applied).toBe(true);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description).toBe("CI for teams.");
    const accts = await db.select().from(orgAccounts).where(eq(orgAccounts.orgId, "org_a"));
    expect(accts.map((a) => a.platform)).toContain("twitter");
    const tgs = await db.select().from(orgTags).where(eq(orgTags.orgId, "org_a"));
    expect(tgs.length).toBe(1);
    expect(JSON.parse(o!.metadata!).selfDeclared.fields).toContain("description");
  });

  it("dryRun returns a plan and writes nothing", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_b", slug: "beta", name: "Beta" });
    const res = await syncOrgWellKnown(db, "org_b", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      domain: "beta.com",
      dryRun: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ description: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(res.applied).toBe(false);
    expect(res.plan?.columnUpdates.description).toBe("x");
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_b"));
    expect(o!.description ?? null).toBeNull();
  });

  it("no-ops when the org has no domain", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_c", slug: "gamma", name: "Gamma" });
    const res = await syncOrgWellKnown(db, "org_c", {
      bucket: fakeR2(),
      mediaOrigin: "https://media.test",
      domain: null,
    });
    expect(res.applied).toBe(false);
    expect(res.skippedReason).toBe("no_domain");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/well-known/reconcile-org.apply.test.ts`
Expected: FAIL — `syncOrgWellKnown` not exported.

- [ ] **Step 3: Append the apply + orchestration to `reconcile-org.ts`**

Add to the bottom of `workers/api/src/lib/well-known/reconcile-org.ts`:

```ts
import { eq } from "drizzle-orm";
import { organizations, orgAccounts, orgTags } from "@buildinternet/releases-core/schema";
import { ReleasesJsonConfigSchema } from "@buildinternet/releases-api-types";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { ingestOrgAvatar } from "../avatar-ingest.js";
import { getOrCreateTagsD1 } from "../../utils.js";
import { createDb } from "../../db.js";
import { logEvent } from "@releases/lib/log-event";
import { fetchReleasesJson } from "./fetch.js";
import { setSelfDeclaredInMetadata, parseSelfDeclared, configHash } from "./self-declared.js";

type Db = ReturnType<typeof createDb>;

export interface SyncOrgOptions {
  bucket: R2Bucket;
  mediaOrigin: string;
  /** The org's domain; the file is fetched from https://{domain}/.well-known/releases.json. */
  domain: string | null;
  dryRun?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface SyncOrgResult {
  fetched: boolean;
  applied: boolean;
  skippedReason?: string;
  plan?: OrgIdentityPlan;
}

export async function syncOrgWellKnown(
  db: Db,
  orgId: string,
  opts: SyncOrgOptions,
): Promise<SyncOrgResult> {
  if (!opts.domain) return { fetched: false, applied: false, skippedReason: "no_domain" };

  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) return { fetched: false, applied: false, skippedReason: "org_not_found" };

  const url = `https://${opts.domain}/.well-known/releases.json`;
  const fetched = await fetchReleasesJson(url, { fetchImpl: opts.fetchImpl });
  if (!fetched.ok) {
    logEvent("info", {
      component: "well-known",
      event: "fetch-skip",
      orgId,
      url,
      reason: fetched.reason,
    });
    return { fetched: false, applied: false, skippedReason: fetched.reason };
  }

  const validated = ReleasesJsonConfigSchema.safeParse(fetched.json);
  if (!validated.success) {
    logEvent("warn", {
      component: "well-known",
      event: "validate-skip",
      orgId,
      url,
      err: validated.error.message,
    });
    return { fetched: true, applied: false, skippedReason: "invalid_schema" };
  }
  const config = validated.data;

  const hash = configHash(config);
  const existing = parseSelfDeclared(org.metadata);
  if (existing && existing.source === "well-known" && existing.configHash === hash) {
    return { fetched: true, applied: false, skippedReason: "unchanged" };
  }

  const aliasResolved = async (input: string) => await resolveCategoryInput(db, input);
  // Pre-resolve the single category input so the pure diff stays synchronous.
  const resolvedCategory = config.category ? await aliasResolved(config.category) : null;
  const plan = computeOrgIdentityUpdates(org, config, {
    resolveCategory: (input) =>
      input === config.category && resolvedCategory && resolvedCategory.ok
        ? resolvedCategory.slug
        : null,
  });

  if (opts.dryRun) return { fetched: true, applied: false, plan };

  // Apply column updates + notice + selfDeclared marker in one update.
  let metadata = org.metadata ?? "{}";
  if (plan.notice !== undefined) metadata = setNoticeInMetadata(metadata, plan.notice);
  metadata = setSelfDeclaredInMetadata(metadata, {
    fields: plan.selfDeclaredFields,
    source: "well-known",
    configHash: hash,
    syncedAt: new Date().toISOString(),
  });

  const columnUpdates: Record<string, unknown> = {
    ...plan.columnUpdates,
    metadata,
    updatedAt: new Date().toISOString(),
  };

  // Avatar mirror (best-effort; failure does not fail the sync).
  if (plan.avatarSourceUrl) {
    const result = await ingestOrgAvatar({
      sourceUrl: plan.avatarSourceUrl,
      slug: org.slug,
      bucket: opts.bucket,
      mediaOrigin: opts.mediaOrigin,
      fetchImpl: opts.fetchImpl,
    });
    if (result.ok) columnUpdates.avatarUrl = result.avatarUrl;
    else
      logEvent("info", {
        component: "well-known",
        event: "avatar-skip",
        orgId,
        reason: result.error,
      });
  }

  await db.update(organizations).set(columnUpdates).where(eq(organizations.id, org.id));

  // Additive tags.
  if (plan.tagsToAdd.length > 0) {
    const tagRows = await getOrCreateTagsD1(db, plan.tagsToAdd);
    const now = new Date().toISOString();
    await db
      .insert(orgTags)
      .values(tagRows.map((t) => ({ orgId: org.id, tagId: t.id, createdAt: now })))
      .onConflictDoNothing();
  }
  // Additive socials.
  for (const s of plan.socialsToAdd) {
    await db
      .insert(orgAccounts)
      .values({
        orgId: org.id,
        platform: s.platform,
        handle: s.handle,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
  }

  logEvent("info", {
    component: "well-known",
    event: "org-applied",
    orgId,
    fields: plan.selfDeclaredFields,
  });
  return { fetched: true, applied: true, plan };
}
```

Note: `createTestDb()` returns a drizzle handle compatible with `createDb`'s return type; `getOrCreateTagsD1` accepts it. If the test's db type mismatches `Db`, cast at the call site in the test (the helper accepts the structural drizzle type).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/well-known/reconcile-org.apply.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole well-known suite**

Run: `bun test workers/api/src/lib/well-known/`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/well-known/reconcile-org.ts workers/api/src/lib/well-known/reconcile-org.apply.test.ts
git commit -m "feat(api): apply org reconciliation + syncOrgWellKnown"
```

---

### Task 7: Product diff (pure) + GitHub repo parsing

**Files:**

- Create: `workers/api/src/lib/well-known/reconcile-source.ts` (pure parts this task)
- Test: `workers/api/src/lib/well-known/reconcile-source.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/src/lib/well-known/reconcile-source.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { parseGitHubRepo, computeProductPlan } from "./reconcile-source.js";

const resolveCategory = (input: string) => (["cloud", "ai"].includes(input) ? input : null);

describe("parseGitHubRepo", () => {
  it("parses owner/repo from a github url", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("strips trailing path and .git", () => {
    expect(parseGitHubRepo("https://github.com/acme/cloud.git/releases")).toEqual({
      owner: "acme",
      repo: "cloud",
    });
  });
  it("returns null for non-github urls", () => {
    expect(parseGitHubRepo("https://gitlab.com/acme/cloud")).toBeNull();
  });
});

describe("computeProductPlan", () => {
  const cfg = { product: { name: "Acme Cloud", category: "cloud", kind: "saas" } };

  it("creates a product when none matches the slug", () => {
    const plan = computeProductPlan(null, { productId: null, metadata: "{}" } as any, cfg, {
      resolveCategory,
    });
    expect(plan.create).toEqual({
      name: "Acme Cloud",
      slug: "acme-cloud",
      description: null,
      category: "cloud",
      kind: "saas",
    });
    expect(plan.attach).toBe(true);
  });

  it("attaches to an existing product and fills only empty fields", () => {
    const existing = {
      id: "prod_1",
      slug: "acme-cloud",
      description: "Existing",
      category: null,
      kind: null,
    } as any;
    const plan = computeProductPlan(existing, { productId: null, metadata: "{}" } as any, cfg, {
      resolveCategory,
    });
    expect(plan.create).toBeUndefined();
    expect(plan.attach).toBe(true);
    expect(plan.fills).toEqual({ category: "cloud", kind: "saas" }); // description NOT overwritten
  });

  it("does not reattach a curator-set productId", () => {
    const existing = {
      id: "prod_1",
      slug: "acme-cloud",
      description: null,
      category: null,
      kind: null,
    } as any;
    const plan = computeProductPlan(
      existing,
      { productId: "prod_other", metadata: "{}" } as any,
      cfg,
      { resolveCategory },
    );
    expect(plan.attach).toBe(false);
  });

  it("reattaches when productId was self-declared", () => {
    const meta = JSON.stringify({
      selfDeclared: { fields: ["product"], source: "github", configHash: "x", syncedAt: "x" },
    });
    const existing = {
      id: "prod_1",
      slug: "acme-cloud",
      description: null,
      category: null,
      kind: null,
    } as any;
    const plan = computeProductPlan(
      existing,
      { productId: "prod_old", metadata: meta } as any,
      cfg,
      { resolveCategory },
    );
    expect(plan.attach).toBe(true);
  });

  it("returns empty plan when there is no product block", () => {
    const plan = computeProductPlan(
      null,
      { productId: null, metadata: "{}" } as any,
      {},
      { resolveCategory },
    );
    expect(plan.create).toBeUndefined();
    expect(plan.attach).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/well-known/reconcile-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure parts**

Create `workers/api/src/lib/well-known/reconcile-source.ts`:

```ts
import { toSlug } from "@buildinternet/releases-core/slug";
import type { ReleasesJsonConfig } from "@buildinternet/releases-api-types";
import { parseSelfDeclared } from "./self-declared.js";

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/** Extract `owner/repo` from a github.com source URL. Returns null otherwise. */
export function parseGitHubRepo(url: string): GitHubRepo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
  const segs = parsed.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export interface ProductRowLike {
  id: string;
  slug: string;
  description: string | null;
  category: string | null;
  kind: string | null;
}

export interface SourceRowLike {
  productId: string | null;
  metadata: string | null;
}

export interface ProductPlan {
  /** Create a new product with these values (omitted when one already matches). */
  create?: {
    name: string;
    slug: string;
    description: string | null;
    category: string | null;
    kind: string | null;
  };
  /** Set source.productId to the matched/created product. */
  attach: boolean;
  /** Fill-if-empty updates to an existing product. */
  fills: Partial<{ description: string; category: string; kind: string }>;
  /** The product slug this plan targets (for the apply step's find-or-create). */
  slug?: string;
}

export interface SourceReconcileDeps {
  resolveCategory: (input: string) => string | null;
}

/**
 * @param existing the product row matching the declared slug within the org, or null
 */
export function computeProductPlan(
  existing: ProductRowLike | null,
  source: SourceRowLike,
  config: ReleasesJsonConfig,
  deps: SourceReconcileDeps,
): ProductPlan {
  const product = config.product;
  if (!product) return { attach: false, fills: {} };

  const slug = product.slug ? toSlug(product.slug) : toSlug(product.name);
  const category = product.category ? deps.resolveCategory(product.category) : null;

  // Attach decision: ok if source has no product, or its product was self-declared.
  const marker = parseSelfDeclared(source.metadata);
  const productSelfDeclared = marker?.fields.includes("product") ?? false;
  const attach = source.productId === null || productSelfDeclared;

  if (!existing) {
    return {
      create: {
        name: product.name,
        slug,
        description: product.description ?? null,
        category: category ?? null,
        kind: product.kind ?? null,
      },
      attach,
      fills: {},
      slug,
    };
  }

  const fills: ProductPlan["fills"] = {};
  if (product.description && !existing.description) fills.description = product.description;
  if (category && !existing.category) fills.category = category;
  if (product.kind && !existing.kind) fills.kind = product.kind;

  return { attach, fills, slug };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/well-known/reconcile-source.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/well-known/reconcile-source.ts workers/api/src/lib/well-known/reconcile-source.test.ts
git commit -m "feat(api): pure product diff + github repo parsing for releases.json"
```

---

### Task 8: Apply source reconciliation + grouping

**Files:**

- Modify: `workers/api/src/lib/well-known/reconcile-source.ts` (add apply + `syncSourceRepo`)
- Test: `workers/api/src/lib/well-known/reconcile-source.apply.test.ts`

- [ ] **Step 1: Write the failing integration test (grouping is the key assertion)**

Create `workers/api/src/lib/well-known/reconcile-source.apply.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, products } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { syncSourceRepo } from "./reconcile-source.js";

function fileResp(body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

async function seed(db: any) {
  await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
  await db.insert(sources).values([
    {
      id: "src_1",
      orgId: "org_a",
      name: "Cloud repo",
      slug: "cloud",
      type: "github",
      url: "https://github.com/acme/cloud",
    },
    {
      id: "src_2",
      orgId: "org_a",
      name: "Cloud CLI",
      slug: "cloud-cli",
      type: "github",
      url: "https://github.com/acme/cloud-cli",
    },
  ]);
}

describe("syncSourceRepo", () => {
  it("creates a product and attaches the source", async () => {
    const db = createTestDb();
    await seed(db);
    const res = await syncSourceRepo(db, "src_1", {
      fetchImpl: fileResp({ product: { name: "Acme Cloud", category: "cloud" } }),
    });
    expect(res.applied).toBe(true);
    const [s] = await db.select().from(sources).where(eq(sources.id, "src_1"));
    const [p] = await db.select().from(products).where(eq(products.slug, "acme-cloud"));
    expect(s!.productId).toBe(p!.id);
    expect(p!.category).toBe("cloud");
  });

  it("groups a second repo onto the SAME product (same slug)", async () => {
    const db = createTestDb();
    await seed(db);
    await syncSourceRepo(db, "src_1", { fetchImpl: fileResp({ product: { name: "Acme Cloud" } }) });
    await syncSourceRepo(db, "src_2", { fetchImpl: fileResp({ product: { name: "Acme Cloud" } }) });

    const prods = await db.select().from(products).where(eq(products.orgId, "org_a"));
    expect(prods.length).toBe(1); // grouped, not duplicated
    const [s1] = await db.select().from(sources).where(eq(sources.id, "src_1"));
    const [s2] = await db.select().from(sources).where(eq(sources.id, "src_2"));
    expect(s1!.productId).toBe(s2!.productId);
  });

  it("does not overwrite an existing product's description across repos", async () => {
    const db = createTestDb();
    await seed(db);
    await syncSourceRepo(db, "src_1", {
      fetchImpl: fileResp({ product: { name: "Acme Cloud", description: "First" } }),
    });
    await syncSourceRepo(db, "src_2", {
      fetchImpl: fileResp({ product: { name: "Acme Cloud", description: "Second" } }),
    });
    const [p] = await db.select().from(products).where(eq(products.slug, "acme-cloud"));
    expect(p!.description).toBe("First");
  });

  it("no-ops for a non-github source", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_b", slug: "beta", name: "Beta" });
    await db.insert(sources).values({
      id: "src_x",
      orgId: "org_b",
      name: "Feed",
      slug: "feed",
      type: "feed",
      url: "https://beta.com/changelog",
    });
    const res = await syncSourceRepo(db, "src_x", {
      fetchImpl: fileResp({ product: { name: "X" } }),
    });
    expect(res.applied).toBe(false);
    expect(res.skippedReason).toBe("not_github");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/well-known/reconcile-source.apply.test.ts`
Expected: FAIL — `syncSourceRepo` not exported.

- [ ] **Step 3: Append apply + orchestration to `reconcile-source.ts`**

Add to the bottom of `workers/api/src/lib/well-known/reconcile-source.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { sources, products } from "@buildinternet/releases-core/schema";
import { ReleasesJsonConfigSchema } from "@buildinternet/releases-api-types";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { createDb } from "../../db.js";
import { logEvent } from "@releases/lib/log-event";
import { fetchReleasesJson } from "./fetch.js";
import { setSelfDeclaredInMetadata, parseSelfDeclared, configHash } from "./self-declared.js";

type Db = ReturnType<typeof createDb>;

export interface SyncSourceOptions {
  dryRun?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface SyncSourceResult {
  fetched: boolean;
  applied: boolean;
  skippedReason?: string;
  plan?: ProductPlan;
}

export async function syncSourceRepo(
  db: Db,
  sourceId: string,
  opts: SyncSourceOptions = {},
): Promise<SyncSourceResult> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source) return { fetched: false, applied: false, skippedReason: "source_not_found" };
  if (source.type !== "github")
    return { fetched: false, applied: false, skippedReason: "not_github" };

  const gh = parseGitHubRepo(source.url);
  if (!gh) return { fetched: false, applied: false, skippedReason: "not_github" };

  const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/releases.json`;
  const fetched = await fetchReleasesJson(url, { fetchImpl: opts.fetchImpl });
  if (!fetched.ok) {
    logEvent("info", {
      component: "well-known",
      event: "repo-fetch-skip",
      sourceId,
      url,
      reason: fetched.reason,
    });
    return { fetched: false, applied: false, skippedReason: fetched.reason };
  }

  const validated = ReleasesJsonConfigSchema.safeParse(fetched.json);
  if (!validated.success) {
    logEvent("warn", { component: "well-known", event: "repo-validate-skip", sourceId, url });
    return { fetched: true, applied: false, skippedReason: "invalid_schema" };
  }
  const config = validated.data;
  if (!config.product) return { fetched: true, applied: false, skippedReason: "no_product" };

  const slug = config.product.slug ? toSlug(config.product.slug) : toSlug(config.product.name);
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.orgId, source.orgId), eq(products.slug, slug)));

  const resolved = config.product.category
    ? await resolveCategoryInput(db, config.product.category)
    : null;
  const plan = computeProductPlan(existing ?? null, source, config, {
    resolveCategory: (input) =>
      input === config.product?.category && resolved && resolved.ok ? resolved.slug : null,
  });

  if (opts.dryRun) return { fetched: true, applied: false, plan };

  // Resolve/create the product.
  let productId = existing?.id ?? null;
  if (plan.create) {
    const [created] = await db
      .insert(products)
      .values({
        name: plan.create.name,
        slug: plan.create.slug,
        orgId: source.orgId,
        description: plan.create.description,
        category: plan.create.category,
        kind: plan.create.kind,
      })
      .returning({ id: products.id });
    productId = created!.id;
  } else if (existing && Object.keys(plan.fills).length > 0) {
    await db.update(products).set(plan.fills).where(eq(products.id, existing.id));
  }

  // Attach the source + stamp provenance.
  if (plan.attach && productId) {
    const metadata = setSelfDeclaredInMetadata(source.metadata, {
      fields: ["product"],
      source: "github",
      configHash: configHash(config),
      syncedAt: new Date().toISOString(),
    });
    await db.update(sources).set({ productId, metadata }).where(eq(sources.id, source.id));
  }

  logEvent("info", { component: "well-known", event: "repo-applied", sourceId, productSlug: slug });
  return {
    fetched: true,
    applied: plan.attach || !!plan.create || Object.keys(plan.fills).length > 0,
    plan,
  };
}

// silence unused import in builds where parseSelfDeclared is only used by the pure fn above
void parseSelfDeclared;
```

(Remove the trailing `void parseSelfDeclared;` line if the linter reports `parseSelfDeclared` already used.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/well-known/reconcile-source.apply.test.ts`
Expected: PASS (4 tests) — note especially the grouping test asserts `products.length === 1`.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/well-known/reconcile-source.ts workers/api/src/lib/well-known/reconcile-source.apply.test.ts
git commit -m "feat(api): apply source/product reconciliation + cross-repo grouping"
```

---

### Task 9: `POST /v1/orgs/:slug/sync-well-known` route

**Files:**

- Modify: `workers/api/src/routes/orgs.ts`
- Test: `workers/api/test/orgs-sync-well-known.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `workers/api/test/orgs-sync-well-known.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp, type TestDb } from "./setup.js";
import { orgRoutes } from "../src/routes/orgs.js";

function fakeR2() {
  const store = new Map<string, unknown>();
  return {
    store,
    put: async (k: string, v: unknown) => void store.set(k, v),
    get: async () => null,
  } as any;
}

describe("POST /v1/orgs/:slug/sync-well-known", () => {
  let db: TestDb;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(async () => {
    db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", domain: "acme.com" });
  });

  function app() {
    return createTestApp(db, orgRoutes, {
      env: { MEDIA: fakeR2(), MEDIA_ORIGIN: "https://media.test" },
    });
  }

  it("applies the owner file and returns the plan", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ description: "CI for teams." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const res = await app()(
      new Request("http://x/v1/orgs/acme/sync-well-known", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description).toBe("CI for teams.");
  });

  it("dryRun=1 returns the plan and writes nothing", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ description: "preview" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const res = await app()(
      new Request("http://x/v1/orgs/acme/sync-well-known?dryRun=1", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.applied).toBe(false);
    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description ?? null).toBeNull();
  });

  it("404 for an unknown org", async () => {
    const res = await app()(
      new Request("http://x/v1/orgs/nope/sync-well-known", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/orgs-sync-well-known.test.ts`
Expected: FAIL — route returns 404 for `acme` (route not registered) or a 500.

- [ ] **Step 3: Add the import**

In `workers/api/src/routes/orgs.ts`, add near the other lib imports (after the `ingestOrgAvatar` import line):

```ts
import { syncOrgWellKnown } from "../lib/well-known/reconcile-org.js";
```

- [ ] **Step 4: Add the route**

In `workers/api/src/routes/orgs.ts`, immediately after the `POST /orgs/:slug/avatar` handler block (the one ending around line 641), add:

```ts
orgRoutes.post(
  "/orgs/:slug/sync-well-known",
  describeRoute({
    hide: hideInProduction,
    tags: ["Orgs"],
    summary: "Reconcile org metadata from the owner's .well-known/releases.json",
    description:
      "Fetches https://{org.domain}/.well-known/releases.json, validates it, and reconciles owner-declared identity fields onto the org (never clobbering curator/editorial fields). Pass ?dryRun=1 to preview the computed diff without applying. Requires write scope.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "Sync result (applied or dry-run plan)" },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";

    const [org] = await db.select().from(organizations).where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const result = await syncOrgWellKnown(db, org.id, {
      bucket: c.env.MEDIA,
      mediaOrigin: c.env.MEDIA_ORIGIN ?? "https://media.releases.sh",
      domain: org.domain,
      dryRun,
    });
    return c.json(result);
  },
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test workers/api/test/orgs-sync-well-known.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/orgs.ts workers/api/test/orgs-sync-well-known.test.ts
git commit -m "feat(api): POST /v1/orgs/:slug/sync-well-known (with dryRun)"
```

---

### Task 10: Feature flag + daily two-pass cron

**Files:**

- Modify: `packages/lib/src/flags.ts`
- Create: `workers/api/src/cron/well-known-sync.ts`
- Test: `workers/api/src/cron/well-known-sync.test.ts`
- Modify: `workers/api/src/index.ts`
- Modify: `workers/api/wrangler.jsonc`

- [ ] **Step 1: Add the flag (default true)**

In `packages/lib/src/flags.ts`, inside the `FLAGS` registry object, add an entry mirroring the shape of the existing `batchSummarizeEnabled` entry but with `default: true`:

```ts
  wellKnownSyncEnabled: { key: "well-known-sync-enabled", default: true },
```

(Open the file first and match the exact property shape used by neighboring entries — `{ key, default }`.)

- [ ] **Step 2: Write the failing cron test**

Create `workers/api/src/cron/well-known-sync.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, products } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../test/setup.js";
import { wellKnownSync } from "./well-known-sync.js";

function fileFor(map: Record<string, unknown>) {
  return async (url: string) => {
    for (const [needle, body] of Object.entries(map)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("nope", { status: 404 });
  };
}

describe("wellKnownSync cron", () => {
  it("runs both passes: org identity + repo grouping", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", domain: "acme.com" });
    await db.insert(sources).values({
      id: "src_1",
      orgId: "org_a",
      name: "Cloud",
      slug: "cloud",
      type: "github",
      url: "https://github.com/acme/cloud",
    });

    await wellKnownSync({
      DB: {} as any,
      MEDIA: { put: async () => undefined } as any,
      MEDIA_ORIGIN: "https://media.test",
      _drizzleOverride: db,
      fetchImpl: fileFor({
        "acme.com/.well-known/releases.json": { description: "CI for teams." },
        "raw.githubusercontent.com/acme/cloud/HEAD/releases.json": {
          product: { name: "Acme Cloud" },
        },
      }),
    });

    const [o] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(o!.description).toBe("CI for teams.");
    const [p] = await db.select().from(products).where(eq(products.slug, "acme-cloud"));
    expect(p).toBeDefined();
    const [s] = await db.select().from(sources).where(eq(sources.id, "src_1"));
    expect(s!.productId).toBe(p!.id);
  });

  it("skips when CRON_ENABLED=false", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "o", slug: "s", name: "S", domain: "s.com" });
    let called = false;
    await wellKnownSync({
      DB: {} as any,
      MEDIA: {} as any,
      MEDIA_ORIGIN: "x",
      CRON_ENABLED: "false",
      _drizzleOverride: db,
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test workers/api/src/cron/well-known-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the cron module**

Create `workers/api/src/cron/well-known-sync.ts`:

```ts
import { isNull, eq, and } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { syncOrgWellKnown } from "../lib/well-known/reconcile-org.js";
import { syncSourceRepo } from "../lib/well-known/reconcile-source.js";

export interface WellKnownSyncEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  MEDIA_ORIGIN?: string;
  FLAGS?: FlagshipBinding;
  WELL_KNOWN_SYNC_ENABLED?: string;
  CRON_ENABLED?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: ReturnType<typeof createDb>;
  /** TEST-ONLY: inject fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export async function wellKnownSync(env: WellKnownSyncEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "well-known", event: "cron-disabled" });
    return;
  }
  if (!(await flag(env.FLAGS, env.WELL_KNOWN_SYNC_ENABLED, FLAGS.wellKnownSyncEnabled))) {
    logEvent("info", { component: "well-known", event: "flag-off" });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const mediaOrigin = env.MEDIA_ORIGIN ?? "https://media.releases.sh";
  let orgApplied = 0;
  let sourceApplied = 0;

  // Pass 1: org identity from domain .well-known files.
  const orgs = await db
    .select({ id: organizations.id, domain: organizations.domain })
    .from(organizations)
    .where(and(eq(organizations.fetchPaused, false)));
  for (const o of orgs) {
    if (!o.domain) continue;
    try {
      const r = await syncOrgWellKnown(db, o.id, {
        bucket: env.MEDIA,
        mediaOrigin,
        domain: o.domain,
        fetchImpl: env.fetchImpl,
      });
      if (r.applied) orgApplied++;
    } catch (err) {
      logEvent("error", { component: "well-known", event: "org-sync-failed", orgId: o.id, err });
    }
  }

  // Pass 2: source→product mapping from repo-root files.
  const ghSources = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.type, "github"), isNull(sources.deletedAt)));
  for (const s of ghSources) {
    try {
      const r = await syncSourceRepo(db, s.id, { fetchImpl: env.fetchImpl });
      if (r.applied) sourceApplied++;
    } catch (err) {
      logEvent("error", {
        component: "well-known",
        event: "source-sync-failed",
        sourceId: s.id,
        err,
      });
    }
  }

  logEvent("info", { component: "well-known", event: "sweep-done", orgApplied, sourceApplied });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test workers/api/src/cron/well-known-sync.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire the cron trigger in wrangler.jsonc**

In `workers/api/wrangler.jsonc`, add `"0 6 * * *"` to the `triggers.crons` array (after `"30 5 * * *"`):

```json
"crons": [
  "0 * * * *",
  "0 1 * * *",
  "0 3 * * *",
  "0 4 * * *",
  "30 4 * * *",
  "0 5 * * *",
  "30 5 * * *",
  "0 6 * * *",
],
```

(Do NOT add a cron to the `[env.staging]` block — staging runs no crons.)

- [ ] **Step 7: Dispatch the cron in index.ts**

In `workers/api/src/index.ts`: (a) add the import near the other cron imports:

```ts
import { wellKnownSync } from "./cron/well-known-sync.js";
```

(b) Add `WELL_KNOWN_SYNC_ENABLED?: string;` to the `Env["Bindings"]` type (near `BATCH_SUMMARIZE_ENABLED`).

(c) In the `scheduled` handler, add a branch before the hourly fallthrough:

```ts
if (event.cron === "0 6 * * *") {
  ctx.waitUntil(
    loggedDispatch(
      "well-known-sync-cron",
      wellKnownSync({
        DB: env.DB,
        MEDIA: env.MEDIA,
        MEDIA_ORIGIN: env.MEDIA_ORIGIN,
        FLAGS: env.FLAGS,
        WELL_KNOWN_SYNC_ENABLED: env.WELL_KNOWN_SYNC_ENABLED,
        CRON_ENABLED: env.CRON_ENABLED,
      }),
      alertEnv,
    ),
  );
  return;
}
```

- [ ] **Step 8: Run the cron + flag tests + typecheck the worker**

Run: `bun test workers/api/src/cron/well-known-sync.test.ts && (cd workers/api && npx tsc --noEmit)`
Expected: tests PASS; tsc reports no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/lib/src/flags.ts workers/api/src/cron/well-known-sync.ts workers/api/src/cron/well-known-sync.test.ts workers/api/src/index.ts workers/api/wrangler.jsonc
git commit -m "feat(api): daily well-known sweep (two-pass) behind well-known-sync-enabled (default on)"
```

---

### Task 11: Docs + conventions entry

**Files:**

- Create: `docs/architecture/well-known-config.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the architecture doc**

Create `docs/architecture/well-known-config.md`:

````markdown
# Owner-declared listing metadata (`releases.json`)

Owners self-declare how they appear in the registry with a small,
`$schema`-validated `releases.json`. Authority is scoped by **where the file is
hosted**, not by what it claims.

| Location                                     | Scope                 | Honored fields                                                          |
| -------------------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `https://{domain}/.well-known/releases.json` | Org identity          | `name`, `description`, `category`, `avatar`, `tags`, `social`, `notice` |
| `{owner}/{repo}/releases.json` (repo root)   | That source → product | `product` (name/slug + optional description/category/kind)              |

The reconciler honors org-identity keys only from the domain file and `product`
only from a repo file — a repo cannot define the org. Same product slug across
repos groups those sources under one product.

## Org-scope example (`.well-known/releases.json`)

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "name": "Acme",
  "description": "CI for teams that ship.",
  "category": "developer-tools",
  "avatar": "https://acme.com/logo.png",
  "tags": ["ci", "observability"],
  "social": { "twitter": "acmehq", "github": "acme" },
  "notice": { "message": "Docs moved", "href": "https://acme.com/docs" }
}
```
````

## Repo-scope example (`releases.json` at repo root)

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "product": { "name": "Acme Cloud", "slug": "acme-cloud", "category": "cloud", "kind": "saas" }
}
```

## Reconciliation

- **Precedence:** a field is owner-writable only if it is empty or was previously
  self-declared (tracked at `metadata.selfDeclared`). Curator-set and editorial
  fields (`featured`, `isHidden`, `discovery`, `fetchPaused`, collections,
  blocked/ignored URLs; source `isPrimary`/`fetchPriority`) are never touched.
- **Category** is validated against `CATEGORIES`; an unresolvable value is
  ignored without failing the sync.
- **Tags/social** are additive (v1 does not remove entries absent from the file).
- **Product metadata** is fill-if-empty across repos, so two repos claiming the
  same product cannot fight over its fields.
- Everything **fails closed**: a missing/invalid/oversized/SSRF-blocked file is a
  safe no-op.

## Triggers

- `POST /v1/orgs/:slug/sync-well-known` (write scope), `?dryRun=1` to preview.
- Daily sweep (`0 6 * * *`), two passes (org domain files, then github repo
  files), gated by the Flagship flag `well-known-sync-enabled` (**default on**;
  it is a kill switch). The schema is generated from the api-types zod source via
  `bun run gen:releases-schema` and served at
  `https://releases.sh/schemas/releases.json`.

## Out of scope (Tier 2 / future)

Self-serve source declaration (`changelogs[]`), org-identity from a repo file,
social/tag removal sync, a CLI verb, and a public web docs page.

````

- [ ] **Step 2: Add the AGENTS.md conventions line**

In `AGENTS.md`, in the `## Conventions` list, add one bullet:

```markdown
- **Owner-declared listing metadata**: a `$schema`-validated `releases.json` — domain `.well-known/releases.json` sets org identity, repo-root `releases.json` maps that source to a product (grouping by shared product slug); display-only, fail-closed, never clobbers curator/editorial fields, flag `well-known-sync-enabled` (default on). See [well-known-config.md](docs/architecture/well-known-config.md).
````

Add the matching entry to the `## Further reading` list:

```markdown
- [well-known-config.md](docs/architecture/well-known-config.md) — owner-declared `releases.json`: host-scoped authority (domain = org identity, repo = source→product), reconciliation precedence, the sync route + daily sweep.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/well-known-config.md AGENTS.md
git commit -m "docs: document releases.json owner-declared listing metadata"
```

---

### Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full well-known + route test surface**

Run: `bun test workers/api/src/lib/well-known/ workers/api/src/cron/well-known-sync.test.ts workers/api/test/orgs-sync-well-known.test.ts packages/api-types/src/schemas/well-known.test.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck root + worker + api-types**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd packages/api-types && npx tsc --noEmit)`
Expected: no errors. (If a test's `createTestDb()` handle trips the `Db` type on `getOrCreateTagsD1`/inserts, add an `as any` cast at that call site in the test only — never in `src`.)

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. Fix any oxlint findings (e.g. unused imports) and re-run.

- [ ] **Step 4: Regenerate the schema to confirm it's in sync**

Run: `bun run gen:releases-schema && git diff --exit-code web/public/schemas/releases.json`
Expected: exit 0 (no diff) — the committed schema matches the current zod source.

- [ ] **Step 5: Full test suite (catch regressions)**

Run: `bun test`
Expected: PASS (no new failures attributable to this work).

- [ ] **Step 6: Commit any lint/format fixups**

```bash
git add -A
git commit -m "chore: lint/format fixups for releases.json" || echo "nothing to commit"
```

---

## Self-review notes

- **Spec coverage:** schema+`$schema` (T1–T2), fail-closed fetch (T4), org reconciler + precedence/`selfDeclared` (T3,T5,T6), source/product reconciler + grouping (T7,T8), route + dryRun (T9), flag default-on + two-pass sweep (T10), no migration (confirmed — only `metadata` JSON + existing columns), docs (T11), tests throughout, verification (T12). Tier 2 / removals / CLI / web docs page explicitly deferred.
- **Type consistency:** `syncOrgWellKnown`/`syncSourceRepo` signatures, `OrgIdentityPlan`/`ProductPlan` shapes, `SelfDeclared` marker, and `FLAGS.wellKnownSyncEnabled` key are used identically across producing and consuming tasks.
- **Known soft spots flagged inline:** the test-db handle vs `Db` type may need an `as any` at test call sites (noted in T6/T12); the `void parseSelfDeclared;` guard in T8 is removable if the linter says so; the flag entry shape must match neighbors (noted in T10).

```

```
