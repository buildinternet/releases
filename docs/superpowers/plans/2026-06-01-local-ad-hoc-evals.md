# Local Ad-hoc Regression Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two local, ad-hoc, code-graded-first regression evals — one for the marketing classifier, one for release summarization — runnable only via `bun run eval:*`.

**Architecture:** Pure grading logic (`graders.ts`) is TDD'd with a CI-safe `graders.test.ts`. Two thin `*.eval.ts` script entrypoints load committed fixtures, call the live `classifyMarketing` / `summarizeRelease` functions against the real Anthropic API, grade with the pure functions, print a report, and exit non-zero below a committed threshold. A `.eval.ts` extension keeps them out of Bun's default test collection; an `ANTHROPIC_API_KEY` guard makes accidental runs free and safe.

**Tech Stack:** Bun, TypeScript (strict), `@releases/ai-internal` (`classifyMarketing`, `summarizeRelease`, `buildGraderPrompt`), `@anthropic-ai/sdk`, `bun:test` for the grader unit tests.

Spec: `docs/superpowers/specs/2026-06-01-local-ad-hoc-evals-design.md`.

---

## Tasks

### Task 0: Worktree dependencies

**Files:** none (environment only)

- [ ] **Step 1: Install deps in the worktree**

A fresh worktree has no `node_modules`; workspace imports silently resolve to the main checkout until installed.

Run: `bun install`
Expected: completes; `test -d node_modules && echo ok` prints `ok`.

- [ ] **Step 2: Confirm the baseline test command works**

Run: `bun test tests/evals/ 2>&1 | tail -5`
Expected: existing `evaluation.eval.ts` is **not** collected (it's `.eval.ts`); command reports 0 failures (it may report "0 tests" — that's fine).

---

### Task 1: `gradeBinary` (TDD)

**Files:**

- Create: `tests/evals/graders.ts`
- Test: `tests/evals/graders.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evals/graders.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { gradeBinary } from "./graders";

describe("gradeBinary", () => {
  it("computes accuracy and direction-split errors", () => {
    const cases = [
      { id: "a", expected: true }, // marketing
      { id: "b", expected: false }, // real release
      { id: "c", expected: false }, // real release
      { id: "d", expected: true }, // marketing
    ];
    const predictions = [
      { id: "a", predicted: true }, // correct
      { id: "b", predicted: true }, // FALSE POSITIVE — real release hidden
      { id: "c", predicted: false }, // correct
      { id: "d", predicted: false }, // false negative — marketing slipped through
    ];

    const r = gradeBinary(cases, predictions);

    expect(r.total).toBe(4);
    expect(r.correct).toBe(2);
    expect(r.accuracy).toBe(0.5);
    expect(r.falsePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.perCase.find((c) => c.id === "b")!.passed).toBe(false);
  });

  it("throws when a case has no prediction", () => {
    expect(() => gradeBinary([{ id: "x", expected: true }], [])).toThrow(/no prediction/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evals/graders.test.ts`
Expected: FAIL — `Cannot find module "./graders"` / `gradeBinary is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `tests/evals/graders.ts`:

```ts
/**
 * Pure grading helpers for the local ad-hoc evals. No AI, no fs — unit-tested
 * deterministically in graders.test.ts (which DOES run under `bun test`).
 */
import type { FieldResult } from "./helpers";

// ── Binary grading (marketing classifier) ──────────────────────────

export interface BinaryCase {
  id: string;
  /** Ground-truth label: true == marketing (should be suppressed). */
  expected: boolean;
}
export interface BinaryPrediction {
  id: string;
  predicted: boolean;
}
export interface BinaryGradeResult {
  total: number;
  correct: number;
  accuracy: number;
  /** Predicted marketing, actually a real release → a real release gets hidden. The costly error. */
  falsePositives: number;
  /** Predicted real, actually marketing → marketing slips through. The cheaper error. */
  falseNegatives: number;
  perCase: Array<{ id: string; expected: boolean; predicted: boolean; passed: boolean }>;
}

