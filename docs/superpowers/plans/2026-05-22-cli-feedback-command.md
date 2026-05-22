# `releases feedback` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `releases feedback` command that POSTs free-text feedback to a new open `/v1/feedback` endpoint, which persists it to a D1 `feedback` table and emails `zach@releases.sh`; plus an admin read-back command.

**Architecture:** Mirrors the existing telemetry path (CLI fire-to-API → D1) but foreground/awaited, with free-text caps, a rate limit, a kill switch, and a best-effort `sendEmail()` notification on `waitUntil`. Spans two repos: monorepo backend + OSS CLI commands.

**Tech Stack:** Bun, TypeScript (strict), Hono, Drizzle/D1, Cloudflare Email (`SEND_EMAIL` binding), Commander, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-22-cli-feedback-command-design.md`

**Repos / worktrees:**

- Monorepo: `/Users/zachdunn/Code/releases/.claude/worktrees/cli-feedback` (branch `worktree-cli-feedback`)
- CLI: `/Users/zachdunn/Code/releases-cli/.worktrees/cli-feedback` (branch `feat/cli-feedback`)

---

## File Structure

**Monorepo (`~/Code/releases`):**

- `packages/core/src/schema.ts` — `feedback` table, `Feedback`/`NewFeedback` types, `FEEDBACK_TYPES`.
- `packages/core/src/id.ts` — `newFeedbackId`.
- `workers/api/migrations/20260522010000_add_feedback.sql` — table + indexes.
- `workers/api/src/lib/feedback-email.ts` — `formatFeedbackEmail()` (pure) + `notifyFeedback()`.
- `workers/api/src/routes/feedback.ts` — open `POST /feedback`.
- `workers/api/src/routes/admin-feedback.ts` — admin `GET /admin/feedback`.
- `workers/api/src/v1-routes.ts` — mount both route modules.
- `workers/api/src/route-namespaces.ts` — add `"admin/feedback"` to `adminRoutes`.
- `workers/api/src/index.ts` — `Env.FEEDBACK_DISABLED`; dedicated rate-limit on `/feedback`.
- `workers/api/wrangler.jsonc` — `FEEDBACK_DISABLED: "false"` in prod + staging blocks.
- Tests: `workers/api/test/feedback.test.ts`, `workers/api/test/feedback-email.test.ts`, `workers/api/test/admin-feedback.test.ts`.

**CLI (`~/Code/releases-cli`):**

- `src/cli/commands/feedback.ts` — `registerFeedbackCommand` + `registerFeedbackAdminCommand`.
- `src/cli/program.ts` — register both.
- `tests/unit/feedback.test.ts`.
- `.changeset/cli-feedback.md`.

---

## TASKS — MONOREPO

### Task 1: `feedback` schema + id generator + types

**Files:**

- Modify: `packages/core/src/id.ts`
- Modify: `packages/core/src/schema.ts`

- [ ] **Step 1: Add the id generator.** In `packages/core/src/id.ts`, after the `newCollectionId` line, add:

```ts
export const newFeedbackId = () => `fb_${nanoid()}`;
```

- [ ] **Step 2: Add the table + types + constant.** In `packages/core/src/schema.ts`: (a) add `newFeedbackId` to the existing `@buildinternet/releases-core/id`… — actually the schema imports id helpers directly. Find the import that brings in `newTelemetryEventId` (top of file) and add `newFeedbackId` to it. Then, after the `telemetryEvents` block (ends ~line 563), add:

```ts
export const FEEDBACK_TYPES = ["bug", "idea", "other", "general"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/**
 * User-submitted CLI feedback. Distinct from `telemetry_events` (which is
 * PII-clean by contract): `feedback` intentionally carries free text and an
 * optional contact. `anon_id` is attached by the CLI only when telemetry is
 * enabled.
 */
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey().$defaultFn(newFeedbackId),
    createdAt: integer("created_at").notNull(),
    message: text("message").notNull(),
    contact: text("contact"),
    type: text("type").notNull().default("general"),
    status: text("status").notNull().default("new"),
    cliVersion: text("cli_version"),
    clientKind: text("client_kind").notNull().default("external"),
    anonId: text("anon_id"),
    os: text("os"),
    arch: text("arch"),
    runtime: text("runtime"),
    surface: text("surface").notNull().default("cli"),
  },
  (table) => [
    index("idx_feedback_created").on(table.createdAt),
    index("idx_feedback_status_created").on(table.status, table.createdAt),
    index("idx_feedback_anon").on(table.anonId),
  ],
);

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
```

- [ ] **Step 3: Type-check core.**

Run: `cd packages/core && npx tsc --noEmit; cd ../..`
Expected: no errors. (`index`, `integer`, `text`, `sqliteTable` are already imported in schema.ts.)

- [ ] **Step 4: Commit.**

```bash
git add packages/core/src/id.ts packages/core/src/schema.ts
git commit -m "feat(core): add feedback table schema + newFeedbackId"
```

---

### Task 2: Migration

**Files:**

- Create: `workers/api/migrations/20260522010000_add_feedback.sql`

- [ ] **Step 1: Write the migration** (must match the Drizzle definition exactly):

```sql
-- Feedback submitted via `releases feedback`. Open POST → /v1/feedback.
-- Distinct from telemetry_events: carries intentional free text + optional contact.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  contact TEXT,
  type TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'new',
  cli_version TEXT,
  client_kind TEXT NOT NULL DEFAULT 'external',
  anon_id TEXT,
  os TEXT,
  arch TEXT,
  runtime TEXT,
  surface TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX idx_feedback_created ON feedback (created_at);
