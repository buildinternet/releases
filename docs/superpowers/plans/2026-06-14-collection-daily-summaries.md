# Collection Daily Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a brief daily rollup (title + one-line summary + bullet takeaways) per collection per Eastern-Time day, and surface it as a header on each day's group in the collection timeline.

**Architecture:** A new `collection_daily_summaries` table holds one row per (collection, ET day). A nightly cron computes the just-closed ET day, fetches that day's releases across the collection's members, generates the summary through the existing cheap-call `resolveTextModel` OpenRouter lane (Haiku fail-open), and upserts. A new `GET /v1/collections/:slug/daily-summaries` range endpoint feeds the web timeline, which renders a header above each day bucket. Per-collection `daily_summary_enabled` (default true) gates generation.

**Tech Stack:** Bun, TypeScript (strict), Drizzle ORM + Cloudflare D1, Hono (API worker), Cloudflare Workers cron triggers, Next.js (web), the `@releases/ai-internal` text-model seam, Zod (api-types).

**Spec:** `docs/superpowers/specs/2026-06-14-collection-daily-summaries-design.md`

---

## File Structure

**Create:**
- `workers/api/migrations/20260614000000_add_collection_daily_summaries.sql` — DDL: new table + `daily_summary_enabled` column.
- `packages/ai/src/collection-summary.ts` — prompt, input builder, parser, `summarizeCollectionDay`.
- `packages/ai/src/collection-summary.test.ts` — parser/builder unit tests.
- `workers/api/src/queries/collection-summaries.ts` — day-window release query, members query, summary DAO (upsert/list).
- `workers/api/src/queries/collection-summaries.test.ts` — query/DAO unit tests.
- `workers/api/src/cron/collection-summaries.ts` — nightly sweep + on-demand single-collection generator.
- `workers/api/src/cron/collection-summaries.test.ts` — eligibility/skip-empty/idempotency tests.
- `workers/api/test/collection-daily-summaries-route.test.ts` — worker route smoke test.
- `tests/evals/collection-summary.eval.ts` — on-demand prompt-quality eval (not CI-gated).

**Modify:**
- `packages/core/src/id.ts` — add `newCollectionDailySummaryId` + `ID_PREFIXES` entry.
- `packages/core/src/schema.ts` — `collectionDailySummaries` table + `dailySummaryEnabled` on `collections`.
- `packages/core/src/dates.ts` — `etDayKey`, `etDayBoundsUtc`, `addDaysToDateKey` helpers.
- `packages/core/src/dates.test.ts` — ET helper unit tests (DST boundaries).
- `packages/api-types/src/schemas/collections.ts` — `CollectionDailySummarySchema` + `CollectionDailySummariesResponseSchema`.
- `packages/api-types/src/api-types.ts` — re-export the new schemas/types.
- `workers/api/src/lib/text-model.ts` — `resolveCollectionSummaryModel` + `COLLECTION_SUMMARY_MODEL` env.
- `workers/api/src/lib/text-model.test.ts` — lane-resolution test.
- `workers/api/src/routes/collections.ts` — `GET /collections/:slug/daily-summaries` + `POST /v1/workflows/collection-summaries`.
- `workers/api/src/index.ts` — cron dispatch + env passthrough; `Env` tunables.
- `workers/api/wrangler.jsonc` — cron trigger + `COLLECTION_SUMMARY_MODEL` var.
- `web/src/lib/api.ts` — `collectionDailySummaries(slug, from, to)` client method.
- `web/src/app/collections/[slug]/page.tsx` — parallel-fetch summaries, pass to timeline.
- `web/src/components/collection-timeline.tsx` — ET `dayKey`, `summaryByDate` prop, `DailySummaryHeader`, render in `DaySection`.

---

## Task 1: ET date helpers in core

**Files:**
- Modify: `packages/core/src/dates.ts`
- Test: `packages/core/src/dates.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/dates.test.ts` (create the file if absent, mirroring existing core test style — `import { describe, expect, test } from "bun:test"`):

```ts
import { describe, expect, test } from "bun:test";
import { etDayKey, etDayBoundsUtc, addDaysToDateKey } from "./dates";

describe("etDayKey", () => {
  test("maps a UTC instant to its Eastern calendar day", () => {
    // 2026-06-12T03:30:00Z is 2026-06-11 23:30 EDT — still the 11th in ET.
    expect(etDayKey("2026-06-12T03:30:00Z")).toBe("2026-06-11");
    // 2026-01-12T04:30:00Z is 2026-01-11 23:30 EST — still the 11th in ET.
    expect(etDayKey("2026-01-12T04:30:00Z")).toBe("2026-01-11");
    // Midday UTC stays on the same calendar day.
    expect(etDayKey("2026-06-12T16:00:00Z")).toBe("2026-06-12");
  });
});

describe("etDayBoundsUtc", () => {
  test("returns [start,end) UTC instants for an EDT day (UTC-4)", () => {
    expect(etDayBoundsUtc("2026-06-11")).toEqual({
      startUtc: "2026-06-11T04:00:00.000Z",
      endUtc: "2026-06-12T04:00:00.000Z",
    });
  });
  test("returns [start,end) UTC instants for an EST day (UTC-5)", () => {
    expect(etDayBoundsUtc("2026-01-11")).toEqual({
      startUtc: "2026-01-11T05:00:00.000Z",
      endUtc: "2026-01-12T05:00:00.000Z",
    });
  });
});

describe("addDaysToDateKey", () => {
  test("adds and subtracts whole days on a YYYY-MM-DD key", () => {
    expect(addDaysToDateKey("2026-06-11", -1)).toBe("2026-06-10");
    expect(addDaysToDateKey("2026-06-30", 1)).toBe("2026-07-01");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/dates.test.ts`
Expected: FAIL — `etDayKey`/`etDayBoundsUtc`/`addDaysToDateKey` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/dates.ts`:

```ts
// ── Eastern-Time day helpers ──────────────────────────────────────
// Daily collection summaries are bucketed by Eastern calendar day (the
// product audience + the self-changelog cron both use ET). No tz library:
// Intl handles the DST math.

const ET_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Eastern calendar day (`YYYY-MM-DD`) for a UTC instant. */
export function etDayKey(instant: string | Date): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return ET_DATE_FMT.format(d); // en-CA renders ISO-style YYYY-MM-DD
}