export function gradeBinary(
  cases: BinaryCase[],
  predictions: BinaryPrediction[],
): BinaryGradeResult {
  const byId = new Map(predictions.map((p) => [p.id, p.predicted]));
  let correct = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const perCase: BinaryGradeResult["perCase"] = [];

  for (const c of cases) {
    if (!byId.has(c.id)) throw new Error(`no prediction for case "${c.id}"`);
    const predicted = byId.get(c.id)!;
    const passed = predicted === c.expected;
    if (passed) correct++;
    else if (predicted && !c.expected) falsePositives++;
    else if (!predicted && c.expected) falseNegatives++;
    perCase.push({ id: c.id, expected: c.expected, predicted, passed });
  }

  return {
    total: cases.length,
    correct,
    accuracy: cases.length > 0 ? correct / cases.length : 0,
    falsePositives,
    falseNegatives,
    perCase,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evals/graders.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/evals/graders.ts tests/evals/graders.test.ts
git commit -m "feat(evals): add gradeBinary for marketing classifier grading"
```

---

### Task 2: `gradeStructural` (TDD)

**Files:**

- Modify: `tests/evals/graders.ts`
- Test: `tests/evals/graders.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/evals/graders.test.ts`:

````ts
import { gradeStructural } from "./graders";

const ok = {
  summary: "Query planner now parallelizes joins; cuts p99 by 30%.",
  titleShort: "Parallel joins land",
  skipped: false,
};

describe("gradeStructural", () => {
  it("passes when an empty body was discarded", () => {
    const r = gradeStructural(
      { expectDiscarded: true },
      { summary: null, titleShort: null, skipped: true },
    );
    expect(r.passed).toBe(true);
  });

  it("fails when a discard was expected but a summary was produced", () => {
    const r = gradeStructural({ expectDiscarded: true }, ok);
    expect(r.passed).toBe(false);
  });

  it("passes a clean non-empty summary", () => {
    const r = gradeStructural({ expectDiscarded: false }, ok);
    expect(r.passed).toBe(true);
  });

  it("fails on markdown-fence leakage", () => {
    const r = gradeStructural({ expectDiscarded: false }, { ...ok, summary: "```\nfoo\n```" });
    expect(r.passed).toBe(false);
  });

  it("fails when titleShort exceeds the length bound", () => {
    const r = gradeStructural(
      { expectDiscarded: false },
      { ...ok, titleShort: "x".repeat(200) },
      { titleShortMaxChars: 120 },
    );
    expect(r.passed).toBe(false);
  });

  it("fails when an extra-forbidden sentinel leaks into the summary", () => {
    const r = gradeStructural(
      { expectDiscarded: false },
      { ...ok, summary: "Release notes do not describe the change." },
      { extraForbidden: ["Release notes do not describe the change."] },
    );
    expect(r.passed).toBe(false);
  });
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evals/graders.test.ts`
Expected: FAIL — `gradeStructural is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `tests/evals/graders.ts`:

````ts
// ── Structural grading (release summary, Tier 1) ───────────────────

/** Unambiguous leakage signals — always checked in summary + titleShort. */
export const DEFAULT_FORBIDDEN_SUBSTRINGS = ["</", "```", "Body:"];

export interface StructuralSpec {
  /** true => empty/boilerplate body: summary + titleShort must be null. */
  expectDiscarded: boolean;
  /** Defaults to true when not discarded. */
  summaryMustBeNonEmpty?: boolean;
  /** Per-fixture leakage tokens, on top of the defaults. */
  forbidInSummary?: string[];
}
export interface SummaryArtifact {
  summary: string | null;
  titleShort: string | null;
  skipped: boolean;
}
export interface StructuralGradeOptions {
  titleShortMaxChars?: number;
  /** Caller-injected tokens, e.g. the EMPTY_BODY_FALLBACK sentinel. */
  extraForbidden?: string[];
}
export interface StructuralGradeResult {
  passed: boolean;
  fields: FieldResult[];
}

export function gradeStructural(
  spec: StructuralSpec,
  artifact: SummaryArtifact,
  opts: StructuralGradeOptions = {},
): StructuralGradeResult {
  const fields: FieldResult[] = [];
  const max = opts.titleShortMaxChars ?? 120;

  if (spec.expectDiscarded) {
    fields.push({
      field: "summary discarded",
      passed: artifact.summary === null,
      expected: null,
      actual: artifact.summary,
    });
    fields.push({
      field: "titleShort discarded",
      passed: artifact.titleShort === null,
      expected: null,
      actual: artifact.titleShort,
    });
    return { passed: fields.every((f) => f.passed), fields };
  }

  const mustBeNonEmpty = spec.summaryMustBeNonEmpty ?? true;
  if (mustBeNonEmpty) {
    const nonEmpty = artifact.summary !== null && artifact.summary.trim().length > 0;
    fields.push({
      field: "summary non-empty",
      passed: nonEmpty,
      expected: "non-empty",
      actual: artifact.summary,
    });
  }

  const forbidden = [
    ...DEFAULT_FORBIDDEN_SUBSTRINGS,
    ...(opts.extraForbidden ?? []),
    ...(spec.forbidInSummary ?? []),
  ];
  for (const [label, text] of [
    ["summary", artifact.summary],
    ["titleShort", artifact.titleShort],
  ] as const) {
    if (text === null) continue;
    const hit = forbidden.find((tok) => text.includes(tok));
    fields.push({
      field: `no leakage (${label})`,
      passed: hit === undefined,
      expected: "clean",
      actual: hit ?? "clean",
    });
  }

  if (artifact.titleShort !== null) {
    fields.push({
      field: "titleShort length",
      passed: artifact.titleShort.length <= max,
      expected: `<= ${max}`,
      actual: artifact.titleShort.length,
    });
  }

  return { passed: fields.every((f) => f.passed), fields };
}
````

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evals/graders.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add tests/evals/graders.ts tests/evals/graders.test.ts
git commit -m "feat(evals): add gradeStructural for Tier-1 summary checks"
```

---

### Task 3: Marketing fixtures

**Files:**

- Create: `tests/evals/fixtures/marketing/cases.json`
- Create: `tests/evals/fixtures/marketing/runs/.gitignore`

- [ ] **Step 1: Create the labeled fixture set**

Create `tests/evals/fixtures/marketing/cases.json` (12 cases — 6 real, 6 marketing — spanning the prompt's documented categories, including the event-with-launch edge that must stay `false`):

```json
[
  {
    "id": "clickhouse-version-release",
    "input": {
      "sourceName": "ClickHouse Blog",
      "title": "ClickHouse Release 26.4",
      "content": "New JSON data type GA, faster S3 reads, 40 bug fixes. Upgrade notes inside.",
      "url": "https://clickhouse.com/blog/clickhouse-release-26-04",
      "hint": null
    },
    "expected": { "isMarketing": false }
  },
  {
    "id": "nextjs-feature-ga",
    "input": {
      "sourceName": "Next.js Blog",
      "title": "Partial Prerendering is now stable",
      "content": "PPR graduates to stable in 15.5. How to adopt, config flags, and migration steps.",
      "url": "https://nextjs.org/blog/next-15-5",
      "hint": null
    },
    "expected": { "isMarketing": false }
  },
  {
    "id": "stripe-bugfix",
    "input": {
      "sourceName": "Stripe Changelog",
      "title": "Fixed incorrect tax rounding on multi-currency invoices",
      "content": "Invoices with mixed currencies could round tax to the wrong minor unit. Resolved for all accounts.",
      "url": "https://stripe.com/changelog/2026-05-20",
      "hint": null
    },
    "expected": { "isMarketing": false }
  },
  {
    "id": "cloudflare-security-advisory",
    "input": {
      "sourceName": "Cloudflare Blog",
      "title": "Security advisory: WAF bypass via crafted header",
      "content": "We patched a bypass affecting custom rules. No customer action required; details and timeline below.",
      "url": "https://blog.cloudflare.com/security-advisory-waf",
      "hint": null
    },
    "expected": { "isMarketing": false }
  },
  {
    "id": "supabase-integration-capability",
    "input": {
      "sourceName": "Supabase Blog",
      "title": "Foreign data wrappers: query Stripe from Postgres",
      "content": "New FDW ships today. Create a wrapper, map columns, and query external APIs as tables.",
      "url": "https://supabase.com/blog/fdw-stripe",
      "hint": null
    },
    "expected": { "isMarketing": false }
  },
  {
    "id": "clickhouse-event-with-launch",
    "input": {
      "sourceName": "ClickHouse Blog",
      "title": "ClickHouse at FOSDEM: announcing ClickPipes GA",
      "content": "At our FOSDEM booth we launched ClickPipes GA — managed ingestion from Kafka with exactly-once delivery, available now.",
      "url": "https://clickhouse.com/blog/fosdem-clickpipes-ga",
      "hint": null
    },
    "expected": { "isMarketing": false }
  },
  {
    "id": "vendor-customer-case-study",
    "input": {
      "sourceName": "Acme Blog",
      "title": "How Globex cut infra costs 60% with Acme",
      "content": "Globex migrated 200 services to Acme and reduced spend dramatically. Read their story.",
      "url": "https://acme.com/blog/globex",
      "hint": null
    },
    "expected": { "isMarketing": true, "reason": "case_study" }
  },
  {
    "id": "monthly-newsletter",
    "input": {
      "sourceName": "Acme Blog",
      "title": "Acme April 2026 newsletter",
      "content": "A roundup of what we shipped, upcoming webinars, and community highlights this month.",
      "url": "https://acme.com/blog/april-2026-newsletter",
      "hint": null
    },
    "expected": { "isMarketing": true, "reason": "newsletter" }
  },
  {
    "id": "event-recap-no-news",
    "input": {
      "sourceName": "Acme Blog",
      "title": "Recap: our week at KubeCon 2026",
      "content": "Great conversations at the booth, packed talks, and swag galore. Thanks for stopping by!",
      "url": "https://acme.com/blog/kubecon-2026-recap",
      "hint": null
    },
    "expected": { "isMarketing": true, "reason": "event_recap" }
  },
  {
    "id": "partner-announcement",
    "input": {
      "sourceName": "Acme Blog",
      "title": "Acme joins the AWS ISV Accelerate Program",
      "content": "We are proud to announce our membership and a new strategic partnership with AWS.",
      "url": "https://acme.com/blog/aws-isv-accelerate",
      "hint": null
    },
    "expected": { "isMarketing": true, "reason": "partner_announcement" }
  },
  {
    "id": "positioning-piece",
    "input": {
      "sourceName": "Acme Blog",
      "title": "Why AI is reshaping the database market",
      "content": "A thought-leadership look at where data infrastructure is heading over the next decade.",
      "url": "https://acme.com/blog/ai-reshaping-databases",
      "hint": null
    },
    "expected": { "isMarketing": true, "reason": "positioning_piece" }
  },
  {
    "id": "localized-marketing",
    "input": {
      "sourceName": "Acme Blog",
      "title": "Globexがアクメで60%コスト削減した方法",
      "content": "Globexの導入事例の日本語版です。",
      "url": "https://acme.com/blog/globex-jp",
      "hint": null
    },
    "expected": { "isMarketing": true, "reason": "localized_marketing" }
  }
]
```

- [ ] **Step 2: Create the runs gitignore**

Create `tests/evals/fixtures/marketing/runs/.gitignore`:

```gitignore
*.json
```

- [ ] **Step 3: Verify the JSON parses**

Run: `bun -e "console.log(JSON.parse(require('fs').readFileSync('tests/evals/fixtures/marketing/cases.json','utf8')).length + ' cases')"`
Expected: `12 cases`.

- [ ] **Step 4: Commit**

```bash
git add tests/evals/fixtures/marketing
git commit -m "test(evals): add 12 labeled marketing-classifier fixtures"
```

---

### Task 4: Marketing classifier eval entrypoint

**Files:**

- Create: `tests/evals/marketing-classifier.eval.ts`

- [ ] **Step 1: Write the entrypoint**

Create `tests/evals/marketing-classifier.eval.ts`:

```ts
/**
 * Marketing-classifier regression eval. LOCAL, AD-HOC ONLY — calls the real
 * Anthropic API. Run: `bun run eval:marketing`. Never part of `bun test`.
 *
 * Gate: pass iff accuracy >= ACCURACY_FLOOR AND falsePositives <= MAX_FALSE_POSITIVES.
 * A false positive = a real release misclassified as marketing (it would be
 * hidden), which the classifier prompt explicitly treats as the costly error.
 */
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  classifyMarketing,
  type MarketingClassifierInput,
} from "@releases/ai-internal/marketing-classifier";
import { gradeBinary, type BinaryCase, type BinaryPrediction } from "./graders";
import { saveResults } from "./helpers";

const ACCURACY_FLOOR = 0.85; // headroom for 1-run noise on ~12 cases
const MAX_FALSE_POSITIVES = 0; // no real release should be hidden
const RUNS_PER_CASE = 1; // raise + majority-vote as the fixture set grows

interface MarketingFixture {
  id: string;
  input: MarketingClassifierInput;
  expected: { isMarketing: boolean; reason?: string };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping marketing eval (no spend).");
    process.exit(0);
  }

  const dir = join(import.meta.dir, "fixtures", "marketing");
  const fixtures = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as MarketingFixture[];
  const client = new Anthropic({ apiKey });

  const cases: BinaryCase[] = [];
  const predictions: BinaryPrediction[] = [];

  for (const f of fixtures) {
    cases.push({ id: f.id, expected: f.expected.isMarketing });
    const votes: boolean[] = [];
    for (let i = 0; i < RUNS_PER_CASE; i++) {
      const r = await classifyMarketing(client, f.input);
      votes.push(r.isMarketing);
    }
    const trueVotes = votes.filter(Boolean).length;
    predictions.push({ id: f.id, predicted: trueVotes * 2 > votes.length });
  }

  const result = gradeBinary(cases, predictions);
  const pass = result.accuracy >= ACCURACY_FLOOR && result.falsePositives <= MAX_FALSE_POSITIVES;

  console.error(`\n${"=".repeat(60)}`);
  console.error(
    `Marketing classifier: ${result.correct}/${result.total} correct (${(result.accuracy * 100).toFixed(1)}%)`,
  );
  console.error(
    `  false positives (real release hidden): ${result.falsePositives}  [max ${MAX_FALSE_POSITIVES}]`,
  );
  console.error(`  false negatives (marketing kept):      ${result.falseNegatives}`);
  console.error("=".repeat(60));
  for (const c of result.perCase) {
    if (!c.passed)
      console.error(
        `  FAIL ${c.id}: expected ${c.expected ? "marketing" : "real"}, got ${c.predicted ? "marketing" : "real"}`,
      );
  }
  console.error(
    `\n${pass ? "PASS" : "FAIL"} (floor ${ACCURACY_FLOOR}, max FP ${MAX_FALSE_POSITIVES})\n`,
  );

  saveResults(
    [
      {
        fixture: "marketing",
        passed: pass,
        releaseCountMatch: true,
        expectedCount: result.total,
        actualCount: result.total,
        releases: [],
        score: result.accuracy,
      },
    ],
    join(dir, "runs", `marketing-${Date.now()}.json`),
  );

  process.exit(pass ? 0 : 1);
}