CREATE INDEX idx_feedback_status_created ON feedback (status, created_at);
CREATE INDEX idx_feedback_anon ON feedback (anon_id);
```

- [ ] **Step 2: Verify it applies cleanly** (the test helper re-applies every migration into an in-memory sqlite):

Run: `bun test workers/api/test/usage-log.test.ts 2>&1 | tail -5`
Expected: PASS (proves the new migration file parses + applies; an invalid `CREATE TABLE` would throw in `applyMigrations`).

- [ ] **Step 3: Commit.**

```bash
git add workers/api/migrations/20260522010000_add_feedback.sql
git commit -m "feat(db): migration for feedback table"
```

---

### Task 3: Email formatter + notifier

**Files:**

- Create: `workers/api/src/lib/feedback-email.ts`
- Test: `workers/api/test/feedback-email.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from "bun:test";
import { formatFeedbackEmail } from "../src/lib/feedback-email.js";

const base = {
  id: "fb_123",
  createdAt: 1_700_000_000_000,
  message: "search ranking feels off for scoped queries",
  contact: null,
  type: "general",
  status: "new",
  cliVersion: "0.43.0",
  clientKind: "external",
  anonId: null,
  os: "darwin",
  arch: "arm64",
  runtime: "bun-1.3.13",
  surface: "cli",
};