/** Offset (minutes east of UTC) of America/New_York at a given instant. */
function etOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Add (or subtract) whole days to a `YYYY-MM-DD` key, returning a `YYYY-MM-DD` key. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** UTC instant of Eastern midnight starting `dateKey`. */
function etMidnightUtc(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = etOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60_000).toISOString();
}

/** The `[startUtc, endUtc)` instants bounding an Eastern calendar day. */
export function etDayBoundsUtc(dateKey: string): { startUtc: string; endUtc: string } {
  return {
    startUtc: etMidnightUtc(dateKey),
    endUtc: etMidnightUtc(addDaysToDateKey(dateKey, 1)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/dates.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dates.ts packages/core/src/dates.test.ts
git commit -m "feat(core): Eastern-Time day-bucketing helpers"
```

---

## Task 2: Typed id + schema table + paired migration

**Files:**
- Modify: `packages/core/src/id.ts`
- Modify: `packages/core/src/schema.ts`
- Create: `workers/api/migrations/20260614000000_add_collection_daily_summaries.sql`
- Test: `workers/api/src/queries/collection-summaries.test.ts` (created here; expanded in Task 5)

- [ ] **Step 1: Add the id helper**

In `packages/core/src/id.ts`, add near `newCollectionId`:

```ts
export const newCollectionDailySummaryId = () => `cds_${nanoid()}`;
```

And add to the `ID_PREFIXES` record (match the existing `EntityType` union — add `"collectionDailySummary"` to that union type wherever it is declared in this file):

```ts
  cds: "collectionDailySummary",
```

- [ ] **Step 2: Add the schema table + column**

In `packages/core/src/schema.ts`:

1. Add `newCollectionDailySummaryId` to the id import block at the top.
2. Add a `dailySummaryEnabled` column to the existing `collections` table (after `isFeatured`):

```ts
  // Per-collection on/off for the nightly daily-summary generation. Default
  // true — collections opt OUT, not in. Toggle via PATCH /v1/collections/:slug.
  dailySummaryEnabled: integer("daily_summary_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
```

3. Add the new table immediately after `collectionMembers`:

```ts
// One brief AI rollup per (collection, Eastern calendar day): a headline,
// a one-line summary, and bullet takeaways covering that day's releases
// across the collection's members. Written by the nightly
// collection-summaries cron; read by GET /v1/collections/:slug/daily-summaries
// and rendered as a header on each day group in the collection timeline.
export const collectionDailySummaries = sqliteTable(
  "collection_daily_summaries",
  {
    id: text("id").primaryKey().$defaultFn(newCollectionDailySummaryId),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    // Eastern calendar day being summarized, as YYYY-MM-DD.
    summaryDate: text("summary_date").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // JSON array of bullet strings.
    takeaways: text("takeaways").notNull().default("[]"),
    releaseCount: integer("release_count").notNull().default(0),
    // `<provider>:<model>` that produced this row.
    modelId: text("model_id"),
    generatedAt: text("generated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("idx_collection_daily_summaries_day").on(table.collectionId, table.summaryDate),
  ],
);
```

- [ ] **Step 3: Write the migration**

Create `workers/api/migrations/20260614000000_add_collection_daily_summaries.sql`:

```sql
-- Per-collection daily summary rollups + per-collection enable flag.
ALTER TABLE collections ADD COLUMN daily_summary_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE collection_daily_summaries (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  summary_date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  takeaways TEXT NOT NULL DEFAULT '[]',
  release_count INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_collection_daily_summaries_day
  ON collection_daily_summaries (collection_id, summary_date);
```

- [ ] **Step 4: Write a schema-presence test**

Create `workers/api/src/queries/collection-summaries.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../../tests/db-helper";
import { collectionDailySummaries } from "@buildinternet/releases-core/schema";

describe("collection_daily_summaries schema", () => {
  test("table is queryable through the test DB", async () => {
    const { db } = createTestDb();
    const rows = await db.select().from(collectionDailySummaries);
    expect(rows).toEqual([]);
  });
});
```

(Confirm the exact `createTestDb` import path/shape against `tests/db-helper.ts` before running; adjust the relative path to match the file's location.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test workers/api/src/queries/collection-summaries.test.ts`
Expected: PASS — `createTestDb()` applies the drizzle schema, so the table exists.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit` (root) and `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/id.ts packages/core/src/schema.ts \
  workers/api/migrations/20260614000000_add_collection_daily_summaries.sql \
  workers/api/src/queries/collection-summaries.test.ts
git commit -m "feat(db): collection_daily_summaries table + daily_summary_enabled"
```

---

## Task 3: AI prompt module (`collection-summary.ts`)

**Files:**
- Create: `packages/ai/src/collection-summary.ts`
- Test: `packages/ai/src/collection-summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ai/src/collection-summary.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildCollectionDayBlock,
  parseCollectionSummary,
  summarizeCollectionDay,
  type CollectionDayInput,
} from "./collection-summary";
import type { TextModel } from "./text-model";

const INPUT: CollectionDayInput = {
  collectionName: "Coding agents",
  date: "2026-06-11",
  releases: [
    { org: "Anthropic", product: "Claude Code", title: "Sub-agents land in Claude Code", summary: "Spawn parallel sub-agents." },
    { org: "Cursor", product: null, title: "Background agents GA", summary: "Background agents are generally available." },
  ],
};

describe("buildCollectionDayBlock", () => {
  test("renders collection, date, and one line per release", () => {
    const block = buildCollectionDayBlock(INPUT);
    expect(block).toContain("Collection: Coding agents");
    expect(block).toContain("Date: 2026-06-11");
    expect(block).toContain("Anthropic / Claude Code: Sub-agents land in Claude Code");
    expect(block).toContain("Cursor: Background agents GA");
  });
});

describe("parseCollectionSummary", () => {
  test("extracts title, summary, and bullet takeaways", () => {
    const raw = [
      "<title>Labs pile on agentic coding</title>",
      "<summary>Three labs shipped agent updates today.</summary>",
      "<takeaways><item>Anthropic added sub-agents to Claude Code</item><item>Cursor shipped background agents GA</item></takeaways>",
    ].join("\n");
    expect(parseCollectionSummary(raw)).toEqual({
      title: "Labs pile on agentic coding",
      summary: "Three labs shipped agent updates today.",
      takeaways: ["Anthropic added sub-agents to Claude Code", "Cursor shipped background agents GA"],
    });
  });

  test("throws when the title tag is missing", () => {
    expect(() => parseCollectionSummary("<summary>x</summary>")).toThrow();
  });

  test("tolerates surrounding prose and zero bullets", () => {
    const raw = "Here you go:\n<title>Quiet day</title><summary>One SDK bump.</summary><takeaways></takeaways>";
    expect(parseCollectionSummary(raw)).toEqual({
      title: "Quiet day",
      summary: "One SDK bump.",
      takeaways: [],
    });
  });
});

describe("summarizeCollectionDay", () => {
  test("passes the system prompt + day block to the model and returns parsed fields", async () => {
    let seenUser = "";
    const fake: TextModel = {
      id: "openrouter:test/cheap",
      async complete({ user }) {
        seenUser = user;
        return {
          text: "<title>T</title><summary>S</summary><takeaways><item>b1</item></takeaways>",
          usage: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0 },
        };
      },
    };
    const res = await summarizeCollectionDay(fake, INPUT);
    expect(seenUser).toContain("Collection: Coding agents");
    expect(res.title).toBe("T");
    expect(res.takeaways).toEqual(["b1"]);
    expect(res.usage.input).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai/src/collection-summary.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/ai/src/collection-summary.ts`:

```ts
/**
 * Generate a brief daily rollup for a collection: a headline title, a one-line
 * summary, and bullet takeaways covering one Eastern-day's releases across the
 * collection's members. Provider-neutral — the caller constructs the TextModel
 * (a cheap OpenRouter model when `openrouter-enabled` is on, Anthropic Haiku as
 * the fail-open fallback). Mirrors release-content.ts's tagged-output parsing.
 */
import { extractTagged } from "./release-content";
import type { TextModel } from "./text-model";

/** Anthropic fail-open model when the OpenRouter lane is unusable. */
export const MODEL = "claude-haiku-4-5";

/** Cap on the model's response: ~90-char title + 1-line summary + ~5 bullets. */
export const MAX_OUTPUT_TOKENS = 400;

/** Per-day release cap fed to the model, to bound tokens on busy days. */
export const MAX_RELEASES = 60;

export interface CollectionDayRelease {
  org: string;
  product: string | null;
  title: string;
  summary: string | null;
}

export interface CollectionDayInput {
  collectionName: string;
  date: string; // YYYY-MM-DD (ET)
  releases: CollectionDayRelease[];
}

export interface CollectionSummaryFields {
  title: string;
  summary: string;
  takeaways: string[];
}

export interface CollectionSummaryUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface CollectionSummaryResult extends CollectionSummaryFields {
  usage: CollectionSummaryUsage;
}

export const SYSTEM_PROMPT = `You write a brief daily rollup for a curated collection of software products, shown as a date header in a developer-facing changelog feed. You are given the collection name, a date, and the releases that shipped across the collection's members that day.

<output_structure>
Output exactly one <title>...</title> tag, then one <summary>...</summary> tag, then one <takeaways>...</takeaways> tag, in that order. Inside <takeaways>, output zero or more <item>...</item> tags, one per bullet. Output nothing before, between, or after these tags.
</output_structure>

<title_format>
- A news-headline characterization of the DAY across the collection, not of a single release. Prefer a theme ("Labs pile on agentic coding", "Quiet day, one SDK bump") over enumerating products.
- Sentence case. Preserve product names, proper nouns, and standard acronyms (API, CLI, SDK, MCP).
- Target 30-70 characters. Hard cap 90. No trailing punctuation, no quotation marks, no markdown.
</title_format>

<summary_format>
- Exactly one sentence describing the day at a glance. May name the count ("Three labs shipped agent updates") or the single most significant ship if the day is dominated by one.
- Plain factual prose. No markdown, no opening filler ("Today", "This is"), no marketing language.
</summary_format>

<takeaways_format>
- Zero to five bullets, each a concise key takeaway. Each may name the org/product. Lead with the most significant ship of the day.
- One factual claim per bullet. No marketing intensifiers. No ticket/PR numbers. Plain text — no markdown bullets or links (the wrapper renders the list).
- Group thematically when multiple members ship the same kind of thing ("Three labs added agent sub-task support: Anthropic, Cursor, OpenAI"). Do not pad to five — fewer, denser bullets beat filler.
</takeaways_format>

<priority_order>
Lead title, summary, and the first bullet with the highest-impact item of the day, ranked: breaking changes/deprecations > security/data-loss fixes > new user-facing capabilities > correctness fixes > improvements > internal/chore. Skip chore-only items entirely.
</priority_order>`;

/** Render the user-message block from a day's releases. */
export function buildCollectionDayBlock(input: CollectionDayInput): string {
  const lines = input.releases.slice(0, MAX_RELEASES).map((r) => {
    const label = r.product && r.product !== r.org ? `${r.org} / ${r.product}` : r.org;
    const tail = r.summary ? ` — ${r.summary}` : "";
    return `- ${label}: ${r.title}${tail}`;
  });
  return [
    `Collection: ${input.collectionName}`,
    `Date: ${input.date}`,
    `Releases (${input.releases.length}):`,
    ...lines,
  ].join("\n");
}

/** Pull every <item> out of a <takeaways> block. */
function parseTakeaways(raw: string): string[] {
  const block = extractTagged(raw, "takeaways");
  if (!block) return [];
  const items: string[] = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const t = m[1].trim();
    if (t) items.push(t);
  }
  return items;
}

/** Parse a model response into the three fields. Throws on a missing title. */
export function parseCollectionSummary(raw: string): CollectionSummaryFields {
  const title = extractTagged(raw, "title");
  if (!title) {
    throw new Error(`model output missing <title> tag (raw length ${raw.length})`);
  }
  return {
    title,
    summary: extractTagged(raw, "summary"),
    takeaways: parseTakeaways(raw),
  };
}

/** Run a collection's day through the supplied TextModel. */
export async function summarizeCollectionDay(
  model: TextModel,
  input: CollectionDayInput,
): Promise<CollectionSummaryResult> {
  const { text, usage } = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildCollectionDayBlock(input),
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheSystem: true,
  });
  return {
    ...parseCollectionSummary(text),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheCreate: usage.cacheCreate,
      cacheRead: usage.cacheRead,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai/src/collection-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the package export path resolves**

Confirm `packages/ai/package.json` exposes subpath exports so `@releases/ai-internal/collection-summary` resolves (it uses a wildcard `./*` export today; if not, add an explicit `"./collection-summary"` entry mirroring `"./release-content"`). Run: `cd workers/api && npx tsc --noEmit` after Task 4 wires the import.

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/collection-summary.ts packages/ai/src/collection-summary.test.ts
git commit -m "feat(ai): collection daily-summary prompt + parser"
```

---

## Task 4: Worker text-model lane

**Files:**
- Modify: `workers/api/src/lib/text-model.ts`
- Test: `workers/api/src/lib/text-model.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `workers/api/src/lib/text-model.test.ts` (follow the file's existing test harness for flag/secret stubbing — mirror an existing `resolveSummarizeModel` test):

```ts
import { resolveCollectionSummaryModel } from "./text-model";

test("collection-summary lane routes to OpenRouter when enabled + configured", async () => {
  const model = await resolveCollectionSummaryModel({
    FLAGS: undefined,
    OPENROUTER_ENABLED: "true",
    OPENROUTER_API_KEY: { get: async () => "or-key" } as any,
    COLLECTION_SUMMARY_MODEL: "meta-llama/llama-3.1-8b-instruct",
    ENVIRONMENT: "production",
  } as any);
  expect(model?.id).toBe("openrouter:meta-llama/llama-3.1-8b-instruct");
});

test("collection-summary lane falls open to Anthropic Haiku when OpenRouter is off", async () => {
  const model = await resolveCollectionSummaryModel({
    FLAGS: undefined,
    OPENROUTER_ENABLED: "false",
    COLLECTION_SUMMARY_MODEL: "",
    ANTHROPIC_API_KEY: { get: async () => "sk-ant" } as any,
  } as any);
  expect(model?.id).toBe("anthropic:claude-haiku-4-5");
});
```

(Match the exact env-stub shape the sibling tests already use for `ANTHROPIC_API_KEY`/gateway; adjust property names if the existing tests differ.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/text-model.test.ts`
Expected: FAIL — `resolveCollectionSummaryModel` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `workers/api/src/lib/text-model.ts`:

1. Add the import:

```ts
import { MODEL as ANTHROPIC_COLLECTION_SUMMARY_MODEL } from "@releases/ai-internal/collection-summary";
```

2. Add the env var to `TextModelEnv`:

```ts
  /** OpenRouter model for the collection daily-summary lane; empty → stay on Anthropic Haiku. */
  COLLECTION_SUMMARY_MODEL?: string;
```

3. Add the resolver next to `resolveSummarizeModel`:

```ts
export function resolveCollectionSummaryModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.COLLECTION_SUMMARY_MODEL,
    anthropicModel: ANTHROPIC_COLLECTION_SUMMARY_MODEL,
    generationName: "collection-daily-summary",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/text-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/text-model.ts workers/api/src/lib/text-model.test.ts
git commit -m "feat(api): collection-summary text-model lane"
```

---

## Task 5: Query helpers + DAO

**Files:**
- Modify: `workers/api/src/queries/collection-summaries.ts` (create)
- Test: `workers/api/src/queries/collection-summaries.test.ts` (expand)

- [ ] **Step 1: Write the failing tests**

Append to `workers/api/src/queries/collection-summaries.test.ts`:

```ts
import {
  upsertCollectionDailySummary,
  listCollectionDailySummaries,
  getCollectionMembers,
} from "./collection-summaries";

describe("collection daily-summary DAO", () => {
  test("upsert inserts then replaces on the same (collection, date)", async () => {
    const { db } = createTestDb();
    const colId = "col_test1";
    await db.insert(collections).values({ id: colId, slug: "c1", name: "C1" });

    await upsertCollectionDailySummary(db, {
      collectionId: colId,
      summaryDate: "2026-06-11",
      title: "First",
      summary: "s1",
      takeaways: ["a"],
      releaseCount: 2,
      modelId: "openrouter:test",
    });
    await upsertCollectionDailySummary(db, {
      collectionId: colId,
      summaryDate: "2026-06-11",
      title: "Second",
      summary: "s2",
      takeaways: ["b", "c"],
      releaseCount: 3,
      modelId: "openrouter:test",
    });

    const rows = await listCollectionDailySummaries(db, colId, "2026-06-01", "2026-06-30");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Second");
    expect(rows[0].takeaways).toEqual(["b", "c"]);
    expect(rows[0].releaseCount).toBe(3);
  });
});
```

(Import `collections` from `@buildinternet/releases-core/schema` at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/queries/collection-summaries.test.ts`
Expected: FAIL — `./collection-summaries` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `workers/api/src/queries/collection-summaries.ts`:

```ts
import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import {
  collections,
  collectionMembers,
  collectionDailySummaries,
  organizationsPublic,
  productsActive,
  releases,
  sources,
  organizations,
  products,
} from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";
import type { CollectionDayRelease } from "@releases/ai-internal/collection-summary";

/** Visible org + product member ids for a collection (same views as the feed). */
export async function getCollectionMembers(
  db: AnyDb,
  collectionId: string,
): Promise<{ orgIds: string[]; productIds: string[] }> {
  const [orgRows, productRows] = await Promise.all([
    db
      .select({ orgId: organizationsPublic.id })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, collectionId)),
    db
      .select({ productId: productsActive.id })
      .from(collectionMembers)
      .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, productsActive.orgId))
      .where(eq(collectionMembers.collectionId, collectionId)),
  ]);
  return {
    orgIds: orgRows.map((r) => r.orgId),
    productIds: productRows.map((r) => r.productId),
  };
}

/**
 * Releases for a collection's members published in `[startUtc, endUtc)`.
 * Member sets are small (curated), so a single inArray each is within D1's
 * 100-bind limit; if a collection ever exceeds ~90 members of one kind this
 * must chunk (see AGENTS.md D1 note).
 */
export async function getCollectionDayReleases(
  db: AnyDb,
  members: { orgIds: string[]; productIds: string[] },
  window: { startUtc: string; endUtc: string },
): Promise<CollectionDayRelease[]> {
  const memberConds = [];
  if (members.orgIds.length) memberConds.push(inArray(sources.orgId, members.orgIds));
  if (members.productIds.length) memberConds.push(inArray(releases.productId, members.productIds));
  if (memberConds.length === 0) return [];

  const rows = await db
    .select({
      orgName: organizations.name,
      productName: products.name,
      sourceName: sources.name,
      title: releases.title,
      titleGenerated: releases.titleGenerated,
      summary: releases.summary,
      publishedAt: releases.publishedAt,
    })
    .from(releases)
    .innerJoin(sources, eq(sources.id, releases.sourceId))
    .innerJoin(organizations, eq(organizations.id, sources.orgId))
    .leftJoin(products, eq(products.id, releases.productId))
    .where(
      and(
        gte(releases.publishedAt, window.startUtc),
        lt(releases.publishedAt, window.endUtc),
        or(...memberConds),
      ),
    )
    .orderBy(desc(releases.publishedAt));

  return rows.map((r) => ({
    org: r.orgName,
    product: r.productName ?? r.sourceName ?? null,
    title: r.titleGenerated ?? r.title,
    summary: r.summary ?? null,
  }));
}

export interface DailySummaryRow {
  date: string;
  title: string;
  summary: string;
  takeaways: string[];
  releaseCount: number;
}

export async function listCollectionDailySummaries(
  db: AnyDb,
  collectionId: string,
  from: string,
  to: string,
): Promise<DailySummaryRow[]> {
  const rows = await db
    .select()
    .from(collectionDailySummaries)
    .where(
      and(
        eq(collectionDailySummaries.collectionId, collectionId),
        gte(collectionDailySummaries.summaryDate, from),
        lt(collectionDailySummaries.summaryDate, addExclusiveUpper(to)),
      ),
    )
    .orderBy(desc(collectionDailySummaries.summaryDate));
  return rows.map((r) => ({
    date: r.summaryDate,
    title: r.title,
    summary: r.summary,
    takeaways: safeParseTakeaways(r.takeaways),
    releaseCount: r.releaseCount,
  }));
}

// `to` is inclusive at the API; bump to an exclusive upper bound on YYYY-MM-DD.
function addExclusiveUpper(to: string): string {
  const [y, m, d] = to.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function safeParseTakeaways(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface UpsertSummaryInput {
  collectionId: string;
  summaryDate: string;
  title: string;
  summary: string;
  takeaways: string[];
  releaseCount: number;
  modelId: string | null;
}

export async function upsertCollectionDailySummary(
  db: AnyDb,
  input: UpsertSummaryInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(collectionDailySummaries)
    .values({
      collectionId: input.collectionId,
      summaryDate: input.summaryDate,
      title: input.title,
      summary: input.summary,
      takeaways: JSON.stringify(input.takeaways),
      releaseCount: input.releaseCount,
      modelId: input.modelId,
      generatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [collectionDailySummaries.collectionId, collectionDailySummaries.summaryDate],
      set: {
        title: input.title,
        summary: input.summary,
        takeaways: JSON.stringify(input.takeaways),
        releaseCount: input.releaseCount,
        modelId: input.modelId,
        updatedAt: now,
      },
    });
}
```

(Before running: verify column names `releases.sourceId`, `releases.publishedAt`, `releases.productId`, `releases.titleGenerated`, `sources.name`, `products.name`, `organizations.name` against `packages/core/src/schema.ts` — adjust to the real identifiers if any differ.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/queries/collection-summaries.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `cd workers/api && npx tsc --noEmit` → no errors.

```bash
git add workers/api/src/queries/collection-summaries.ts workers/api/src/queries/collection-summaries.test.ts
git commit -m "feat(api): collection daily-summary queries + DAO"
```

---

## Task 6: Cron sweep

**Files:**
- Create: `workers/api/src/cron/collection-summaries.ts`
- Test: `workers/api/src/cron/collection-summaries.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `workers/api/src/cron/collection-summaries.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../../tests/db-helper";
import { collections } from "@buildinternet/releases-core/schema";
import { generateCollectionSummariesForDay } from "./collection-summaries";
import { listCollectionDailySummaries } from "../queries/collection-summaries";
import type { TextModel } from "@releases/ai-internal/text-model";

function fakeModel(): TextModel {
  return {
    id: "openrouter:test",
    async complete() {
      return {
        text: "<title>Day</title><summary>S</summary><takeaways><item>x</item></takeaways>",
        usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 },
      };
    },
  };
}

describe("generateCollectionSummariesForDay", () => {
  test("skips a collection with no releases that day (no row, no model call)", async () => {
    const { db } = createTestDb();
    await db.insert(collections).values({ id: "col_a", slug: "a", name: "A" });
    let called = false;
    const model = { ...fakeModel(), complete: async () => { called = true; return fakeModel().complete({} as any); } };

    await generateCollectionSummariesForDay(db, model, "2026-06-11");

    expect(called).toBe(false);
    const rows = await listCollectionDailySummaries(db, "col_a", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(0);
  });

  test("respects daily_summary_enabled = false", async () => {
    const { db } = createTestDb();
    await db.insert(collections).values({ id: "col_off", slug: "off", name: "Off", dailySummaryEnabled: false });
    await generateCollectionSummariesForDay(db, fakeModel(), "2026-06-11");
    const rows = await listCollectionDailySummaries(db, "col_off", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(0);
  });
});
```

(This test exercises the skip paths without seeding releases; a fuller "happy path" test that seeds an org/source/release and asserts a row is written can be added once the release-seed helper shape is confirmed from existing query tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/cron/collection-summaries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `workers/api/src/cron/collection-summaries.ts`:

```ts
import { eq } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import { etDayKey, etDayBoundsUtc, addDaysToDateKey } from "@buildinternet/releases-core/dates";
import { summarizeCollectionDay } from "@releases/ai-internal/collection-summary";
import type { TextModel } from "@releases/ai-internal/text-model";
import { createDb, type AnyDb } from "../db.js";
import { collections } from "@buildinternet/releases-core/schema";
import {
  getCollectionMembers,
  getCollectionDayReleases,
  listCollectionDailySummaries,
  upsertCollectionDailySummary,
} from "../queries/collection-summaries.js";
import { resolveCollectionSummaryModel, type TextModelEnv } from "../lib/text-model.js";

export interface CollectionSummariesEnv extends TextModelEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /** How many recent ET days to backfill if a row is missing (default 2). */
  COLLECTION_SUMMARY_CATCHUP_DAYS?: string;
  _drizzleOverride?: ReturnType<typeof createDb>;
}

/** Generate summaries for one ET day across every enabled collection. Exported for tests. */
export async function generateCollectionSummariesForDay(
  db: AnyDb,
  model: TextModel,
  date: string,
): Promise<{ generated: number; skipped: number; failed: number }> {
  const cols = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(eq(collections.dailySummaryEnabled, true));

  const window = etDayBoundsUtc(date);
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const col of cols) {
    try {
      const existing = await listCollectionDailySummaries(db, col.id, date, date);
      if (existing.length > 0) {
        skipped++;
        continue;
      }
      const members = await getCollectionMembers(db, col.id);
      const releases = await getCollectionDayReleases(db, members, window);
      if (releases.length === 0) {
        skipped++;
        continue;
      }
      const result = await summarizeCollectionDay(model, {
        collectionName: col.name,
        date,
        releases,
      });
      await upsertCollectionDailySummary(db, {
        collectionId: col.id,
        summaryDate: date,
        title: result.title,
        summary: result.summary,
        takeaways: result.takeaways,
        releaseCount: releases.length,
        modelId: model.id,
      });
      generated++;
    } catch (err) {
      failed++;
      logEvent("error", {
        component: "collection-summaries",
        event: "generate-failed",
        collectionId: col.id,
        date,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { generated, skipped, failed };
}

/**
 * Nightly entrypoint. Summarizes the just-closed ET day plus a small catch-up
 * window of recent days that lack a row (guards against a missed run). Gated by
 * CRON_ENABLED; per-collection failures never abort the sweep.
 */
export async function runCollectionSummaries(
  env: CollectionSummariesEnv,
  scheduledTime: Date,
): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "collection-summaries", event: "cron-disabled" });
    return;
  }
  const model = await resolveCollectionSummaryModel(env);
  if (!model) {
    logEvent("warn", { component: "collection-summaries", event: "no-model" });
    return;
  }
  const db = env._drizzleOverride ?? createDb(env.DB);

  const todayEt = etDayKey(scheduledTime);
  const catchup = Math.max(1, Number(env.COLLECTION_SUMMARY_CATCHUP_DAYS ?? "2") || 2);

  // Closed day = yesterday ET; walk back `catchup` days total.
  let totals = { generated: 0, skipped: 0, failed: 0 };
  for (let i = 1; i <= catchup; i++) {
    const date = addDaysToDateKey(todayEt, -i);
    const r = await generateCollectionSummariesForDay(db, model, date);
    totals = {
      generated: totals.generated + r.generated,
      skipped: totals.skipped + r.skipped,
      failed: totals.failed + r.failed,
    };
  }
  logEvent("info", { component: "collection-summaries", event: "run-done", ...totals });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/cron/collection-summaries.test.ts`
Expected: PASS (both skip-path tests).

- [ ] **Step 5: Type-check + commit**

Run: `cd workers/api && npx tsc --noEmit` → no errors.

```bash
git add workers/api/src/cron/collection-summaries.ts workers/api/src/cron/collection-summaries.test.ts
git commit -m "feat(api): nightly collection daily-summary cron"
```

---

## Task 7: API route + on-demand workflow

**Files:**
- Modify: `packages/api-types/src/schemas/collections.ts`
- Modify: `packages/api-types/src/api-types.ts`
- Modify: `workers/api/src/routes/collections.ts`
- Test: `workers/api/test/collection-daily-summaries-route.test.ts`

- [ ] **Step 1: Add the api-types schemas**

In `packages/api-types/src/schemas/collections.ts` add:

```ts
export const CollectionDailySummarySchema = z.object({
  date: z.string(), // YYYY-MM-DD (ET)
  title: z.string(),
  summary: z.string(),
  takeaways: z.array(z.string()),
  releaseCount: z.number().int().nonnegative(),
});

export const CollectionDailySummariesResponseSchema = z.object({
  summaries: z.array(CollectionDailySummarySchema),
});
```

In `packages/api-types/src/api-types.ts`, add both schemas to the import + re-export blocks (mirror the existing `CollectionReleasesResponseSchema` lines), and add:

```ts
export type CollectionDailySummary = z.infer<typeof CollectionDailySummarySchema>;
export type CollectionDailySummariesResponse = z.infer<typeof CollectionDailySummariesResponseSchema>;
```

- [ ] **Step 2: Write the failing route test**

Create `workers/api/test/collection-daily-summaries-route.test.ts` (mirror an existing in-process worker route test — `routes.request(path, init, env)` with `createTestDb().db` as `env.DB`; copy the env-construction boilerplate from a sibling collections route test):

```ts
import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../tests/db-helper";
import { collections, collectionDailySummaries } from "@buildinternet/releases-core/schema";
// import { app } from "../src/index";  // use the same app/route import the sibling tests use

describe("GET /v1/collections/:slug/daily-summaries", () => {
  test("returns summaries within the date range, newest first", async () => {
    const { db } = createTestDb();
    await db.insert(collections).values({ id: "col_x", slug: "coding-agents", name: "Coding agents" });
    const now = new Date().toISOString();
    await db.insert(collectionDailySummaries).values([
      { id: "cds_1", collectionId: "col_x", summaryDate: "2026-06-10", title: "T10", summary: "s", takeaways: '["a"]', releaseCount: 1, generatedAt: now, updatedAt: now },
      { id: "cds_2", collectionId: "col_x", summaryDate: "2026-06-11", title: "T11", summary: "s", takeaways: '["b","c"]', releaseCount: 2, generatedAt: now, updatedAt: now },
    ]);

    const res = await app.request(
      "/v1/collections/coding-agents/daily-summaries?from=2026-06-01&to=2026-06-30",
      {},
      { DB: db as any /* + the standard test env fields */ },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaries.map((s: any) => s.date)).toEqual(["2026-06-11", "2026-06-10"]);
    expect(body.summaries[0].takeaways).toEqual(["b", "c"]);
  });

  test("404 for an unknown collection", async () => {
    const { db } = createTestDb();
    const res = await app.request(
      "/v1/collections/nope/daily-summaries",
      {},
      { DB: db as any },
    );
    expect(res.status).toBe(404);
  });
});
```

(Replace `app`/env construction with whatever the sibling collections route test uses — match it exactly.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test workers/api/test/collection-daily-summaries-route.test.ts`
Expected: FAIL — route returns 404 for the valid slug (handler not yet added).

- [ ] **Step 4: Add the route**

In `workers/api/src/routes/collections.ts`, register before the admin-writes section. Default range = last 30 days when params omitted:

```ts
collectionRoutes.get(
  "/collections/:slug/daily-summaries",
  describeRoute({
    tags: ["Collections"],
    summary: "Daily summary rollups for a collection",
    description:
      "Per-(collection, Eastern-day) rollups: a headline title, a one-line summary, and bullet takeaways for the releases that shipped that day across the collection's members. `from`/`to` are inclusive YYYY-MM-DD ET dates; omit for the last 30 days. Newest first.",
    parameters: [
      { name: "slug", in: "path", required: true, schema: { type: "string" } },
      { name: "from", in: "query", required: false, schema: { type: "string" }, description: "Inclusive start date (YYYY-MM-DD, ET)." },
      { name: "to", in: "query", required: false, schema: { type: "string" }, description: "Inclusive end date (YYYY-MM-DD, ET)." },
    ],
    responses: {
      200: { description: "Daily summaries.", content: { "application/json": { schema: resolver(CollectionDailySummariesResponseSchema) } } },
      404: { description: "No collection with that slug.", content: { "application/json": { schema: resolver(ErrorResponseSchema) } } },
    },
  }),
  async (c) => {
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);
    const [collection] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.slug, slug));
    if (!collection) {
      return c.json({ error: "not_found", message: "Collection not found" }, 404);
    }
    const today = etDayKey(new Date());
    const from = c.req.query("from") ?? addDaysToDateKey(today, -30);
    const to = c.req.query("to") ?? today;
    const summaries = await listCollectionDailySummaries(db, collection.id, from, to);
    return c.json({ summaries });
  },
);
```

Add the imports at the top of the file:

```ts
import { etDayKey, addDaysToDateKey } from "@buildinternet/releases-core/dates";
import { listCollectionDailySummaries } from "../queries/collection-summaries.js";
import { CollectionDailySummariesResponseSchema } from "@buildinternet/releases-api-types";
```

- [ ] **Step 5: Add the on-demand workflow route**

In the same file (or the workflows route module if `/v1/workflows/*` lives elsewhere — grep for an existing `/v1/workflows/batch-overview` registration and co-locate), add an admin-gated POST that generates one collection/day on demand. Reuse the cron's `generateCollectionSummariesForDay` and the lane resolver:

```ts
// POST /v1/workflows/collection-summaries { collectionId?, date?, dryRun? }
// Admin-gated by the same middleware as the other /v1/workflows/* jobs.
workflowRoutes.post("/workflows/collection-summaries", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const date = typeof body.date === "string" ? body.date : addDaysToDateKey(etDayKey(new Date()), -1);
  const dryRun = body.dryRun === true;
  const db = createDb(c.env.DB);
  const model = await resolveCollectionSummaryModel(c.env);
  if (!model) return c.json({ error: "no_model", message: "No text model configured" }, 503);

  if (dryRun) {
    // Preview without writing: count eligible collections + releases for the day.
    return c.json({ date, dryRun: true });
  }
  const result = await generateCollectionSummariesForDay(db, model, date);
  return c.json({ date, ...result });
});
```

(Match the actual workflows router variable name + auth middleware used by `batch-overview`. If `/v1/workflows/*` is registered in `routes/collections.ts` it is the wrong home — put it where the other workflow jobs live.)

- [ ] **Step 5b: Accept `dailySummaryEnabled` in the collection PATCH handler**

The `collections` schema comment documents that flags toggle via `PATCH /v1/collections/:slug` (the same place `isFeatured` is set). Find that PATCH handler in `workers/api/src/routes/collections.ts` and add `daily_summary_enabled` to its accepted body fields, mirroring exactly how `isFeatured` is parsed and written (same Zod field in the request schema in `packages/api-types`, same `set: {...}` update). Add an assertion to the route test that `PATCH /v1/collections/:slug { dailySummaryEnabled: false }` persists and is reflected on the next read. This is the operator off-switch the cron honors (the CLI `admin collection` toggle lands in the separate OSS CLI repo and is out of scope for this plan).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test workers/api/test/collection-daily-summaries-route.test.ts`
Expected: PASS.

- [ ] **Step 7: OpenAPI coverage gate + type-check**

The repo has an OpenAPI coverage gate (#894). Run the full worker test + tsc:
Run: `cd workers/api && npx tsc --noEmit && bun test`
Expected: no errors; coverage gate satisfied by the `describeRoute` block.

- [ ] **Step 8: Commit**

```bash
git add packages/api-types/src/schemas/collections.ts packages/api-types/src/api-types.ts \
  workers/api/src/routes/collections.ts workers/api/test/collection-daily-summaries-route.test.ts
git commit -m "feat(api): daily-summaries route + on-demand workflow"
```

---

## Task 8: Cron wiring + config

**Files:**
- Modify: `workers/api/src/index.ts`
- Modify: `workers/api/wrangler.jsonc`

- [ ] **Step 1: Register the cron dispatch**

In `workers/api/src/index.ts`:

1. Import near the other cron imports:

```ts
import { runCollectionSummaries } from "./cron/collection-summaries.js";
```

2. In the `scheduled()` handler, add a dispatch block for a new cron string. Use `0 6 * * *` (06:00 UTC ≈ 01:00–02:00 ET — the prior ET day is fully closed). It shares the tick with `well-known-sync` (`0 6 * * *`); add the call inside that block OR give it a distinct minute. To keep dispatch sites isolated, use `15 6 * * *`:

```ts
    if (event.cron === "15 6 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "collection-summaries-cron",
          runCollectionSummaries(
            {
              DB: env.DB,
              CRON_ENABLED: env.CRON_ENABLED,
              FLAGS: env.FLAGS,
              ENVIRONMENT: env.ENVIRONMENT,
              OPENROUTER_ENABLED: env.OPENROUTER_ENABLED,
              OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
              OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL,
              COLLECTION_SUMMARY_MODEL: env.COLLECTION_SUMMARY_MODEL,
              COLLECTION_SUMMARY_CATCHUP_DAYS: env.COLLECTION_SUMMARY_CATCHUP_DAYS,
              ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
              // + the same Anthropic gateway/env fields the other AI-lane crons pass
            },
            new Date(event.scheduledTime),
          ),
          alertEnv,
        ),
      );
      return;
    }
```

3. Add `COLLECTION_SUMMARY_MODEL?: string;` and `COLLECTION_SUMMARY_CATCHUP_DAYS?: string;` to the worker `Env` `Bindings` interface (next to `SUMMARIZE_MODEL`). Match the exact Anthropic env fields passed by `batch-summarize`/`feed-enrich` so the lane resolves identically.

- [ ] **Step 2: Add the cron trigger + var to wrangler.jsonc**

In `workers/api/wrangler.jsonc`, add `"15 6 * * *"` to the `triggers.crons` array, and add to the `vars` block:

```jsonc
    "COLLECTION_SUMMARY_MODEL": "",
```

(Empty default keeps the lane on Anthropic Haiku until a cheap OpenRouter model id is set in prod vars. Do NOT add a cron trigger to the `[env.staging]` block — staging runs no crons.)

- [ ] **Step 3: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/index.ts workers/api/wrangler.jsonc
git commit -m "feat(api): wire collection-summaries cron + COLLECTION_SUMMARY_MODEL"
```

---

## Task 9: Web rendering

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/app/collections/[slug]/page.tsx`
- Modify: `web/src/components/collection-timeline.tsx`

- [ ] **Step 1: Add the API client method**

In `web/src/lib/api.ts`, near `collectionReleases`:

```ts
  collectionDailySummaries: (slug: string, from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetchApi<CollectionDailySummariesResponse>(
      `/v1/collections/${slug}/daily-summaries${suffix}`,
    );
  },
```

Import the type: `import type { CollectionDailySummariesResponse } from "@buildinternet/releases-api-types";` (match the existing import style in the file).

- [ ] **Step 2: Fetch summaries on the collection page**

In `web/src/app/collections/[slug]/page.tsx`, alongside the cached `api.collectionReleases(slug)` call, fetch summaries (default range, fail-soft to empty) and pass a `Map<string, CollectionDailySummary>` to the timeline:

```tsx
const summariesRes = await api
  .collectionDailySummaries(slug)
  .catch(() => ({ summaries: [] as CollectionDailySummary[] }));
const summaryByDate = new Map(summariesRes.summaries.map((s) => [s.date, s]));
```

Pass `summaryByDate={summaryByDate}` into `<CollectionTimeline ... />`. (Wrap the fetch in the same `cache()` pattern the page uses for the other two calls.)

- [ ] **Step 3: ET day key + prop threading in the timeline**

In `web/src/components/collection-timeline.tsx`:

1. Replace the UTC-slicing `dayKey` (line ~65) with an ET key so buckets align with the server's `summary_date`:

```ts
const ET_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayKey = (iso: string | null) => (iso ? ET_DAY_FMT.format(new Date(iso)) : "unknown");
```

2. Switch `fmtWeekday`/`fmtDay` (lines ~67-77) to `timeZone: "America/New_York"` so the rendered date label matches the bucket.

3. Add `summaryByDate` to `CollectionTimelineProps` and the component signature:

```ts
  summaryByDate?: Map<string, CollectionDailySummary>;
```

```ts
export function CollectionTimeline({
  fetchEndpoint,
  formatPath,
  initialReleases,
  initialCursor,
  members,
  summaryByDate,
}: CollectionTimelineProps) {
```

Import the type: `import type { CollectionDailySummary } from "@buildinternet/releases-api-types";`

4. Thread it into the render loop (line ~346):

```tsx
          {days.map((day) => (
            <DaySection
              key={day.key}
              day={day}
              orgsBySlug={orgsBySlug}
              summary={summaryByDate?.get(day.key) ?? null}
            />
          ))}
```

- [ ] **Step 4: Render the header in `DaySection`**

Add `summary` to `DaySection`'s props and render a `DailySummaryHeader` above the day's release cards. Add the component (no emojis, per project UI convention; reuse the subdued tone classes already in the file):

```tsx
function DailySummaryHeader({ summary }: { summary: CollectionDailySummary }) {
  return (
    <div className="mb-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 px-4 py-3">
      <h3 className="text-[15px] font-semibold text-stone-900 dark:text-stone-100">
        {summary.title}
      </h3>
      <p className="mt-0.5 text-[13px] text-stone-600 dark:text-stone-400">{summary.summary}</p>
      {summary.takeaways.length > 0 && (
        <ul className="mt-2 space-y-1 pl-4 list-disc marker:text-stone-400 dark:marker:text-stone-600">
          {summary.takeaways.map((t, i) => (
            <li key={i} className="text-[13px] text-stone-700 dark:text-stone-300">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Render it at the top of the `DaySection` body, before the existing day content, when `summary` is present.

- [ ] **Step 5: Verify build + types**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

Note (from memory `worktree-portless-no-hydration`): a worktree subdomain SSRs but never hydrates — to visually verify interactivity, run a plain `next dev` with `RELEASES_API_URL` pointed at a backend that serves the new route, not the portless worktree subdomain.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/app/collections/[slug]/page.tsx web/src/components/collection-timeline.tsx
git commit -m "feat(web): daily summary headers on the collection timeline"
```

---

## Task 10: On-demand prompt eval (not CI-gated)

**Files:**
- Create: `tests/evals/collection-summary.eval.ts`

- [ ] **Step 1: Write the eval**

Mirror `tests/evals/release-summary.eval.ts` structure (manual, on-demand — calls a real model, costs money). Feed a couple of fixed day-windows of real releases through `summarizeCollectionDay` and assert structural quality (title length ≤ 90, summary is one sentence, ≤ 5 takeaways, no banned marketing words). Gate behind the same manual-run convention the other evals use (no CI hook). Reuse the `rubric-grader` agent path if a judged quality score is wanted.

- [ ] **Step 2: Document the run command**

Add a one-line note to the evals section of `AGENTS.md` if a new `eval:*` script is added to `package.json`; otherwise document the `bun test tests/evals/collection-summary.eval.ts` invocation in the file header. Evals are manual — do NOT add to the default `test` script.

- [ ] **Step 3: Commit**

```bash
git add tests/evals/collection-summary.eval.ts
git commit -m "test(evals): on-demand collection daily-summary quality eval"
```

---

## Final verification

- [ ] **Full type-check:** `npx tsc --noEmit` (root) + `cd workers/api && npx tsc --noEmit` + `cd web && npx tsc --noEmit` — all clean.
- [ ] **Full test run:** from repo root, `bun test` (runs the multi-dir suite then `workers/api` in its own process per AGENTS.md) — all green.
- [ ] **Lint + format:** `bun run lint` and `bun run format:check`.
- [ ] **Docs:** add a one-line entry to `AGENTS.md` Conventions for the daily-summary feature (rule + pointer), and a short section to `docs/architecture/web.md` describing the artifact, the cron, the route, and the ET boundary. Keep AGENTS.md to one line per the file's own guidance.
- [ ] **Prod rollout note (for the PR body):** set `COLLECTION_SUMMARY_MODEL` to a cheap OpenRouter model id in prod vars and ensure `openrouter-enabled` is ON in BOTH Flagship apps; the lane fails open to Anthropic Haiku until then. The cron is gated by `CRON_ENABLED` and runs prod-only.