main();
```

- [ ] **Step 2: Verify the safe-skip path (no key) works**

This exercises module load (catches import/syntax errors) and the guard, with zero spend.

Run: `env -u ANTHROPIC_API_KEY bun tests/evals/marketing-classifier.eval.ts; echo "exit=$?"`
Expected: prints the skip notice and `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add tests/evals/marketing-classifier.eval.ts
git commit -m "feat(evals): add marketing-classifier regression eval entrypoint"
```

---

### Task 5: Export the empty-body sentinel

**Files:**

- Modify: `packages/ai/src/release-content.ts:34`

The summary eval checks the empty-body fallback never leaks into a non-empty summary. Importing the constant (rather than re-typing the literal) keeps the eval from drifting if the sentinel text changes. This is an additive export on a private workspace package — no changeset, no schema migration.

- [ ] **Step 1: Add the export keyword**

In `packages/ai/src/release-content.ts`, change line 34 from:

```ts
const EMPTY_BODY_FALLBACK = "Release notes do not describe the change.";
```

to:

```ts
export const EMPTY_BODY_FALLBACK = "Release notes do not describe the change.";
```

- [ ] **Step 2: Verify the package still type-checks**

Run: `cd packages/ai && npx tsc --noEmit; cd ../..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ai/src/release-content.ts
git commit -m "refactor(ai): export EMPTY_BODY_FALLBACK for eval parity"
```

---

### Task 6: Summary fixtures

**Files:**

- Create: `tests/evals/fixtures/summaries/{feature,bugfix,breaking,mixed,docs-guide,marketing-fluff}.md` (+ `.expected.json` each)
- Create: `tests/evals/fixtures/summaries/{empty-depbump,boilerplate-pipeline}.md` (+ `.expected.json` each)
- Create: `tests/evals/fixtures/summaries/runs/.gitignore`

Each fixture is a body `.md` plus a `<name>.expected.json` of `{ input, spec }`. `input` omits `content` (the eval injects the `.md`).

- [ ] **Step 1: Create the six real-body fixtures**

`feature.md`:

```markdown
## v3.2.0

