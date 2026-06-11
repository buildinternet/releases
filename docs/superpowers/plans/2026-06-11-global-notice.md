# Site-wide Notice + Admin Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only admin UI to publish a single site-wide notice (home-page card or thin top banner, configurable color + optional dismiss) that renders on the public site, and move the admin destinations under one "Admin" entry in the user dropdown.

**Architecture:** A generic `site_settings` key/value table (worker-local island) stores the notice JSON under key `site_notice`. The API worker exposes `GET /v1/site-notice` (public, cached, active-only unless admin) and `PUT /v1/site-notice` (in-handler admin guard). The Next.js web frontend reads it fail-open and renders a banner (root layout) or card (homepage); the admin form writes via a server action. The shared notice type lives in `@buildinternet/releases-core`, its zod schema in `@buildinternet/releases-api-types`.

**Tech Stack:** Bun, TypeScript (strict), Hono, Drizzle + Cloudflare D1, Next.js (App Router, server components + server actions), Tailwind, zod, `bun:test`.

---

## File Structure

**Create:**
- `packages/core/src/site-notice.ts` — `SiteNotice` type, constants, `readableTextColor()`, `isHexColor()`, `StoredSiteNotice`.
- `packages/core/src/site-notice.test.ts` — unit tests for the pure helpers.
- `packages/api-types/src/schemas/site-notice.ts` — `SiteNoticeSchema`, `SiteNoticeResponseSchema`.
- `packages/api-types/src/schemas/site-notice.test.ts` — schema validation tests.
- `workers/api/migrations/20260611000000_add_site_settings.sql` — the table.
- `workers/api/src/db/schema-site-settings.ts` — Drizzle island table.
- `workers/api/src/queries/site-settings.ts` — generic get/set + notice read/write.
- `workers/api/src/routes/site-notice.ts` — the Hono route module.
- `tests/unit/site-notice-route.test.ts` — route + persistence tests.
- `web/src/lib/site-notice.ts` — `getSiteNotice()` reader + `selectNoticeForSlot()`.
- `web/src/lib/site-notice.test.ts` — `selectNoticeForSlot()` tests.
- `web/src/lib/site-notice-admin-flag.ts` — `isSiteNoticeAdminEnabled()`.
- `web/src/app/actions/site-notice.ts` — `getSiteNoticeAdminAction()`, `setSiteNoticeAction()`.
- `web/src/components/site-notice-view.tsx` — client presentational (banner|card + dismiss).
- `web/src/components/site-notice.tsx` — server wrapper `<SiteNotice slot="banner"|"home">`.
- `web/src/app/admin/page.tsx` — admin hub index.
- `web/src/app/admin/site-notice/page.tsx` — admin notice page (gate + load).
- `web/src/app/admin/site-notice/notice-form.tsx` — client edit form.

**Modify:**
- `packages/core/package.json` — add the `./site-notice` export.
- `packages/api-types/src/api-types.ts` — re-export the new schemas.
- `workers/api/src/route-namespaces.ts` — add `"site-notice"` to `publicReadRoutes`.
- `workers/api/src/v1-routes.ts` — mount `siteNoticeRoutes`.
- `web/src/lib/api.ts` — add `api.siteNotice`.
- `web/src/app/layout.tsx` — mount `<SiteNotice slot="banner" />`.
- `web/src/app/page.tsx` — mount `<SiteNotice slot="home" />`.
- `web/src/components/header.tsx` — compute `adminEnabled`, pass to nav.
- `web/src/components/account-nav.tsx` — accept `adminEnabled`, render Admin link.
- `web/src/components/mobile-nav.tsx` — accept + forward `adminEnabled`.

---

## Task 1: Core `SiteNotice` type + pure helpers

**Files:**
- Create: `packages/core/src/site-notice.ts`
- Test: `packages/core/src/site-notice.test.ts`
- Modify: `packages/core/package.json`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/site-notice.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  isHexColor,
  readableTextColor,
  SITE_NOTICE_KEY,
  DEFAULT_SITE_NOTICE_COLOR,
} from "./site-notice";

describe("isHexColor", () => {
  it("accepts 6-digit hex with hash", () => {
    expect(isHexColor("#0081e7")).toBe(true);
    expect(isHexColor("#FFFFFF")).toBe(true);
  });
  it("rejects shorthand, missing hash, and junk", () => {
    expect(isHexColor("#fff")).toBe(false);
    expect(isHexColor("0081e7")).toBe(false);
    expect(isHexColor("blue")).toBe(false);
    expect(isHexColor("#0081e7 ")).toBe(false);
  });
});

describe("readableTextColor", () => {
  it("returns dark text on light backgrounds", () => {
    expect(readableTextColor("#ffffff")).toBe("#0c0a09");
    expect(readableTextColor("#fde047")).toBe("#0c0a09"); // amber-300
  });
  it("returns light text on dark backgrounds", () => {
    expect(readableTextColor("#0c0a09")).toBe("#ffffff");
    expect(readableTextColor("#0081e7")).toBe("#ffffff"); // brand blue
  });
  it("falls back to light text on an invalid color", () => {
    expect(readableTextColor("not-a-color")).toBe("#ffffff");
  });
});