describe("formatFeedbackEmail", () => {
  it("prefixes the subject with [feedback] and the type", () => {
    const { subject } = formatFeedbackEmail(base);
    expect(subject.startsWith("[feedback] general:")).toBe(true);
    expect(subject).toContain("search ranking feels off");
  });

  it("truncates long messages in the subject", () => {
    const long = "x".repeat(200);
    const { subject } = formatFeedbackEmail({ ...base, message: long });
    expect(subject.length).toBeLessThan(120);
  });

  it("renders contact as (none) when absent and includes the id", () => {
    const { text } = formatFeedbackEmail(base);
    expect(text).toContain("Contact: (none)");
    expect(text).toContain("fb_123");
    expect(text).toContain(base.message);
  });

  it("includes the contact when present", () => {
    const { text } = formatFeedbackEmail({ ...base, contact: "zach@example.com" });
    expect(text).toContain("Contact: zach@example.com");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found).

Run: `bun test workers/api/test/feedback-email.test.ts 2>&1 | tail -8`
Expected: FAIL — cannot resolve `feedback-email.js`.

- [ ] **Step 3: Implement.**

```ts
/**
 * Pure formatter + thin sender for the feedback-arrival notification.
 * `notifyFeedback` is fire-and-forget (never throws) so a mail failure can't
 * fail the submit — callers invoke it via `c.executionCtx.waitUntil(...)`.
 */
import { sendEmail, type EmailEnv } from "./email.js";
import { logEvent } from "@releases/lib/log-event";
import type { Feedback } from "@buildinternet/releases-core/schema";

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatFeedbackEmail(row: Feedback): { subject: string; text: string } {
  const subject = `[feedback] ${row.type}: ${truncate(row.message, 60)}`;
  const text = [
    row.message,
    "",
    "—",
    `Contact: ${row.contact ?? "(none)"}`,
    `Type: ${row.type}`,
    `ID: ${row.id}`,
    `CLI: ${row.cliVersion ?? "(unknown)"}`,
    `Client: ${row.clientKind}`,
    `Env: ${row.os ?? "?"}/${row.arch ?? "?"} ${row.runtime ?? "?"}`,
    `Anon: ${row.anonId ?? "(omitted)"}`,
    `Received: ${new Date(row.createdAt).toISOString()}`,
  ].join("\n");
  return { subject, text };
}

export async function notifyFeedback(env: EmailEnv, row: Feedback): Promise<void> {
  const { subject, text } = formatFeedbackEmail(row);
  try {
    const result = await sendEmail(env, { subject, text });
    if (!result.sent) {
      logEvent("info", {
        component: "feedback",
        event: "notify-skipped",
        reason: result.reason,
        id: row.id,
      });
    } else {
      logEvent("info", { component: "feedback", event: "notify-sent", id: row.id });
    }
  } catch (err) {
    logEvent("warn", { component: "feedback", event: "notify-error", id: row.id, err });
  }
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `bun test workers/api/test/feedback-email.test.ts 2>&1 | tail -8`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add workers/api/src/lib/feedback-email.ts workers/api/test/feedback-email.test.ts
git commit -m "feat(api): feedback email formatter + notifier"
```

---

### Task 4: `POST /v1/feedback` route

**Files:**

- Create: `workers/api/src/routes/feedback.ts`
- Test: `workers/api/test/feedback.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { feedback } from "@buildinternet/releases-core/schema";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

async function makeApp(db: ReturnType<typeof mkDb>, env: Record<string, unknown> = {}) {
  const { Hono } = await import("hono");
  const { feedbackRoutes } = await import("../src/routes/feedback.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", feedbackRoutes);
  app.route("/v1", v1);
  // executionCtx.waitUntil shim so the route's waitUntil call is harmless.
  const fakeEnv = { DB: db, SEND_EMAIL: undefined, ...env };
  return (req: Request) =>
    app.fetch(req, fakeEnv, { waitUntil() {}, passThroughOnException() {} } as any);
}

function post(body: unknown) {
  return new Request("http://x/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/feedback", () => {
  it("stores valid feedback and returns 202 + id", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(
      post({ message: "scoped search misses obvious hits", type: "bug", cliVersion: "0.43.0" }),
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id.startsWith("fb_")).toBe(true);
    const rows = await db.select().from(feedback);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe("scoped search misses obvious hits");
    expect(rows[0]!.type).toBe("bug");
  });

  it("defaults an omitted type to general", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    await fetch(post({ message: "just a general note here" }));
    const rows = await db.select().from(feedback);
    expect(rows[0]!.type).toBe("general");
  });

  it("rejects an empty/short message with 400", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(post({ message: "hi" }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(
      new Request("http://x/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 503 when FEEDBACK_DISABLED=true", async () => {
    const db = mkDb();
    const fetch = await makeApp(db, { FEEDBACK_DISABLED: "true" });
    const res = await fetch(post({ message: "this should not be stored" }));
    expect(res.status).toBe(503);
    const rows = await db.select().from(feedback);
    expect(rows).toHaveLength(0);
  });

  it("caps an over-long message and coerces an unknown type to general", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    await fetch(post({ message: "y".repeat(5000), type: "nonsense" }));
    const rows = await db.select().from(feedback);
    expect(rows[0]!.message.length).toBe(4000);
    expect(rows[0]!.type).toBe("general");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found).

Run: `bun test workers/api/test/feedback.test.ts 2>&1 | tail -8`
Expected: FAIL — cannot resolve `feedback.js`.

- [ ] **Step 3: Implement the route.**

```ts
/**
 * Open, unauthenticated POST /v1/feedback — mirrors /v1/telemetry but carries
 * intentional free text. Mounted in v1-routes.ts; rate-limited + kill-switched
 * in index.ts. Persists to D1 and fires a best-effort email via waitUntil.
 */
import { Hono } from "hono";
import {
  feedback,
  FEEDBACK_TYPES,
  TELEMETRY_CLIENT_KINDS,
} from "@buildinternet/releases-core/schema";
import { newFeedbackId } from "@buildinternet/releases-core/id";
import { createDb } from "../db.js";
import { sanitizeString } from "../lib/sanitize.js";
import { notifyFeedback } from "../lib/feedback-email.js";
import type { Env } from "../index.js";

export const feedbackRoutes = new Hono<Env>();

const MIN_MESSAGE = 5;
const MAX_MESSAGE = 4000;
const MAX_CONTACT = 200;

function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

function coerceType(v: unknown): string {
  return typeof v === "string" && (FEEDBACK_TYPES as readonly string[]).includes(v) ? v : "general";
}

function coerceClientKind(v: unknown): string {
  return typeof v === "string" && (TELEMETRY_CLIENT_KINDS as readonly string[]).includes(v)
    ? v
    : "external";
}

feedbackRoutes.post("/feedback", async (c) => {
  if (c.env.FEEDBACK_DISABLED === "true") {
    return c.json({ error: "feedback_disabled" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const message = sanitizeString(body.message, MAX_MESSAGE);
  if (!message || message.length < MIN_MESSAGE) {
    return c.json({ error: "message_required" }, 400);
  }

  const db = getDb(c);
  const row = {
    id: newFeedbackId(),
    createdAt: Date.now(),
    message,
    contact: sanitizeString(body.contact, MAX_CONTACT),
    type: coerceType(body.type),
    status: "new",
    cliVersion: sanitizeString(body.cliVersion, 32),
    clientKind: coerceClientKind(body.clientKind),
    anonId: sanitizeString(body.anonId, 64),
    os: sanitizeString(body.os, 64),
    arch: sanitizeString(body.arch, 64),
    runtime: sanitizeString(body.runtime, 64),
    surface: sanitizeString(body.surface, 32) ?? "cli",
  };

  await db.insert(feedback).values(row);

  c.executionCtx.waitUntil(notifyFeedback(c.env, row as any));

  return c.json({ ok: true, id: row.id }, 202);
});
```

- [ ] **Step 4: Run — expect PASS.**

Run: `bun test workers/api/test/feedback.test.ts 2>&1 | tail -10`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add workers/api/src/routes/feedback.ts workers/api/test/feedback.test.ts
git commit -m "feat(api): POST /v1/feedback route"
```

---

### Task 5: `GET /v1/admin/feedback` route

**Files:**

- Create: `workers/api/src/routes/admin-feedback.ts`
- Test: `workers/api/test/admin-feedback.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { feedback } from "@buildinternet/releases-core/schema";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

async function makeApp(db: ReturnType<typeof mkDb>) {
  const { Hono } = await import("hono");
  const { adminFeedbackRoutes } = await import("../src/routes/admin-feedback.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", adminFeedbackRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db });
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(feedback).values([
    {
      id: "fb_1",
      createdAt: 1000,
      message: "first",
      type: "bug",
      status: "new",
      clientKind: "external",
      surface: "cli",
    },
    {
      id: "fb_2",
      createdAt: 2000,
      message: "second",
      type: "idea",
      status: "new",
      clientKind: "external",
      surface: "cli",
    },
    {
      id: "fb_3",
      createdAt: 3000,
      message: "third",
      type: "bug",
      status: "triaged",
      clientKind: "external",
      surface: "cli",
    },
  ]);
}

describe("GET /v1/admin/feedback", () => {
  it("returns rows newest-first", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/feedback"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(json.items.map((r) => r.id)).toEqual(["fb_3", "fb_2", "fb_1"]);
  });

  it("filters by status and type", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/feedback?status=new&type=bug"));
    const json = (await res.json()) as { items: { id: string }[] };
    expect(json.items.map((r) => r.id)).toEqual(["fb_1"]);
  });

  it("paginates via limit + cursor", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const first = (await (
      await fetch(new Request("http://x/v1/admin/feedback?limit=2"))
    ).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.items.map((r) => r.id)).toEqual(["fb_3", "fb_2"]);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await fetch(new Request(`http://x/v1/admin/feedback?limit=2&cursor=${first.nextCursor}`))
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(second.items.map((r) => r.id)).toEqual(["fb_1"]);
    expect(second.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `bun test workers/api/test/admin-feedback.test.ts 2>&1 | tail -8`
Expected: FAIL — cannot resolve `admin-feedback.js`.

- [ ] **Step 3: Implement.** Cursor is the opaque `createdAt:id` of the last returned row (base64url), matching the feed-shaped cursor convention. Strictly-older comparison `(createdAt, id) < cursor` keeps it stable.

```ts
/**
 * Admin-only read-back for submitted feedback. Gated by authMiddleware via the
 * "admin/feedback" entry in route-namespaces.ts. Cursor-paginated, newest
 * first; optional ?status= and ?type= filters.
 */
import { Hono } from "hono";
import { and, eq, or, lt, desc, type SQL } from "drizzle-orm";
import { feedback, FEEDBACK_TYPES } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminFeedbackRoutes = new Hono<Env>();

const FEEDBACK_STATUSES = ["new", "triaged", "closed"] as const;

function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 50, 200));
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`).toString("base64url");
}

function decodeCursor(raw: string | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null;
  try {
    const [ts, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split(":");
    const createdAt = parseInt(ts ?? "", 10);
    const id = rest.join(":");
    if (!Number.isFinite(createdAt) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

adminFeedbackRoutes.get("/admin/feedback", async (c) => {
  const db = getDb(c);
  const limit = parseLimit(c.req.query("limit"));

  const status = c.req.query("status");
  const type = c.req.query("type");
  const conditions: SQL[] = [];
  if (status && (FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    conditions.push(eq(feedback.status, status));
  }
  if (type && (FEEDBACK_TYPES as readonly string[]).includes(type)) {
    conditions.push(eq(feedback.type, type));
  }

  const cursor = decodeCursor(c.req.query("cursor"));
  if (cursor) {
    // (createdAt, id) strictly less than the cursor — newest-first paging.
    conditions.push(
      or(
        lt(feedback.createdAt, cursor.createdAt),
        and(eq(feedback.createdAt, cursor.createdAt), lt(feedback.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(feedback)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return c.json({ items, nextCursor });
});
```

- [ ] **Step 4: Run — expect PASS.**

Run: `bun test workers/api/test/admin-feedback.test.ts 2>&1 | tail -10`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add workers/api/src/routes/admin-feedback.ts workers/api/test/admin-feedback.test.ts
git commit -m "feat(api): GET /v1/admin/feedback admin read-back"
```

---

### Task 6: Wire mounts, namespace, env, rate limit, wrangler

**Files:**

- Modify: `workers/api/src/v1-routes.ts`
- Modify: `workers/api/src/route-namespaces.ts`
- Modify: `workers/api/src/index.ts`
- Modify: `workers/api/wrangler.jsonc`

- [ ] **Step 1: Import + mount both route modules in `v1-routes.ts`.** Add imports next to the `telemetryRoutes` import:

```ts
import { feedbackRoutes } from "./routes/feedback.js";
import { adminFeedbackRoutes } from "./routes/admin-feedback.js";
```

And mount lines next to `v1.route("/", telemetryRoutes);`:

```ts
v1.route("/", feedbackRoutes);
v1.route("/", adminFeedbackRoutes);
```

- [ ] **Step 2: Add the admin namespace.** In `workers/api/src/route-namespaces.ts`, add to the `adminRoutes` array (e.g. after `"admin/search-queries"`):

```ts
  "admin/feedback",
```

- [ ] **Step 3: Add `FEEDBACK_DISABLED` to the `Env` type + rate-limit `/feedback`.** In `workers/api/src/index.ts`: add the field near the other `EMAIL_*`/string env fields in the `Env` `Bindings`:

```ts
    FEEDBACK_DISABLED?: string;
```

Then, after the `publicReadRoutes`/`adminRoutes` middleware loops and near the existing `v1.use("/graphql", publicRateLimitMiddleware, dbHealthCheck);` line (~line 399), add a dedicated rate-limit + health gate for the open feedback POST:

```ts
// /feedback is an open POST (like /telemetry) but carries free text — rate
// limit it. dbHealthCheck guards the D1 insert.
v1.use("/feedback", publicRateLimitMiddleware, dbHealthCheck);
```

- [ ] **Step 4: Add the wrangler var.** In `workers/api/wrangler.jsonc`, in the top-level `vars` block near `EMAIL_NOTIFY_ENABLED`, add:

```jsonc
    // Kill switch for the open POST /v1/feedback endpoint (releases feedback).
    "FEEDBACK_DISABLED": "false",
```

And add the same line to the `[env.staging]` `vars` block (search for the second `EMAIL_NOTIFY_TO` occurrence ~line 394 and add `FEEDBACK_DISABLED` alongside).

- [ ] **Step 5: Verify OpenAPI coverage gate still passes** (feedback is outside it, like telemetry — this confirms no accidental `publicReadRoutes` membership):

Run: `bun scripts/check-openapi-coverage.ts 2>&1 | tail -5`
Expected: passes / no new uncovered route errors.

- [ ] **Step 6: Type-check the API worker.**

Run: `cd workers/api && npx tsc --noEmit; cd ../..`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add workers/api/src/v1-routes.ts workers/api/src/route-namespaces.ts workers/api/src/index.ts workers/api/wrangler.jsonc
git commit -m "feat(api): mount feedback routes, namespace, kill switch + rate limit"
```

---

### Task 7: Monorepo gates

- [ ] **Step 1: Root type-check.** Run: `npx tsc --noEmit` — Expected: clean.
- [ ] **Step 2: Full API tests.** Run: `bun test workers/api/test/feedback.test.ts workers/api/test/feedback-email.test.ts workers/api/test/admin-feedback.test.ts 2>&1 | tail -15` — Expected: all PASS.
- [ ] **Step 3: Lint.** Run: `bun run lint 2>&1 | tail -15` — Expected: clean (fix any oxlint findings in the new files).
- [ ] **Step 4: Format.** Run: `bun run format 2>&1 | tail -3` then `git add -A && git commit -m "chore: format" --allow-empty` if anything changed.

---

## TASKS — CLI

> Work in `/Users/zachdunn/Code/releases-cli/.worktrees/cli-feedback` (branch `feat/cli-feedback`). Deps already installed.

### Task 8: `releases feedback` submit command

**Files:**

- Create: `src/cli/commands/feedback.ts`
- Test: `tests/unit/feedback.test.ts`

- [ ] **Step 1: Write the failing test** (pure helpers — text resolution + validation + payload build, no network):

```ts
import { describe, it, expect } from "bun:test";
import { validateMessage, buildFeedbackPayload } from "../../src/cli/commands/feedback";

describe("validateMessage", () => {
  it("rejects messages shorter than 5 chars", () => {
    expect(validateMessage("hi")).toEqual({ ok: false, error: expect.stringContaining("short") });
  });
  it("rejects messages longer than 4000 chars", () => {
    expect(validateMessage("x".repeat(4001))).toEqual({
      ok: false,
      error: expect.stringContaining("long"),
    });
  });
  it("trims and accepts a valid message", () => {
    expect(validateMessage("  good feedback here  ")).toEqual({
      ok: true,
      message: "good feedback here",
    });
  });
});

describe("buildFeedbackPayload", () => {
  it("includes enrichment and the message + type", () => {
    const p = buildFeedbackPayload(
      "hello world",
      { type: "bug", contact: "me@x.com" },
      { telemetryEnabled: true, anonId: "anon-1" },
    );
    expect(p.message).toBe("hello world");
    expect(p.type).toBe("bug");
    expect(p.contact).toBe("me@x.com");
    expect(p.surface).toBe("cli");
    expect(p.anonId).toBe("anon-1");
    expect(typeof p.cliVersion).toBe("string");
    expect(typeof p.os).toBe("string");
  });
  it("omits anonId when telemetry is disabled", () => {
    const p = buildFeedbackPayload(
      "hello world",
      {},
      { telemetryEnabled: false, anonId: "anon-1" },
    );
    expect(p.anonId).toBeUndefined();
    expect(p.type).toBe("general");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `bun test tests/unit/feedback.test.ts 2>&1 | tail -8`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement the command + exported helpers.**

```ts
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { getApiUrl } from "../../lib/mode.js";
import { writeJson } from "../../lib/output.js";
import { RELEASES_CLI_UA } from "../../lib/user-agent.js";
import { VERSION } from "../version.js";
import { isTelemetryEnabled, getOrCreateAnonId } from "../../lib/telemetry.js";

const MIN_MESSAGE = 5;
const MAX_MESSAGE = 4000;
const POST_TIMEOUT_MS = 10_000;
const FEEDBACK_TYPES = ["bug", "idea", "other"] as const;
const ISSUES_URL = "https://github.com/buildinternet/releases-cli/issues";

export type ValidateResult = { ok: true; message: string } | { ok: false; error: string };

export function validateMessage(raw: string): ValidateResult {
  const message = raw.trim();
  if (message.length < MIN_MESSAGE) {
    return { ok: false, error: "Feedback is too short — add a sentence or two." };
  }
  if (message.length > MAX_MESSAGE) {
    return { ok: false, error: `Feedback is too long (max ${MAX_MESSAGE} chars).` };
  }
  return { ok: true, message };
}

function detectRuntime(): string {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  if (bun?.version) return `bun-${bun.version}`;
  if (typeof process !== "undefined" && process.versions?.node)
    return `node-${process.versions.node}`;
  return "unknown";
}

export interface FeedbackPayload {
  message: string;
  type: string;
  contact?: string;
  cliVersion: string;
  clientKind: string;
  anonId?: string;
  os: string;
  arch: string;
  runtime: string;
  surface: "cli";
}

export function buildFeedbackPayload(
  message: string,
  opts: { type?: string; contact?: string },
  telemetry: { telemetryEnabled: boolean; anonId: string },
): FeedbackPayload {
  const type =
    opts.type && (FEEDBACK_TYPES as readonly string[]).includes(opts.type) ? opts.type : "general";
  return {
    message,
    type,
    contact: opts.contact?.trim() || undefined,
    cliVersion: VERSION,
    clientKind:
      process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true"
        ? "internal-ci"
        : "external",
    anonId: telemetry.telemetryEnabled ? telemetry.anonId : undefined,
    os: process.platform,
    arch: process.arch,
    runtime: detectRuntime(),
    surface: "cli",
  };
}

async function resolveMessage(arg: string | undefined): Promise<string | null> {
  if (arg && arg.trim()) return arg;
  if (!process.stdin.isTTY) {
    const piped = (await Bun.stdin.text()).trim();
    return piped.length ? piped : null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      chalk.bold("What's your feedback? ") + chalk.dim("(blank to cancel)\n> "),
    );
    return answer.trim().length ? answer : null;
  } finally {
    rl.close();
  }
}

async function resolveContact(provided: string | undefined): Promise<string | undefined> {
  if (provided) return provided;
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(chalk.dim("Contact (optional, blank to skip)\n> "));
    return answer.trim().length ? answer.trim() : undefined;
  } finally {
    rl.close();
  }
}

async function postFeedback(
  payload: FeedbackPayload,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${getApiUrl()}/v1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": RELEASES_CLI_UA },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `server returned ${res.status}` };
    const json = (await res.json()) as { ok?: boolean; id?: string };
    if (!json.ok || !json.id) return { ok: false, error: "unexpected response" };
    return { ok: true, id: json.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

export function registerFeedbackCommand(parent: Command): void {
  parent
    .command("feedback")
    .description("Send feedback about the releases CLI")
    .argument("[message]", "Feedback text (omit to type interactively or pipe via stdin)")
    .option("--contact <value>", "How to reach you for follow-up (optional)")
    .option("--type <type>", "bug | idea | other")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Print the payload without sending")
    .action(
      async (
        messageArg: string | undefined,
        opts: { contact?: string; type?: string; json?: boolean; dryRun?: boolean },
      ) => {
        if (opts.type && !(FEEDBACK_TYPES as readonly string[]).includes(opts.type)) {
          console.error(chalk.red(`--type must be one of: ${FEEDBACK_TYPES.join(", ")}`));
          process.exit(1);
        }

        const raw = await resolveMessage(messageArg);
        if (raw === null) {
          console.error(chalk.dim("Cancelled — no feedback sent."));
          process.exit(0);
        }
        const validated = validateMessage(raw);
        if (!validated.ok) {
          console.error(chalk.red(validated.error));
          process.exit(1);
        }

        const contact = await resolveContact(opts.contact);
        const payload = buildFeedbackPayload(
          validated.message,
          { type: opts.type, contact },
          { telemetryEnabled: isTelemetryEnabled(), anonId: getOrCreateAnonId() },
        );

        if (opts.dryRun) {
          if (opts.json) await writeJson({ dryRun: true, payload });
          else console.log(chalk.dim("[dry-run] would POST:\n") + JSON.stringify(payload, null, 2));
          return;
        }

        const result = await postFeedback(payload);
        if (result.ok) {
          if (opts.json) await writeJson({ ok: true, id: result.id });
          else
            console.log(
              chalk.green(`Thanks — feedback received `) + chalk.dim(`(id: ${result.id})`),
            );
          return;
        }
        if (opts.json) await writeJson({ ok: false, error: result.error });
        else {
          console.error(chalk.red(`Couldn't send feedback: ${result.error}`));
          console.error(chalk.dim(`You can open an issue instead: ${ISSUES_URL}`));
        }
        process.exit(1);
      },
    );
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `bun test tests/unit/feedback.test.ts 2>&1 | tail -10`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/cli/commands/feedback.ts tests/unit/feedback.test.ts
git commit -m "feat: add releases feedback command"
```

---

### Task 9: `releases admin feedback list` command

**Files:**

- Modify: `src/cli/commands/feedback.ts` (append `registerFeedbackAdminCommand`)

- [ ] **Step 1: Append the admin command + a render helper to `feedback.ts`.** Add an `apiFetch` import at the top:

```ts
import { apiFetch } from "../../api/client.js";
import { renderTable } from "../render/table.js";
```

> Confirm the exact export name in `src/cli/render/table.ts` first (`renderTable` vs `printTable`); use whatever the file exports. If it takes `(rows, columns)` adapt the call below to its signature.

Then append:

```ts
interface FeedbackRow {
  id: string;
  createdAt: number;
  message: string;
  contact: string | null;
  type: string;
  status: string;
}
interface FeedbackListResponse {
  items: FeedbackRow[];
  nextCursor: string | null;
}

export function registerFeedbackAdminCommand(parent: Command): void {
  const cmd = parent.command("feedback").description("Inspect submitted CLI feedback");

  cmd
    .command("list")
    .description("List submitted feedback (newest first)")
    .option("--status <status>", "Filter by status: new | triaged | closed")
    .option("--type <type>", "Filter by type: bug | idea | other | general")
    .option("--limit <n>", "Max rows (default 50)")
    .option("--cursor <cursor>", "Pagination cursor from a previous page")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        status?: string;
        type?: string;
        limit?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const qs = new URLSearchParams();
        if (opts.status) qs.set("status", opts.status);
        if (opts.type) qs.set("type", opts.type);
        if (opts.limit) qs.set("limit", opts.limit);
        if (opts.cursor) qs.set("cursor", opts.cursor);
        const q = qs.toString();
        const data = await apiFetch<FeedbackListResponse>(`/v1/admin/feedback${q ? `?${q}` : ""}`);

        if (opts.json) {
          await writeJson(data);
          return;
        }
        if (!data.items.length) {
          console.log(chalk.dim("No feedback yet."));
          return;
        }
        for (const r of data.items) {
          const when = new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ");
          const head = `${chalk.bold(r.id)}  ${chalk.dim(when)}  ${chalk.cyan(r.type)}/${r.status}`;
          const contact = r.contact ? chalk.dim(` <${r.contact}>`) : "";
          console.log(`${head}${contact}`);
          console.log(`  ${r.message.replace(/\s+/g, " ").slice(0, 200)}`);
        }
        if (data.nextCursor) {
          console.log("");
          console.log(chalk.dim(`More: releases admin feedback list --cursor ${data.nextCursor}`));
        }
      },
    );
}
```

> Note: the simple per-row print above avoids coupling to `render/table.ts`'s exact signature. If you prefer the shared table renderer, swap the loop for it — but the print form is sufficient and is what the tests don't cover (rendering is not unit-tested). Drop the `renderTable` import if unused to keep lint happy.

- [ ] **Step 2: Type-check.**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add src/cli/commands/feedback.ts
git commit -m "feat: add releases admin feedback list command"
```

---

### Task 10: Register commands + changeset

**Files:**

- Modify: `src/cli/program.ts`
- Create: `.changeset/cli-feedback.md`

- [ ] **Step 1: Register the public submit command.** In `src/cli/program.ts`, add the import near the other command imports:

```ts
import { registerFeedbackCommand, registerFeedbackAdminCommand } from "./commands/feedback.js";
```

In the "Public commands" block (next to `registerTelemetryCommand(program);`), add:

```ts
registerFeedbackCommand(program);
```

- [ ] **Step 2: Register the admin list command.** In the `admin` subtree section (after e.g. `registerWebhookCommand(admin);` near the end of admin wiring, but BEFORE `gateAdminSubtree(admin);` so it inherits the admin gate), add:

```ts
registerFeedbackAdminCommand(admin);
```

> Verify `gateAdminSubtree(admin)` runs after this registration so `admin feedback` is auth-gated.

- [ ] **Step 3: Add the changeset** (`.changeset/cli-feedback.md`):

```md
---
"@buildinternet/releases": minor
---

Add `releases feedback` to send feedback about the CLI, and `releases admin feedback list` to review submissions.
```

- [ ] **Step 4: Smoke the help output** (dev binary):

Run: `bun src/index.ts feedback --help 2>&1 | tail -20`
Expected: shows the `feedback` usage with `--contact`, `--type`, `--json`, `--dry-run`.

Run: `bun src/index.ts feedback "this is a dry-run smoke test message" --dry-run --json 2>&1 | tail -20`
Expected: prints `{ "dryRun": true, "payload": { ... } }` with no network call.

- [ ] **Step 5: Commit.**

```bash
git add src/cli/program.ts .changeset/cli-feedback.md
git commit -m "feat: register feedback commands + changeset"
```

---

### Task 11: CLI gates

- [ ] **Step 1: Type-check.** Run: `npx tsc --noEmit 2>&1 | tail -10` — Expected: clean.
- [ ] **Step 2: Tests.** Run: `bun test tests/unit/feedback.test.ts 2>&1 | tail -10` — Expected: PASS.
- [ ] **Step 3: Lint.** Run: `bun run lint 2>&1 | tail -15` — Expected: clean.
- [ ] **Step 4: Format.** Run: `bun run format 2>&1 | tail -3`; commit if changed.

---

## Post-implementation (handled by the driver, not as plan tasks)

- Simplify-agent review on each branch (per user request); apply high/medium fixes on-branch.
- Open two PRs: monorepo (`worktree-cli-feedback` → `main`) and CLI (`feat/cli-feedback` → `main`), cross-linking them.
- Flag the additive prod D1 migration for explicit deploy go-ahead; optionally validate against staging first.

## Self-review notes

- **Spec coverage:** schema/migration (T1–2), email notify (T3), open POST + caps + kill switch (T4, T6), admin read-back (T5, T9), rate limit + env + mounts (T6), CLI submit with arg/stdin/interactive + enrichment + dry-run + json (T8), admin list (T9), registration + changeset (T10), gates (T7, T11). All spec sections map to a task.
- **Type consistency:** `FeedbackPayload`, `validateMessage`, `buildFeedbackPayload`, `feedbackRoutes`, `adminFeedbackRoutes`, `formatFeedbackEmail`, `notifyFeedback`, `newFeedbackId`, `FEEDBACK_TYPES` are used consistently across tasks. CLI `FEEDBACK_TYPES` deliberately excludes `general` (server default); server-side `FEEDBACK_TYPES` includes it.
- **Open risk to confirm during execution:** exact `Env` field placement in `index.ts` and the `render/table.ts` export name — both flagged inline with fallbacks.