Added a `--watch` flag to the build command that incrementally rebuilds on file
changes. Cold builds are unaffected; warm rebuilds are ~8x faster on large repos.
```

`feature.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme CLI",
    "productName": null,
    "title": "v3.2.0",
    "version": "3.2.0",
    "url": "https://acme.com/changelog/3-2-0"
  },
  "spec": { "expectDiscarded": false }
}
```

`bugfix.md`:

```markdown
## 1.9.4

Fixed a crash when opening a project whose `.config` file contained a BOM.
Fixed tooltips rendering off-screen on multi-monitor setups.
```

`bugfix.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme App",
    "productName": null,
    "title": "1.9.4",
    "version": "1.9.4",
    "url": "https://acme.com/changelog/1-9-4"
  },
  "spec": { "expectDiscarded": false }
}
```

`breaking.md`:

```markdown
## v5.0.0 — Breaking changes

The `legacyAuth` option has been removed. Calls using it now throw at startup.
Migrate to the `auth` block before upgrading. Minimum Node version is now 20.
```

`breaking.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme SDK",
    "productName": null,
    "title": "v5.0.0",
    "version": "5.0.0",
    "url": "https://acme.com/changelog/5-0-0"
  },
  "spec": { "expectDiscarded": false }
}
```

`mixed.md`:

```markdown
## 2026.5