describe("constants", () => {
  it("exposes the storage key and default color", () => {
    expect(SITE_NOTICE_KEY).toBe("site_notice");
    expect(DEFAULT_SITE_NOTICE_COLOR).toBe("#0081e7");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/site-notice.test.ts`
Expected: FAIL — `Cannot find module './site-notice'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/site-notice.ts`:

```ts
/**
 * Site-wide notice — a single, ad-hoc announcement shown to all visitors,
 * either as a home-page card or a thin top banner. Stored as a JSON blob under
 * the `site_notice` key of the generic `site_settings` table (worker-local).
 * Pure / runtime-neutral (no zod, no DB) so the API worker, the web reader, and
 * the admin form can share the type + helpers. The zod validation schema lives
 * in `@buildinternet/releases-api-types` (`SiteNoticeSchema`) and must stay
 * structurally in sync with `SiteNotice` below.
 */

export const SITE_NOTICE_KEY = "site_notice";

/** Brand blue — the "reasonable default" color for a new notice. */
export const DEFAULT_SITE_NOTICE_COLOR = "#0081e7";

/** The two placements a notice can take. Values double as the web slot names. */
export const SITE_NOTICE_PLACEMENTS = ["home", "banner"] as const;
export type SiteNoticePlacement = (typeof SITE_NOTICE_PLACEMENTS)[number];

export interface SiteNotice {
  /** When false the notice is stored but not shown publicly. */
  active: boolean;
  /** Short human message. ≤280 chars (enforced by SiteNoticeSchema on write). */
  message: string;
  /** Optional CTA label for the link. */
  linkText?: string;
  /** Absolute http(s) URL or a site-relative "/path". */
  href?: string;
  placement: SiteNoticePlacement;
  /** Background color as a 6-digit hex (#rrggbb). */
  color: string;
  /** When true, visitors may dismiss the notice (persisted per-version). */
  dismissible: boolean;
}

/** A notice as returned by the API, stamped with the row's last-write time (ISO). */
export type StoredSiteNotice = SiteNotice & { updatedAt: string };

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** True for a strict 6-digit hex color with a leading `#`. */
export function isHexColor(value: string): boolean {
  return HEX6.test(value);
}

/**
 * Pick a readable foreground (near-black `#0c0a09` = stone-950, or `#ffffff`)
 * for a solid hex background using the WCAG relative-luminance threshold. An
 * invalid color falls back to light text (safe on the brand-blue default).
 */
export function readableTextColor(background: string): "#0c0a09" | "#ffffff" {
  if (!isHexColor(background)) return "#ffffff";
  const r = parseInt(background.slice(1, 3), 16) / 255;
  const g = parseInt(background.slice(3, 5), 16) / 255;
  const b = parseInt(background.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Threshold 0.5 keeps mid-tones (amber/green) on dark text; deep blues on light.
  return luminance > 0.5 ? "#0c0a09" : "#ffffff";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/site-notice.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 5: Add the package export**

In `packages/core/package.json`, inside the `"exports"` map, add a line after the `"./notice"` entry (keep alphabetical-ish grouping is not required — match the existing style):

```json
    "./notice": "./src/notice.ts",
    "./site-notice": "./src/site-notice.ts",
    "./title-dedup": "./src/title-dedup.ts"
```

(There is no build step — `src/*.ts` is published directly, so the import resolves immediately.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/site-notice.ts packages/core/src/site-notice.test.ts packages/core/package.json
git commit -m "feat(core): SiteNotice type + readableTextColor/isHexColor helpers"
```

---

## Task 2: api-types `SiteNoticeSchema` + response schema

**Files:**
- Create: `packages/api-types/src/schemas/site-notice.ts`
- Create: `packages/api-types/src/schemas/site-notice.test.ts`
- Modify: `packages/api-types/src/api-types.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api-types/src/schemas/site-notice.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { SiteNoticeSchema, SiteNoticeResponseSchema } from "./site-notice";

const valid = {
  active: true,
  message: "We shipped a new feed",
  linkText: "See it",
  href: "https://releases.sh/updates",
  placement: "banner" as const,
  color: "#0081e7",
  dismissible: false,
};

describe("SiteNoticeSchema", () => {
  it("accepts a fully-specified notice", () => {
    expect(SiteNoticeSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a site-relative href and omitted link", () => {
    const { href, linkText, ...rest } = valid;
    expect(SiteNoticeSchema.safeParse({ ...rest, href: "/updates" }).success).toBe(true);
    expect(SiteNoticeSchema.safeParse(rest).success).toBe(true);
  });
  it("rejects an over-length message", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, message: "x".repeat(281) }).success).toBe(false);
  });
  it("rejects an empty message", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, message: "" }).success).toBe(false);
  });
  it("rejects a bad placement", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, placement: "footer" }).success).toBe(false);
  });
  it("rejects a non-hex color", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, color: "blue" }).success).toBe(false);
    expect(SiteNoticeSchema.safeParse({ ...valid, color: "#fff" }).success).toBe(false);
  });
  it("rejects an href that is neither absolute http(s) nor root-relative", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, href: "ftp://x.y" }).success).toBe(false);
    expect(SiteNoticeSchema.safeParse({ ...valid, href: "updates" }).success).toBe(false);
  });
});