Features: live collaboration cursors; export to PDF.
Fixes: corrected timezone offset in the audit log; resolved a memory leak in the
websocket reconnect loop.
```

`mixed.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme Cloud",
    "productName": null,
    "title": "2026.5",
    "version": "2026.5",
    "url": "https://acme.com/changelog/2026-5"
  },
  "spec": { "expectDiscarded": false }
}
```

`docs-guide.md`:

```markdown
## New guide: streaming responses

We published a walkthrough showing how to stream tokens from the Realtime API,
including backpressure handling and a reference client.
```

`docs-guide.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme Docs",
    "productName": null,
    "title": "New guide: streaming responses",
    "version": null,
    "url": "https://acme.com/blog/streaming-guide"
  },
  "spec": { "expectDiscarded": false }
}
```

`marketing-fluff.md`:

```markdown
## The most powerful release yet!

We're thrilled to share game-changing improvements that delight users. Buried in
the details: fixed a data-loss bug when two clients edited the same record, and
the Cmd+K palette no longer crashes on empty queries.
```

`marketing-fluff.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme Editor",
    "productName": null,
    "title": "The most powerful release yet!",
    "version": null,
    "url": "https://acme.com/blog/powerful-release"
  },
  "spec": { "expectDiscarded": false, "forbidInSummary": ["thrilled", "game-changing"] }
}
```

- [ ] **Step 2: Create the two discard fixtures**

`empty-depbump.md`:

```markdown
## 1.2.4

Bump lodash from 4.17.20 to 4.17.21.
```

`empty-depbump.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme Lib",
    "productName": null,
    "title": "1.2.4",
    "version": "1.2.4",
    "url": "https://acme.com/changelog/1-2-4"
  },
  "spec": { "expectDiscarded": true }
}
```

`boilerplate-pipeline.md`:

```markdown
## Automated release 2026.05.31

This release was generated by CI. No user-facing changes.
```

`boilerplate-pipeline.expected.json`:

```json
{
  "input": {
    "orgSlug": "acme",
    "sourceName": "Acme Internal",
    "productName": null,
    "title": "Automated release 2026.05.31",
    "version": null,
    "url": "https://acme.com/changelog/2026-05-31"
  },
  "spec": { "expectDiscarded": true }
}
```

- [ ] **Step 3: Create the runs gitignore**

Create `tests/evals/fixtures/summaries/runs/.gitignore`:

```gitignore
*.json
```

- [ ] **Step 4: Verify every fixture pairs and parses**

Run:

```bash
bun -e '
const fs=require("fs"),p="tests/evals/fixtures/summaries";
const md=fs.readdirSync(p).filter(f=>f.endsWith(".md"));
for(const f of md){const j=f.replace(/\.md$/,".expected.json");const o=JSON.parse(fs.readFileSync(p+"/"+j,"utf8"));if(!o.input||!o.spec)throw new Error("bad "+j);}
console.log(md.length+" fixtures OK");
'
```

Expected: `8 fixtures OK`.

- [ ] **Step 5: Commit**

```bash
git add tests/evals/fixtures/summaries
git commit -m "test(evals): add 8 release-summary fixtures (6 real, 2 discard)"
```

---

### Task 7: Summary rubric (Tier-2 judge)

**Files:**

- Create: `src/shared/rubrics/release-summary.md`

- [ ] **Step 1: Write the rubric**

Create `src/shared/rubrics/release-summary.md`:

```markdown
# Release summary faithfulness rubric