describe("SiteNoticeResponseSchema", () => {
  it("accepts null", () => {
    expect(SiteNoticeResponseSchema.safeParse({ notice: null }).success).toBe(true);
  });
  it("accepts a stored notice with updatedAt", () => {
    const r = SiteNoticeResponseSchema.safeParse({
      notice: { ...valid, updatedAt: "2026-06-11T00:00:00.000Z" },
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/api-types/src/schemas/site-notice.test.ts`
Expected: FAIL — `Cannot find module './site-notice'`.

- [ ] **Step 3: Write the schema**

Create `packages/api-types/src/schemas/site-notice.ts`:

```ts
import { z } from "zod";
import { SITE_NOTICE_PLACEMENTS } from "@buildinternet/releases-core/site-notice";

/** Absolute http(s) URL or a site-relative path beginning with "/". */
const HrefSchema = z
  .string()
  .max(500)
  .refine((h) => /^https?:\/\//.test(h) || h.startsWith("/"), {
    message: "href must be an absolute http(s) URL or a site-relative path",
  });

/**
 * Editable site-notice payload. Kept structurally in sync with the
 * `SiteNotice` interface in `@buildinternet/releases-core/site-notice`.
 */
export const SiteNoticeSchema = z.object({
  active: z.boolean(),
  message: z.string().min(1).max(280),
  linkText: z.string().min(1).max(60).optional(),
  href: HrefSchema.optional(),
  placement: z.enum(SITE_NOTICE_PLACEMENTS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a 6-digit hex like #0081e7"),
  dismissible: z.boolean(),
});

/** GET /v1/site-notice response: the stored notice (+updatedAt) or null. */
export const SiteNoticeResponseSchema = z.object({
  notice: SiteNoticeSchema.extend({ updatedAt: z.string() }).nullable(),
});
```

- [ ] **Step 4: Re-export from the package barrel**

In `packages/api-types/src/api-types.ts`, add an export block (place it near the other `export { ... } from "./schemas/..."` lines):

```ts
export { SiteNoticeSchema, SiteNoticeResponseSchema } from "./schemas/site-notice.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/api-types/src/schemas/site-notice.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the package imports the worker will use**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api-types/src/schemas/site-notice.ts packages/api-types/src/schemas/site-notice.test.ts packages/api-types/src/api-types.ts
git commit -m "feat(api-types): SiteNoticeSchema + SiteNoticeResponseSchema"
```

---

## Task 3: D1 `site_settings` table + island + queries

**Files:**
- Create: `workers/api/migrations/20260611000000_add_site_settings.sql`
- Create: `workers/api/src/db/schema-site-settings.ts`
- Create: `workers/api/src/queries/site-settings.ts`

This task has no standalone test — the queries are exercised end-to-end by the route test in Task 4. The migration must exist first so `createTestDb()` (which applies every migration) builds the table for that test.

- [ ] **Step 1: Write the migration**

Create `workers/api/migrations/20260611000000_add_site_settings.sql`:

```sql
-- Generic site-level key/value settings. Today it holds exactly one row, under
-- key 'site_notice' (the single site-wide notice). Paired with
-- workers/api/src/db/schema-site-settings.ts. Worker-local island — not in the
-- published @buildinternet/releases-core schema.
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the Drizzle island table**

Create `workers/api/src/db/schema-site-settings.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Generic site-level key/value store. Worker-local schema island (sibling of
 * schema-follows.ts / schema-digest-prefs.ts), deliberately NOT in the
 * published `@buildinternet/releases-core` schema — operator-only config the
 * OSS CLI has no business with. Queried via explicit `.select().from(siteSettings)`
 * on a `createDb(...)` handle.
 *
 * One row per key; the only key today is `site_notice`. `updated_at` is the
 * last-write time in epoch ms (mode "timestamp_ms" → Date in JS).
 *
 * Paired migration: 20260611000000_add_site_settings.sql.
 */
export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SiteSetting = typeof siteSettings.$inferSelect;
```

- [ ] **Step 3: Write the queries**

Create `workers/api/src/queries/site-settings.ts`:

```ts
import { eq } from "drizzle-orm";
import { SITE_NOTICE_KEY, type SiteNotice, type StoredSiteNotice } from "@buildinternet/releases-core/site-notice";
import type { AnyDb } from "../db.js";
import { siteSettings } from "../db/schema-site-settings.js";

/** Read a raw setting value by key, or null when unset. */
export async function getSetting(db: AnyDb, key: string): Promise<string | null> {
  const row = await db.select().from(siteSettings).where(eq(siteSettings.key, key)).get();
  return row?.value ?? null;
}

/** Upsert a raw setting value, stamping `updated_at` to now. */
export async function setSetting(db: AnyDb, key: string, value: string): Promise<Date> {
  const now = new Date();
  await db
    .insert(siteSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: now } });
  return now;
}

/**
 * Read the stored site notice (+updatedAt), or null when unset or unparseable.
 * Fail-safe: malformed JSON yields null, never throws.
 */
export async function getStoredSiteNotice(db: AnyDb): Promise<StoredSiteNotice | null> {
  const row = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.key, SITE_NOTICE_KEY))
    .get();
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return { ...(parsed as SiteNotice), updatedAt: row.updatedAt.toISOString() };
}

/** Persist the site notice as JSON and return it stamped with the new updatedAt. */
export async function putStoredSiteNotice(
  db: AnyDb,
  notice: SiteNotice,
): Promise<StoredSiteNotice> {
  const now = await setSetting(db, SITE_NOTICE_KEY, JSON.stringify(notice));
  return { ...notice, updatedAt: now.toISOString() };
}
```

(`AnyDb` is exported from `workers/api/src/db.ts` — confirmed `export type AnyDb = BaseSQLiteDatabase<...>`.)

- [ ] **Step 4: Typecheck**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add workers/api/migrations/20260611000000_add_site_settings.sql workers/api/src/db/schema-site-settings.ts workers/api/src/queries/site-settings.ts
git commit -m "feat(api): site_settings island table + get/put site-notice queries"
```

---

## Task 4: API route module (`GET` public + `PUT` admin)

**Files:**
- Create: `workers/api/src/routes/site-notice.ts`
- Create: `tests/unit/site-notice-route.test.ts`
- Modify: `workers/api/src/route-namespaces.ts`
- Modify: `workers/api/src/v1-routes.ts`

The PUT is gated **inside the handler** via `isValidBearerAuth` (root or `admin` scope). In prod the namespace `publicReadAuthMiddleware` also fronts it (401 for anonymous mutations); the in-handler guard is the testable, authoritative check and works in isolated route tests where namespace middleware is absent.

- [ ] **Step 1: Write the failing route test**

Create `tests/unit/site-notice-route.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { siteNoticeRoutes } from "../../workers/api/src/routes/site-notice.js";
import { getStoredSiteNotice } from "../../workers/api/src/queries/site-settings.js";

let testDb: TestDatabase;

const ROOT = "root-secret";

function makeEnv(withKey = true) {
  return {
    DB: testDb.db as unknown as never,
    ...(withKey ? { RELEASES_API_KEY: { get: async () => ROOT } } : {}),
  };
}

const NOTICE = {
  active: true,
  message: "We shipped a new feed",
  linkText: "See it",
  href: "/updates",
  placement: "banner" as const,
  color: "#0081e7",
  dismissible: false,
};

function get(env: ReturnType<typeof makeEnv>, auth?: string): Promise<Response> {
  return siteNoticeRoutes.request(
    "/site-notice",
    { method: "GET", headers: auth ? { authorization: `Bearer ${auth}` } : {} },
    env,
  );
}

function put(env: ReturnType<typeof makeEnv>, body: unknown, auth?: string): Promise<Response> {
  return siteNoticeRoutes.request(
    "/site-notice",
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.cleanup();
});

describe("GET /v1/site-notice", () => {
  test("returns null when unset", async () => {
    const res = await get(makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notice: null });
  });

  test("returns the active notice to the public", async () => {
    await put(makeEnv(), NOTICE, ROOT);
    const res = await get(makeEnv());
    const body = (await res.json()) as { notice: { message: string; updatedAt: string } | null };
    expect(body.notice?.message).toBe("We shipped a new feed");
    expect(typeof body.notice?.updatedAt).toBe("string");
  });

  test("hides an inactive notice from the public but shows it to an admin", async () => {
    await put(makeEnv(), { ...NOTICE, active: false }, ROOT);
    expect(await (await get(makeEnv())).json()).toEqual({ notice: null });
    const adminRes = await get(makeEnv(), ROOT);
    const body = (await adminRes.json()) as { notice: { active: boolean } | null };
    expect(body.notice?.active).toBe(false);
  });
});

describe("PUT /v1/site-notice", () => {
  test("403 without an admin credential", async () => {
    const res = await put(makeEnv(), NOTICE);
    expect(res.status).toBe(403);
  });

  test("persists with a root credential", async () => {
    const res = await put(makeEnv(), NOTICE, ROOT);
    expect(res.status).toBe(200);
    const stored = await getStoredSiteNotice(testDb.db as never);
    expect(stored?.message).toBe("We shipped a new feed");
    expect(stored?.placement).toBe("banner");
  });

  test("400 on an invalid body (bad color)", async () => {
    const res = await put(makeEnv(), { ...NOTICE, color: "blue" }, ROOT);
    expect(res.status).toBe(400);
  });

  test("second PUT replaces the first (still one row)", async () => {
    await put(makeEnv(), NOTICE, ROOT);
    await put(makeEnv(), { ...NOTICE, message: "Second", placement: "home" }, ROOT);
    const stored = await getStoredSiteNotice(testDb.db as never);
    expect(stored?.message).toBe("Second");
    expect(stored?.placement).toBe("home");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/site-notice-route.test.ts`
Expected: FAIL — `Cannot find module '.../routes/site-notice.js'`.

- [ ] **Step 3: Write the route module**

Create `workers/api/src/routes/site-notice.ts`:

```ts
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { SiteNoticeResponseSchema, SiteNoticeSchema } from "@buildinternet/releases-api-types";
import { createDb } from "../db.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { validateJson } from "../lib/validate.js";
import { getStoredSiteNotice, putStoredSiteNotice } from "../queries/site-settings.js";

export const siteNoticeRoutes = new Hono<{ Bindings: Record<string, unknown> }>();

siteNoticeRoutes.get(
  "/site-notice",
  describeRoute({
    tags: ["Site"],
    summary: "Current site-wide notice",
    description:
      "Returns the single active site notice, or `{ notice: null }` when none is published. An admin Bearer additionally sees a stored-but-inactive (draft) notice.",
    responses: {
      200: {
        description: "The current notice or null",
        content: { "application/json": { schema: resolver(SiteNoticeResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB as D1Database);
    const notice = await getStoredSiteNotice(db);
    // Public callers only see an active notice; admins also see drafts so the
    // admin form can load an unpublished notice for editing.
    if (!notice || (!notice.active && !(await isValidBearerAuth(c as never)))) {
      return c.json({ notice: null });
    }
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ notice });
  },
);

siteNoticeRoutes.put(
  "/site-notice",
  describeRoute({
    tags: ["Site"],
    summary: "Publish or update the site-wide notice",
    description: "Admin only. Upserts the single site notice. Set `active: false` to hide it.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "The stored notice", content: { "application/json": { schema: resolver(SiteNoticeResponseSchema) } } },
      403: { description: "Caller lacks admin scope" },
    },
  }),
  // In-handler admin guard: root key or a token with `admin` scope. Runs even in
  // isolated route tests where the namespace auth middleware is absent.
  async (c, next) => {
    if (!(await isValidBearerAuth(c as never))) {
      return c.json({ error: "forbidden", message: "Admin scope required." }, 403);
    }
    await next();
  },
  validateJson(SiteNoticeSchema),
  async (c) => {
    const db = createDb(c.env.DB as D1Database);
    const notice = await putStoredSiteNotice(db, c.req.valid("json"));
    return c.json({ notice });
  },
);
```

> Note on the `Hono` generic: match the type the sibling route modules use. If `workers/api/src/routes/stats.ts` declares `new Hono<Env>()` with an imported `Env`, import that same `Env` type here and use `new Hono<Env>()` instead of the inline `Bindings` generic, and drop the `as D1Database` / `as never` casts. Verify by opening `stats.ts` line 1-20 and copying its `Env` import.

- [ ] **Step 4: Register the namespace + mount the routes**

In `workers/api/src/route-namespaces.ts`, add `"site-notice"` to the `publicReadRoutes` array (after `"changelog"`):

```ts
  "changelog",
  // /site-notice: public GET (active notice, cached). PUT is admin-gated inside
  // the handler (isValidBearerAuth) on top of the namespace write gate.
  "site-notice",
] as const;
```

In `workers/api/src/v1-routes.ts`, import and mount it. Add the import near the other route imports and the mount inside `mountV1Routes` (anywhere in the list — e.g. after `v1.route("/", statsRoutes);`):

```ts
import { siteNoticeRoutes } from "./routes/site-notice.js";
```
```ts
  v1.route("/", statsRoutes);
  v1.route("/", siteNoticeRoutes);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/site-notice-route.test.ts`
Expected: PASS (9 assertions).

- [ ] **Step 6: Run the OpenAPI coverage gate**

Run: `bun scripts/check-openapi-coverage.ts`
Expected: exit 0. Both `GET /site-notice` and `PUT /site-notice` carry `describeRoute(...)`, so no ALLOWLIST edit is needed. If the gate reports `PUT /site-notice` as a hole, add `"PUT /site-notice"` to the `ALLOWLIST` set in `scripts/check-openapi-coverage.ts` with a comment, then re-run.

- [ ] **Step 7: Typecheck + commit**

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no errors.

```bash
git add workers/api/src/routes/site-notice.ts tests/unit/site-notice-route.test.ts workers/api/src/route-namespaces.ts workers/api/src/v1-routes.ts
git commit -m "feat(api): GET/PUT /v1/site-notice routes (public read, admin write)"
```

---

## Task 5: Web reader + slot selector + admin flag

**Files:**
- Modify: `web/src/lib/api.ts`
- Create: `web/src/lib/site-notice.ts`
- Create: `web/src/lib/site-notice.test.ts`
- Create: `web/src/lib/site-notice-admin-flag.ts`

- [ ] **Step 1: Write the failing test for the pure selector**

Create `web/src/lib/site-notice.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { selectNoticeForSlot } from "./site-notice";
import type { StoredSiteNotice } from "@buildinternet/releases-core/site-notice";

const base: StoredSiteNotice = {
  active: true,
  message: "Hi",
  placement: "banner",
  color: "#0081e7",
  dismissible: false,
  updatedAt: "2026-06-11T00:00:00.000Z",
};

describe("selectNoticeForSlot", () => {
  it("returns the notice when placement matches the slot", () => {
    expect(selectNoticeForSlot(base, "banner")).toEqual(base);
    expect(selectNoticeForSlot({ ...base, placement: "home" }, "home")?.message).toBe("Hi");
  });
  it("returns null when placement does not match the slot", () => {
    expect(selectNoticeForSlot(base, "home")).toBeNull();
    expect(selectNoticeForSlot({ ...base, placement: "home" }, "banner")).toBeNull();
  });
  it("returns null for an inactive or missing notice", () => {
    expect(selectNoticeForSlot({ ...base, active: false }, "banner")).toBeNull();
    expect(selectNoticeForSlot(null, "banner")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/lib/site-notice.test.ts`
Expected: FAIL — `Cannot find module './site-notice'`.

- [ ] **Step 3: Add the low-level fetch to `web/src/lib/api.ts`**

In `web/src/lib/api.ts`, add a `siteNotice` method inside the exported `api` object (e.g. right after `stats:`). It uses the private `fetchApi` already defined in the file:

```ts
  siteNotice: () =>
    fetchApi<{ notice: import("@buildinternet/releases-core/site-notice").StoredSiteNotice | null }>(
      "/v1/site-notice",
      { next: { revalidate: 60 } },
    ),
```

- [ ] **Step 4: Write the reader + selector**

Create `web/src/lib/site-notice.ts`:

```ts
import type { StoredSiteNotice, SiteNoticePlacement } from "@buildinternet/releases-core/site-notice";
import { api } from "./api";

/**
 * Read the current public site notice, failing OPEN: any error (API down, 404,
 * malformed) yields null so a banner hiccup never breaks a page render. Cached
 * by the underlying `fetchApi` (~60s ISR), so a published change appears within
 * about a minute.
 */
export async function getSiteNotice(): Promise<StoredSiteNotice | null> {
  try {
    const { notice } = await api.siteNotice();
    return notice;
  } catch {
    return null;
  }
}

/**
 * Pure gate: return the notice only when it is active and its placement matches
 * the render slot (slot values equal placement values). Drives both mount points.
 */
export function selectNoticeForSlot(
  notice: StoredSiteNotice | null,
  slot: SiteNoticePlacement,
): StoredSiteNotice | null {
  if (!notice || !notice.active) return null;
  return notice.placement === slot ? notice : null;
}
```

- [ ] **Step 5: Write the admin flag**

Create `web/src/lib/site-notice-admin-flag.ts`:

```ts
import "server-only";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

/**
 * Gate for the site-notice admin page — the same dev-only signal as the rest of
 * the local admin surface (non-production + a configured admin Bearer). Server
 * actions re-check it so a stray invocation in production cannot publish.
 */
export function isSiteNoticeAdminEnabled(): boolean {
  return isLocalAdminEnabled();
}
```

- [ ] **Step 6: Run the test + typecheck**

Run: `bun test web/src/lib/site-notice.test.ts`
Expected: PASS.

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/site-notice.ts web/src/lib/site-notice.test.ts web/src/lib/site-notice-admin-flag.ts
git commit -m "feat(web): site-notice reader (fail-open), slot selector, admin flag"
```

---

## Task 6: Web server actions (read raw + publish)

**Files:**
- Create: `web/src/app/actions/site-notice.ts`

No unit test (server actions need a live API + admin key; covered by manual verification in Task 11). Mirrors `setOrgNoticeAction` exactly for the gate + fetch + error shape.

- [ ] **Step 1: Write the actions**

Create `web/src/app/actions/site-notice.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import type { SiteNotice, StoredSiteNotice } from "@buildinternet/releases-core/site-notice";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Read the stored notice (including a draft `active: false`) using the admin
 * Bearer, so the form can edit an unpublished notice. Returns null when unset
 * or the gate is closed.
 */
export async function getSiteNoticeAdminAction(): Promise<StoredSiteNotice | null> {
  const env = adminActionEnv();
  if ("error" in env) return null;
  try {
    const res = await fetch(`${env.apiUrl}/v1/site-notice`, {
      headers: webApiHeaders({ Authorization: `Bearer ${env.apiSecret}` }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { notice: StoredSiteNotice | null };
    return body.notice;
  } catch {
    return null;
  }
}

/** Publish/update the site notice via PUT /v1/site-notice (admin Bearer). */
export async function setSiteNoticeAction(notice: SiteNotice): Promise<ActionResult> {
  const env = adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/site-notice`, {
      method: "PUT",
      headers: webApiHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiSecret}`,
      }),
      body: JSON.stringify(notice),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }

  // The banner renders in the root layout (every route) and the card on the home
  // page — bust both. (Prod web cache picks up via the ~60s ISR window.)
  revalidatePath("/", "layout");
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

```bash
git add web/src/app/actions/site-notice.ts
git commit -m "feat(web): site-notice server actions (admin read + publish)"
```

---

## Task 7: Presentational view + server wrapper

**Files:**
- Create: `web/src/components/site-notice-view.tsx`
- Create: `web/src/components/site-notice.tsx`

- [ ] **Step 1: Write the client presentational component**

Create `web/src/components/site-notice-view.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readableTextColor, type StoredSiteNotice } from "@buildinternet/releases-core/site-notice";

const DISMISS_KEY = "releases:site-notice-dismissed";

/**
 * Renders the site notice as a thin top banner (variant "banner") or a home
 * card (variant "card"). The background is the notice's hex color; the text
 * color is auto-derived for contrast. When `dismissible`, a close button hides
 * it and persists the current `updatedAt` in localStorage, so editing/publishing
 * a fresh notice re-shows it to everyone.
 */
export function SiteNoticeView({
  notice,
  variant,
}: {
  notice: StoredSiteNotice;
  variant: "banner" | "card";
}) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!notice.dismissible) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === notice.updatedAt) setDismissed(true);
    } catch {
      /* localStorage blocked — show the notice */
    }
  }, [notice.dismissible, notice.updatedAt]);

  if (dismissed) return null;

  const fg = readableTextColor(notice.color);
  const link =
    notice.href != null ? (
      notice.href.startsWith("/") ? (
        <Link href={notice.href} className="font-semibold underline underline-offset-2 hover:no-underline">
          {notice.linkText ?? notice.href}
        </Link>
      ) : (
        <a
          href={notice.href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold underline underline-offset-2 hover:no-underline"
        >
          {notice.linkText ?? notice.href}
        </a>
      )
    ) : null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, notice.updatedAt);
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  const isBanner = variant === "banner";
  return (
    <div
      role="status"
      style={{ backgroundColor: notice.color, color: fg }}
      className={
        isBanner
          ? "relative flex w-full items-center justify-center gap-2 px-4 py-1.5 text-center text-[13px]"
          : "mx-auto flex max-w-5xl items-center justify-between gap-3 rounded-md px-4 py-3 text-sm"
      }
    >
      <span>
        {notice.message}
        {link && <> {link}</>}
      </span>
      {notice.dismissible && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notice"
          style={{ color: fg }}
          className={`shrink-0 opacity-70 transition hover:opacity-100 ${isBanner ? "absolute right-3" : ""}`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      )}
    </div>
  );
}
```

> The banner container already includes `relative` so the dismiss button's `absolute right-3` anchors to it. The card variant places the dismiss button inline (flex), so the `absolute right-3` class is appended only in the banner case via the template literal.

- [ ] **Step 2: Write the server wrapper**

Create `web/src/components/site-notice.tsx`:

```tsx
import type { SiteNoticePlacement } from "@buildinternet/releases-core/site-notice";
import { getSiteNotice, selectNoticeForSlot } from "@/lib/site-notice";
import { SiteNoticeView } from "./site-notice-view";

/**
 * Server wrapper mounted in two places: the root layout (`slot="banner"`) and
 * the home page (`slot="home"`). Fetches the current notice (fail-open) and
 * renders the view only when the notice's placement matches this slot.
 */
export async function SiteNotice({ slot }: { slot: SiteNoticePlacement }) {
  const notice = selectNoticeForSlot(await getSiteNotice(), slot);
  if (!notice) return null;
  return <SiteNoticeView notice={notice} variant={slot === "banner" ? "banner" : "card"} />;
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

```bash
git add web/src/components/site-notice-view.tsx web/src/components/site-notice.tsx
git commit -m "feat(web): SiteNoticeView (banner/card + dismiss) and server wrapper"
```

---

## Task 8: Mount the banner + card

**Files:**
- Modify: `web/src/app/layout.tsx`
- Modify: `web/src/app/page.tsx`

- [ ] **Step 1: Mount the banner in the root layout**

In `web/src/app/layout.tsx`, add the import and render `<SiteNotice slot="banner" />` as the first child inside `<main id="main">`, before `{children}`:

```tsx
import { SiteNotice } from "@/components/site-notice";
```
```tsx
                <main id="main" className="flex-1 flex flex-col">
                  <SiteNotice slot="banner" />
                  {children}
                </main>
```

(`RootLayout` is already an async server component, and `<SiteNotice>` awaits internally — no other change needed.)

- [ ] **Step 2: Mount the card on the home page**

In `web/src/app/page.tsx`, add the import and render `<SiteNotice slot="home" />` between the masthead band's closing `</div>` and the "Get Started" install widget block (i.e. right after the `</div>` that closes the `relative` masthead wrapper, currently around line 364):

```tsx
import { SiteNotice } from "@/components/site-notice";
```
```tsx
      </div>
      {/* Home-only site notice (card placement). Renders nothing unless an
          active notice is set to placement "home". */}
      <div className="px-6 pt-6">
        <SiteNotice slot="home" />
      </div>
      {/* "Get Started" install widget — kept below the animated masthead band ... */}
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

```bash
git add web/src/app/layout.tsx web/src/app/page.tsx
git commit -m "feat(web): mount site-notice banner (layout) and card (home)"
```

---

## Task 9: Admin hub + site-notice admin page + form

**Files:**
- Create: `web/src/app/admin/page.tsx`
- Create: `web/src/app/admin/site-notice/page.tsx`
- Create: `web/src/app/admin/site-notice/notice-form.tsx`

- [ ] **Step 1: Write the admin hub index**

Create `web/src/app/admin/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

export const metadata: Metadata = { title: "Admin" };

const TOOLS = [
  { href: "/admin/site-notice", title: "Site notice", desc: "Publish a site-wide banner or home-page card." },
  { href: "/admin/status", title: "Status", desc: "Live fetch-log + system status dashboard." },
  { href: "/admin/api-tokens", title: "API tokens", desc: "Mint and revoke scoped API tokens." },
];

export default function AdminHubPage() {
  if (!isLocalAdminEnabled()) notFound();
  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-12">
        <h1 className="mb-6 text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
          Admin
        </h1>
        <ul className="grid gap-3 sm:grid-cols-2">
          {TOOLS.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                className="block border border-stone-200 p-4 transition hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"
              >
                <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">
                  {t.title}
                </span>
                <span className="mt-1 block text-[13px] text-stone-500 dark:text-stone-400">
                  {t.desc}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the admin notice page (gate + load)**

Create `web/src/app/admin/site-notice/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { isSiteNoticeAdminEnabled } from "@/lib/site-notice-admin-flag";
import { getSiteNoticeAdminAction } from "@/app/actions/site-notice";
import { NoticeForm } from "./notice-form";

export const metadata: Metadata = { title: "Site notice" };

export default async function SiteNoticeAdminPage() {
  if (!isSiteNoticeAdminEnabled()) notFound();
  const current = await getSiteNoticeAdminAction();
  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-2xl mx-auto px-6 pt-8 pb-12">
        <h1 className="mb-6 text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
          Site notice
        </h1>
        <NoticeForm current={current} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the form**

Create `web/src/app/admin/site-notice/notice-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import {
  DEFAULT_SITE_NOTICE_COLOR,
  isHexColor,
  type SiteNotice,
  type StoredSiteNotice,
} from "@buildinternet/releases-core/site-notice";
import { SiteNoticeView } from "@/components/site-notice-view";
import { setSiteNoticeAction } from "@/app/actions/site-notice";

const PRESETS: { label: string; color: string }[] = [
  { label: "Info", color: "#0081e7" },
  { label: "Success", color: "#16a34a" },
  { label: "Warning", color: "#d97706" },
  { label: "Danger", color: "#dc2626" },
  { label: "Neutral", color: "#44403c" },
];

const inputClass =
  "w-full border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

export function NoticeForm({ current }: { current: StoredSiteNotice | null }) {
  const [active, setActive] = useState(current?.active ?? false);
  const [message, setMessage] = useState(current?.message ?? "");
  const [linkText, setLinkText] = useState(current?.linkText ?? "");
  const [href, setHref] = useState(current?.href ?? "");
  const [placement, setPlacement] = useState<SiteNotice["placement"]>(current?.placement ?? "banner");
  const [color, setColor] = useState(current?.color ?? DEFAULT_SITE_NOTICE_COLOR);
  const [dismissible, setDismissible] = useState(current?.dismissible ?? false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const colorValid = isHexColor(color);
  const canSave = message.trim().length > 0 && message.length <= 280 && colorValid && !saving;

  const preview: StoredSiteNotice = {
    active: true,
    message: message || "Your notice preview",
    linkText: linkText || undefined,
    href: href || undefined,
    placement,
    color: colorValid ? color : DEFAULT_SITE_NOTICE_COLOR,
    dismissible,
    updatedAt: "preview",
  };

  async function onSave() {
    setSaving(true);
    setResult(null);
    const notice: SiteNotice = {
      active,
      message: message.trim(),
      linkText: linkText.trim() || undefined,
      href: href.trim() || undefined,
      placement,
      color,
      dismissible,
    };
    const res = await setSiteNoticeAction(notice);
    setResult(res.ok ? "Saved." : res.error);
    setSaving(false);
  }

  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active (visible to visitors)
      </label>

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Message ({message.length}/280)
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value.slice(0, 280))}
          rows={2}
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Link text
          </label>
          <input value={linkText} onChange={(e) => setLinkText(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Link URL (https://… or /path)
          </label>
          <input value={href} onChange={(e) => setHref(e.target.value)} className={inputClass} />
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Placement
        </span>
        <div className="flex gap-4 text-sm text-stone-700 dark:text-stone-200">
          {(["banner", "home"] as const).map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input
                type="radio"
                name="placement"
                checked={placement === p}
                onChange={() => setPlacement(p)}
              />
              {p === "banner" ? "Top banner" : "Home card"}
            </label>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Color
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.color}
              type="button"
              onClick={() => setColor(p.color)}
              title={p.label}
              aria-label={p.label}
              style={{ backgroundColor: p.color }}
              className={`h-7 w-7 rounded-full border-2 ${color === p.color ? "border-stone-900 dark:border-stone-100" : "border-transparent"}`}
            />
          ))}
          <input
            value={color}
            onChange={(e) => setColor(e.target.value)}
            spellCheck={false}
            className={`ml-2 w-28 ${inputClass} ${colorValid ? "" : "border-red-500"}`}
          />
          <input
            type="color"
            value={colorValid ? color : DEFAULT_SITE_NOTICE_COLOR}
            onChange={(e) => setColor(e.target.value)}
            aria-label="Color picker"
            className="h-7 w-9 border border-stone-300 dark:border-stone-700"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200">
        <input type="checkbox" checked={dismissible} onChange={(e) => setDismissible(e.target.checked)} />
        Visitors can dismiss it
      </label>

      <div>
        <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Preview
        </span>
        <div className="border border-dashed border-stone-300 p-3 dark:border-stone-700">
          <SiteNoticeView notice={preview} variant={placement === "banner" ? "banner" : "card"} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="border border-stone-900 bg-stone-900 px-4 py-1.5 text-sm text-white transition hover:bg-stone-700 disabled:opacity-50 dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
        >
          {saving ? "Saving…" : "Save notice"}
        </button>
        {result && <span className="text-sm text-stone-600 dark:text-stone-300">{result}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

```bash
git add web/src/app/admin/page.tsx web/src/app/admin/site-notice/page.tsx web/src/app/admin/site-notice/notice-form.tsx
git commit -m "feat(web): admin hub + site-notice admin page and form"
```

---

## Task 10: Dropdown "Admin" link

**Files:**
- Modify: `web/src/components/header.tsx`
- Modify: `web/src/components/account-nav.tsx`
- Modify: `web/src/components/mobile-nav.tsx`

- [ ] **Step 1: Compute `adminEnabled` in the header and pass it down**

In `web/src/components/header.tsx`, add the import and compute the flag (the Header is a server component, so it may call the `server-only` gate):

```tsx
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
```

Inside `export function Header() {`, add as the first line:

```tsx
  const adminEnabled = isLocalAdminEnabled();
```

Pass it to both nav components:

```tsx
      <MobileNav adminEnabled={adminEnabled} />
```
```tsx
        <AccountNav adminEnabled={adminEnabled} />
```

- [ ] **Step 2: Forward the prop through `MobileNav`**

In `web/src/components/mobile-nav.tsx`, change the signature and forward the prop:

```tsx
export function MobileNav({ adminEnabled = false }: { adminEnabled?: boolean }) {
```
```tsx
              <AccountNav variant="mobile" adminEnabled={adminEnabled} />
```

- [ ] **Step 3: Render the Admin link in `AccountNav`**

In `web/src/components/account-nav.tsx`:

Update the exported wrapper signature to accept + forward `adminEnabled`:

```tsx
export function AccountNav({
  variant = "desktop",
  adminEnabled = false,
}: {
  variant?: Variant;
  adminEnabled?: boolean;
}) {
  if (!AUTH_ENABLED) return null;
  return <AccountNavInner variant={variant} adminEnabled={adminEnabled} />;
}
```

Update `AccountNavInner`'s signature:

```tsx
function AccountNavInner({ variant, adminEnabled }: { variant: Variant; adminEnabled: boolean }) {
```

In the **mobile** branch, add the Admin link right after the `Following` link (before the `USER_API_KEYS_ENABLED` block):

```tsx
        {adminEnabled && (
          <Link
            href="/admin"
            className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            Admin
          </Link>
        )}
```

In the **desktop** dropdown, add the Admin link right after the `Following` `<Link>` (before the `USER_API_KEYS_ENABLED` block):

```tsx
            {adminEnabled && (
              <Link
                href="/admin"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="mt-3 block w-full border border-stone-300 px-3 py-1.5 text-center text-sm text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
              >
                Admin
              </Link>
            )}
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no errors.

```bash
git add web/src/components/header.tsx web/src/components/account-nav.tsx web/src/components/mobile-nav.tsx
git commit -m "feat(web): Admin link in account dropdown (local-admin only)"
```

---

## Task 11: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck root + workers + web**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd web && npx tsc --noEmit)`
Expected: no errors in any.

- [ ] **Step 2: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. If `format:check` flags the new files, run `bun run format` and re-commit.

- [ ] **Step 3: Run the relevant test suites**

Run: `bun test packages/ web/src/lib/site-notice.test.ts tests/unit/site-notice-route.test.ts`
Expected: all PASS.

- [ ] **Step 4: OpenAPI coverage gate**

Run: `bun scripts/check-openapi-coverage.ts`
Expected: exit 0.

- [ ] **Step 5: Manual smoke (local, against a dev API with an admin key)**

With `dev:api` + `dev:web` running and `RELEASES_API_KEY` configured:
1. Sign in, open the account dropdown → confirm **Admin** appears → click it → `/admin` lists Site notice / Status / API tokens.
2. Open **Site notice**, set a message + placement **Top banner** + a color + Active, Save → confirm the thin banner appears across the top of every page within ~60s.
3. Switch placement to **Home card**, Save → confirm the banner disappears and a card shows on the home page only.
4. Toggle **Visitors can dismiss it** on + Save, dismiss it as a visitor, reload → stays hidden; edit the message + Save → reappears.
5. Set **Active** off + Save → notice disappears site-wide.
6. Confirm `/admin/site-notice` returns 404 when `RELEASES_API_KEY` is unset (gate closed).

- [ ] **Step 6: Final commit (if Step 2 reformatted anything)**

```bash
git add -A && git commit -m "chore(site-notice): format + lint pass"
```

---

## Self-Review notes

- **Spec coverage:** storage (Task 3) · public read + admin write (Task 4) · color preset+hex with default (Task 9 form, Task 1 helper) · dismissible config defaulting off (Tasks 1/7/9) · home-vs-banner placement (Tasks 7/8) · admin pages local-only (Tasks 9) · move admin under dropdown via `/admin` hub (Tasks 9/10) · single notice (one row, Task 3) — all mapped.
- **Auth choice:** symmetric `/v1/site-notice` GET+PUT under `publicReadRoutes`, with the PUT admin-gated in-handler via `isValidBearerAuth`. Reviewer alternative: move the write to `PUT /v1/admin/site-notice` under `adminRoutes` (auto admin-gated, gate-exempt) if symmetric-path documentation of an admin mutation is unwanted.
- **Caching:** public GET sets `Cache-Control` + the web reader uses 60s ISR; a local `revalidatePath` won't bust the prod Vercel cache, so prod reflects a change within ~a minute (accepted in the spec).