The artifact is a generated `summary` (and `title_short`) for a single software
release. The body it was generated from is provided as context in the artifact.
Grade each criterion independently.

## Criteria

1. **Faithful to the body.** Every claim in the summary is supported by the
   release body. No invented features, versions, numbers, or capabilities.
2. **No contradiction.** The summary does not state anything the body
   contradicts (e.g. calling a removal an addition).
3. **Leads with the user-facing outcome.** The summary foregrounds what changed
   for the user, not internal mechanism or marketing framing.
4. **No marketing fluff.** No hype adjectives ("thrilled", "game-changing",
   "most powerful") carried over from a promotional body; the real change is
   surfaced even when buried.
5. **No format leakage.** No raw XML tags, markdown code fences, or echoed input
   labels ("Body:", "Title:").
```

- [ ] **Step 2: Verify it reads**

Run: `test -s src/shared/rubrics/release-summary.md && echo ok`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/shared/rubrics/release-summary.md
git commit -m "feat(evals): add release-summary faithfulness rubric for Tier-2 judge"
```

---

### Task 8: Summary eval entrypoint (Tier 1 + opt-in Tier 2)

**Files:**

- Create: `tests/evals/release-summary.eval.ts`

- [ ] **Step 1: Write the entrypoint**

Create `tests/evals/release-summary.eval.ts`:

```ts
/**
 * Release-summary regression eval. LOCAL, AD-HOC ONLY — calls the real Anthropic
 * API. Run: `bun run eval:summary` (Tier-1 structural) or `bun run eval:summary -- --judge`
 * (adds the Sonnet faithfulness check). Never part of `bun test`.
 */
import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  summarizeRelease,
  EMPTY_BODY_FALLBACK,
  type SummarizeReleaseInput,
} from "@releases/ai-internal/release-content";
import { buildGraderPrompt } from "@releases/ai-internal/grader-prompt";
import { gradeStructural, type StructuralSpec } from "./graders";
import type { FieldResult } from "./helpers";

const TITLE_SHORT_MAX_CHARS = 120;
const JUDGE_MODEL = "claude-sonnet-4-6";

interface SummaryFixture {
  name: string;
  input: SummarizeReleaseInput;
  spec: StructuralSpec;
}

function loadFixtures(dir: string): SummaryFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((mdFile) => {
      const name = basename(mdFile, ".md");
      const meta = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as {
        input: Omit<SummarizeReleaseInput, "content">;
        spec: StructuralSpec;
      };
      const content = readFileSync(join(dir, mdFile), "utf8");
      return { name, input: { ...meta.input, content }, spec: meta.spec };
    });
}

async function judge(
  client: Anthropic,
  rubric: string,
  body: string,
  summary: string,
): Promise<boolean> {
  const prompt = buildGraderPrompt({
    rubric,
    artifact: `BODY:\n${body}\n\nSUMMARY:\n${summary}`,
    rubricLabel: "release-summary.md",
  });
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(raw).result === "satisfied";
  } catch {
    return false;
  }
}

async function main() {
  const useJudge = process.argv.includes("--judge");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping summary eval (no spend).");
    process.exit(0);
  }

  const dir = join(import.meta.dir, "fixtures", "summaries");
  const fixtures = loadFixtures(dir);
  const client = new Anthropic({ apiKey });
  const rubric = useJudge
    ? readFileSync(
        join(import.meta.dir, "..", "..", "src", "shared", "rubrics", "release-summary.md"),
        "utf8",
      )
    : "";

  let allPassed = true;
  console.error(`\n${"=".repeat(60)}`);
  console.error(`Release summary eval${useJudge ? " (+ judge)" : ""}: ${fixtures.length} fixtures`);
  console.error("=".repeat(60));

  for (const f of fixtures) {
    let fields: FieldResult[];
    let passed: boolean;
    try {
      const result = await summarizeRelease(client, f.input);
      ({ fields, passed } = gradeStructural(f.spec, result, {
        titleShortMaxChars: TITLE_SHORT_MAX_CHARS,
        extraForbidden: [EMPTY_BODY_FALLBACK],
      }));

      if (useJudge && !f.spec.expectDiscarded && result.summary) {
        const ok = await judge(client, rubric, f.input.content, result.summary);
        fields = [
          ...fields,
          {
            field: "judge: satisfied",
            passed: ok,
            expected: "satisfied",
            actual: ok ? "satisfied" : "not satisfied",
          },
        ];
        passed = passed && ok;
      }
    } catch (err) {
      fields = [
        {
          field: "summarizeRelease throws",
          passed: false,
          expected: "no throw",
          actual: String(err),
        },
      ];
      passed = false;
    }

    allPassed = allPassed && passed;
    console.error(`  ${passed ? "PASS" : "FAIL"}  ${f.name}`);
    for (const fld of fields)
      if (!fld.passed)
        console.error(
          `        ${fld.field}: expected=${JSON.stringify(fld.expected)}, actual=${JSON.stringify(fld.actual)}`,
        );
  }

  console.error(`\n${allPassed ? "PASS" : "FAIL"}\n`);
  process.exit(allPassed ? 0 : 1);
}

main();
```

- [ ] **Step 2: Verify the safe-skip path (no key) works**

Run: `env -u ANTHROPIC_API_KEY bun tests/evals/release-summary.eval.ts; echo "exit=$?"`
Expected: prints the skip notice and `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add tests/evals/release-summary.eval.ts
git commit -m "feat(evals): add release-summary regression eval (Tier 1 + opt-in judge)"
```

---

### Task 9: Wire up package.json scripts

**Files:**

- Modify: `package.json` (scripts block, next to `eval:evaluation`)

- [ ] **Step 1: Add the two scripts**

In `package.json`, after the `"eval:evaluation"` line, add:

```json
    "eval:marketing": "bun tests/evals/marketing-classifier.eval.ts",
    "eval:summary": "bun tests/evals/release-summary.eval.ts",
```

- [ ] **Step 2: Verify the scripts are registered and safe-skip**

Run: `bun run eval:marketing; echo "marketing exit=$?"`
Expected: skip notice (no key in this env) and `marketing exit=0`.

Run: `bun run eval:summary; echo "summary exit=$?"`
Expected: skip notice and `summary exit=0`.

- [ ] **Step 3: Confirm grader unit tests still pass and aren't disturbed**

Run: `bun test tests/evals/graders.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 4: Confirm the eval files stay out of the default test sweep**

Run: `bun test tests/evals/ 2>&1 | grep -c "marketing-classifier.eval\|release-summary.eval" || true`
Expected: `0` (the `.eval.ts` entrypoints are not collected).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(evals): add eval:marketing and eval:summary scripts"
```

---

## Self-Review

**Spec coverage:**

- Marketing binary eval + FP-weighted gate → Tasks 1, 3, 4. ✓
- Summary Tier-1 structural → Tasks 2, 6, 8. ✓
- Summary Tier-2 opt-in judge + rubric → Tasks 7, 8. ✓
- `graders.ts` (`gradeBinary`/`gradeStructural`) reusing `FieldResult` → Tasks 1, 2. ✓
- Local-only / never-CI (`.eval.ts`, skip-without-key) → Tasks 4, 8, 9 (verified in steps). ✓
- `package.json` scripts → Task 9. ✓
- Gitignored `runs/` dirs → Tasks 3, 6. ✓
- Sentinel-leak check needs an exported constant → Task 5 (gap found during research; added). ✓
- Thresholds as named constants with rationale → Tasks 4, 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete content. ✓

**Type consistency:** `BinaryCase`/`BinaryPrediction`/`BinaryGradeResult`, `StructuralSpec`/`SummaryArtifact`/`StructuralGradeResult`, and `FieldResult` (imported from `helpers.ts`) are used identically across Tasks 1, 2, 4, 8. The summary eval consumes `summarizeRelease`'s real return shape (`{summary, titleShort, skipped}`) which structurally satisfies `SummaryArtifact`. ✓

**Note on `saveResults` reuse (Task 4):** the marketing eval reuses `helpers.saveResults` with a minimal `FixtureResult`-shaped record purely for the JSON snapshot; the binary detail lives in stdout. This avoids a second persistence helper for v1.
