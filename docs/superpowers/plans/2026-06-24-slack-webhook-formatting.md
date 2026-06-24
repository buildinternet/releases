# Slack-formatted webhook delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user point a webhook subscription at a Slack incoming-webhook URL and receive releases as formatted Slack messages, selected by an explicit per-subscription `format` field.

**Architecture:** Reuse the entire existing subscription + fan-out + delivery pipeline. Add a `format` column (`json` default | `slack`). At delivery time the worker branches: `slack` formats the release into Slack Block Kit and POSTs it unsigned; `json` is today's signed raw-event path, unchanged. A new pure formatter lives in `packages/rendering`. Discord later = a sibling formatter + a new enum value, nothing else.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle/D1, `packages/rendering` (workspace), `packages/api-types` (wire protocol), the out-of-tree CLI at `~/Code/releases-cli`.

**Spec:** `docs/superpowers/specs/2026-06-24-slack-webhook-formatting-design.md`

## Global Constraints

- TypeScript strict mode. Root `npx tsc --noEmit` only checks `src/`; **each worker is type-checked separately** (`cd workers/<name> && npx tsc --noEmit`). Verify worker changes with the worker's own tsc + `bun test`.
- **Any `packages/core/src/schema.ts` change requires a paired migration** in `workers/api/migrations/` (CI gate). Real DDL here, so a normal `ALTER TABLE`.
- `packages/api-types` changes are **additive only** (new optional field, no rename/removal).
- **No feature flag** — additive, opt-in, low-risk; ships enabled (repo's "be judicious with feature flags" rule).
- **No emojis in the web UI** (icons/chips/text only).
- CLI changesets target the package name **`@buildinternet/releases`** (NOT `releases-cli`).
- Webhook format enum values are exactly `"json"` and `"slack"` everywhere (schema, migration CHECK, api-types, CLI, web).
- The canonical release URL is `https://releases.sh/release/{releaseId}` (web route `web/src/app/release/[id]/page.tsx`). The formatter accepts a `baseUrl` option defaulting to `https://releases.sh`.
- Run all monorepo commands from the worktree root `/Users/zachdunn/Code/releases/.claude/worktrees/slack-webhook-formatting`. CLI tasks run from `/Users/zachdunn/Code/releases-cli`.

---

### Task 1: Schema column + migration

**Files:**

- Modify: `packages/core/src/schema.ts` (webhook block ~lines 1031–1074)
- Create: `workers/api/migrations/20260624000000_add_webhook_format.sql`

**Interfaces:**

- Produces: `WEBHOOK_FORMATS` (`["json","slack"]`), `WebhookFormat` type, and a `format` column on `webhookSubscriptions` (so `WebhookSubscription.$inferSelect` gains `format: "json" | "slack"`).

- [ ] **Step 1: Add the enum + type next to `WEBHOOK_SCOPES` in `packages/core/src/schema.ts`** (just above `webhookSubscriptions`, near line 1031):

```ts
export const WEBHOOK_SCOPES = ["org", "follows"] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];

/** Output format for a webhook delivery. `json` = signed raw event; `slack` = Slack Block Kit. */
export const WEBHOOK_FORMATS = ["json", "slack"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];
```

- [ ] **Step 2: Add the `format` column to the `webhookSubscriptions` table** — put it immediately after the `description` column:

```ts
    description: text("description"),
    /** Delivery output format. `json` = signed raw event (default); `slack` = Slack Block Kit, unsigned. */
    format: text("format", { enum: WEBHOOK_FORMATS }).notNull().default("json"),
    secretVersion: integer("secret_version").notNull().default(1),
```

- [ ] **Step 3: Create the paired migration** `workers/api/migrations/20260624000000_add_webhook_format.sql`:

```sql
-- Webhook delivery format: json (default, signed raw event) or slack (Block Kit, unsigned).
ALTER TABLE webhook_subscriptions ADD COLUMN format TEXT NOT NULL DEFAULT 'json' CHECK(format IN ('json', 'slack'));
```

- [ ] **Step 4: Type-check core + the api worker**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit)`
Expected: PASS (no errors). The Drizzle row type now includes `format`.

- [ ] **Step 5: Verify the migration applies cleanly against a fresh local D1**

Run: `bun run db:reset:local`
Expected: completes without error (the new `ALTER TABLE` runs as the latest migration).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema.ts workers/api/migrations/20260624000000_add_webhook_format.sql
git commit -m "feat(webhooks): add format column (json|slack) to webhook_subscriptions"
```

---

### Task 2: Wire-protocol field in api-types

**Files:**

- Modify: `packages/api-types/src/api-types.ts` (webhook block ~lines 945–1012)

**Interfaces:**

- Consumes: nothing.
- Produces: `UserWebhookFormat` type; `format: UserWebhookFormat` on `UserWebhookSubscription` (inherited by `UserWebhookListItem` + `CreateUserWebhookResponse`); `signingKey` becomes optional on `CreateUserWebhookResponse`.

- [ ] **Step 1: Add the format type + field.** Below `UserWebhookReleaseTypeFilter` (~line 961) add:

```ts
/** Webhook delivery output format. */
export type UserWebhookFormat = "json" | "slack";
```

In `UserWebhookSubscription` (~lines 963–982), add the field after `releaseType`:

```ts
releaseType: UserWebhookReleaseTypeFilter | null;
format: UserWebhookFormat;
enabled: boolean;
```

- [ ] **Step 2: Make the one-time signing key optional on the create response** (~lines 1007–1012). Slack subs have no signature, so the key is omitted:

```ts
/** POST /v1/me/webhooks response — signing key shown once at creation (omitted for slack format). */
export interface CreateUserWebhookResponse
  extends UserWebhookSubscription, UserWebhookDeliveryHealth {
  orgSlug: string | null;
  orgName: string | null;
  signingKey?: string;
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api-types/src/api-types.ts
git commit -m "feat(api-types): add webhook format field; signingKey optional for slack"
```

---

### Task 3: Slack message formatter (packages/rendering)

**Files:**

- Create: `packages/rendering/src/slack-message.ts`
- Create: `packages/rendering/src/slack-message.test.ts`
- Modify: `packages/rendering/package.json` (exports map)

**Interfaces:**

- Produces: `formatSlackMessage(release: SlackReleaseInput, opts?: { baseUrl?: string }): SlackWebhookBody`, plus the `SlackReleaseInput` and `SlackWebhookBody` types. `SlackReleaseInput` is structurally satisfied by the worker's `ReleaseEventPayload` (same field names).

- [ ] **Step 1: Write the failing test** `packages/rendering/src/slack-message.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatSlackMessage, type SlackReleaseInput } from "./slack-message.js";

function release(overrides: Partial<SlackReleaseInput> = {}): SlackReleaseInput {
  return {
    id: "rel_abc",
    title: "Next.js",
    version: "15.4.0",
    publishedAt: "2026-06-24T10:00:00.000Z",
    summary: "Turbopack is now stable for production builds.",
    sourceName: "Next.js Releases",
    org: {
      name: "Vercel",
      avatarUrl: "https://media.releases.sh/orgs/vercel.png",
      githubHandle: "vercel",
    },
    product: null,
    ...overrides,
  };
}

describe("formatSlackMessage", () => {
  test("links the title with version and includes the summary", () => {
    const body = formatSlackMessage(release());
    const section = body.blocks[0] as any;
    expect(section.type).toBe("section");
    expect(section.text.text).toContain("<https://releases.sh/release/rel_abc|Next.js 15.4.0>");
    expect(section.text.text).toContain("Turbopack is now stable");
    expect(body.text).toBe("Vercel — Next.js 15.4.0");
  });

  test("renders org avatar + localized date in the context row", () => {
    const ctx = formatSlackMessage(release()).blocks[1] as any;
    expect(ctx.type).toBe("context");
    expect(ctx.elements[0]).toEqual({
      type: "image",
      image_url: "https://media.releases.sh/orgs/vercel.png",
      alt_text: "Vercel",
    });
    expect(ctx.elements[1].text).toContain("Vercel · <!date^");
    expect(ctx.elements[1].text).toContain("|2026-06-24>");
  });

  test("falls back to the github avatar when avatarUrl is null", () => {
    const ctx = formatSlackMessage(
      release({ org: { name: "Vercel", avatarUrl: null, githubHandle: "vercel" } }),
    ).blocks[1] as any;
    expect(ctx.elements[0].image_url).toBe("https://github.com/vercel.png");
  });

  test("omits the avatar element when no org/avatar resolves", () => {
    const ctx = formatSlackMessage(release({ org: null })).blocks[1] as any;
    expect(ctx.elements[0].type).toBe("mrkdwn");
    expect(ctx.elements[0].text).toContain("Next.js Releases");
  });

  test("title-only section when summary is null", () => {
    const section = formatSlackMessage(release({ summary: null })).blocks[0] as any;
    expect(section.text.text).toBe("*<https://releases.sh/release/rel_abc|Next.js 15.4.0>*");
  });

  test("drops the version suffix when version is null", () => {
    const section = formatSlackMessage(release({ version: null })).blocks[0] as any;
    expect(section.text.text).toContain("|Next.js>");
  });

  test("truncates a long summary on a word boundary with an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const section = formatSlackMessage(release({ summary: long })).blocks[0] as any;
    const line = section.text.text.split("\n")[1];
    expect(line.length).toBeLessThanOrEqual(301);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("wor…");
  });

  test("omits the date when publishedAt is null", () => {
    const ctx = formatSlackMessage(release({ publishedAt: null })).blocks[1] as any;
    expect(ctx.elements.at(-1).text).not.toContain("<!date");
  });

  test("escapes mrkdwn-sensitive characters in title and summary", () => {
    const section = formatSlackMessage(release({ title: "A & B <C>", summary: "x < y & z" }))
      .blocks[0] as any;
    expect(section.text.text).toContain("A &amp; B &lt;C&gt;");
    expect(section.text.text).toContain("x &lt; y &amp; z");
  });

  test("honors a custom baseUrl", () => {
    const section = formatSlackMessage(release(), { baseUrl: "https://staging.releases.sh" })
      .blocks[0] as any;
    expect(section.text.text).toContain("https://staging.releases.sh/release/rel_abc");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/rendering/src/slack-message.test.ts`
Expected: FAIL — `Cannot find module "./slack-message.js"`.

- [ ] **Step 3: Implement `packages/rendering/src/slack-message.ts`**

```ts
/**
 * Slack incoming-webhook message formatter. Pure + runtime-neutral so the
 * webhooks worker can render a release into Block Kit without importing
 * worker code. `SlackReleaseInput` is structurally satisfied by the worker's
 * `ReleaseEventPayload`. Discord later adds a sibling formatter + enum value.
 */

export interface SlackReleaseInput {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  summary: string | null;
  sourceName: string;
  org?: { name: string; avatarUrl: string | null; githubHandle: string | null } | null;
  product?: { name: string } | null;
}

export interface SlackWebhookBody {
  /** Plain-text fallback for notifications / unfurl-less clients. */
  text: string;
  blocks: Record<string, unknown>[];
}

const DEFAULT_BASE_URL = "https://releases.sh";
const SUMMARY_MAX = 300;

/** Slack mrkdwn requires escaping these three characters. */
function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Truncate to `max`, preferring a word boundary past 60% of the limit, with an ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

function avatarUrl(org: SlackReleaseInput["org"]): string | null {
  if (!org) return null;
  if (org.avatarUrl) return org.avatarUrl;
  if (org.githubHandle) return `https://github.com/${org.githubHandle}.png`;
  return null;
}

/** Slack `<!date>` mrkdwn so the timestamp localizes to the viewer; ISO date as fallback. */
function formatContextDate(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const ms = Date.parse(publishedAt);
  if (Number.isNaN(ms)) return null;
  const unix = Math.floor(ms / 1000);
  const fallback = publishedAt.slice(0, 10);
  return `<!date^${unix}^{date_short_pretty}|${fallback}>`;
}

export function formatSlackMessage(
  release: SlackReleaseInput,
  opts?: { baseUrl?: string },
): SlackWebhookBody {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/release/${release.id}`;
  const titleText = `${release.title}${release.version ? ` ${release.version}` : ""}`;
  const contextName = release.org?.name ?? release.product?.name ?? release.sourceName;

  const sectionLines = [`*<${url}|${escapeSlack(titleText)}>*`];
  if (release.summary) sectionLines.push(escapeSlack(truncate(release.summary, SUMMARY_MAX)));
  const blocks: Record<string, unknown>[] = [
    { type: "section", text: { type: "mrkdwn", text: sectionLines.join("\n") } },
  ];

  const elements: Record<string, unknown>[] = [];
  const avatar = avatarUrl(release.org);
  if (avatar) elements.push({ type: "image", image_url: avatar, alt_text: contextName });
  const datePart = formatContextDate(release.publishedAt);
  elements.push({
    type: "mrkdwn",
    text: datePart ? `${escapeSlack(contextName)} · ${datePart}` : escapeSlack(contextName),
  });
  blocks.push({ type: "context", elements });

  return { text: `${contextName} — ${titleText}`, blocks };
}
```

- [ ] **Step 4: Add the package export.** In `packages/rendering/package.json`, add to `exports` (keep alphabetical-ish ordering near the others):

```json
    "./rewrite-links": "./src/rewrite-links.ts",
    "./slack-message": "./src/slack-message.ts",
    "./video-embed": "./src/video-embed.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/rendering/src/slack-message.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/rendering/src/slack-message.ts packages/rendering/src/slack-message.test.ts packages/rendering/package.json
git commit -m "feat(rendering): add Slack incoming-webhook message formatter"
```

---

### Task 4: Delivery plumbing — DeliveryMessage.format, fan-out, deliver branch

**Files:**

- Modify: `workers/api/src/webhooks/types.ts`
- Modify: `workers/api/src/webhooks/expand.ts:22-28`
- Modify: `workers/api/src/webhooks/expand-follows.ts:26-32`
- Modify: `workers/webhooks/src/deliver.ts`
- Modify: `workers/webhooks/src/deliver.test.ts`

**Interfaces:**

- Consumes: `WebhookFormat` (Task 1), `formatSlackMessage` (Task 3), `WebhookSubscription.format` (Task 1).
- Produces: `DeliveryMessage.format?: WebhookFormat`; `deliver()` branches on it.

- [ ] **Step 1: Add `format` to `DeliveryMessage`** in `workers/api/src/webhooks/types.ts`:

```ts
import type { ReleaseEvent } from "../events/types.js";
import type { WebhookFormat } from "@buildinternet/releases-core/schema";

export interface DeliveryMessage {
  subscriptionId: string;
  /** Subscriber URL captured at fan-out time so URL rotation doesn't strand in-flight messages. */
  url: string;
  /** Subscription's secret_version at fan-out time; consumer uses this in HMAC derivation. */
  secretVersion: number;
  /** Delivery format captured at fan-out time. Absent on pre-upgrade queued messages → treated as "json". */
  format?: WebhookFormat;
  event: ReleaseEvent;
  /** 1-indexed; queue retry handler is responsible for incrementing this. Used for AE attempt_number. */
  attempt: number;
}
```

- [ ] **Step 2: Pass `format` through both fan-out constructors.** In `workers/api/src/webhooks/expand.ts` (the `out.push({...})` at ~line 22):

```ts
out.push({
  subscriptionId: sub.id,
  url: sub.url,
  secretVersion: sub.secretVersion,
  format: sub.format,
  event,
  attempt: 1,
});
```

In `workers/api/src/webhooks/expand-follows.ts` (the `out.push({...})` at ~line 26), make the identical change (add `format: sub.format,` after `secretVersion`).

- [ ] **Step 3: Write the failing deliver test.** Append to `workers/webhooks/src/deliver.test.ts` inside the `describe("deliver", …)` block:

```ts
it("sends a Slack body and no signature headers when format is slack", async () => {
  let captured: Request | null = null;
  const fetch = async (req: Request) => {
    captured = req;
    return new Response("ok", { status: 200 });
  };
  const slackMsg: DeliveryMessage = {
    ...msg(),
    format: "slack",
    url: "https://hooks.slack.com/services/T/B/X",
    event: {
      id: "evt_1",
      seq: 1,
      ts: 1,
      type: "release.created",
      release: {
        id: "rel_1",
        title: "Thing",
        version: "1.0",
        publishedAt: null,
        sourceName: "Src",
        sourceSlug: "src",
        summary: "did stuff",
        titleGenerated: null,
        titleShort: null,
        media: [],
      } as any,
    },
  };
  const r = await deliver(slackMsg, {
    masterKey: "deadbeef".repeat(8),
    timeoutMs: 1000,
    fetchImpl: fetch as any,
    now: () => 1,
  });
  expect(r.outcome).toBe("success");
  const req = captured!;
  expect(req.headers.get("X-Releases-Signature")).toBeNull();
  expect(req.headers.get("X-Releases-Timestamp")).toBeNull();
  expect(req.headers.get("Content-Type")).toBe("application/json");
  const parsed = (await req.json()) as any;
  expect(parsed.blocks[0].type).toBe("section");
  expect(parsed.blocks[0].text.text).toContain("|Thing 1.0>");
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test workers/webhooks/src/deliver.test.ts`
Expected: FAIL — the current `deliver()` always sends signed headers, so `X-Releases-Signature` is not null.

- [ ] **Step 5: Branch `deliver()` on format.** Replace the top of `workers/webhooks/src/deliver.ts` (the imports and the body-building section, lines 1–52) with:

```ts
import { deriveSigningKey, signPayload } from "@releases/core-internal/webhook-sign";
import { formatSlackMessage } from "@releases/rendering/slack-message";
import type { DeliveryMessage } from "../../api/src/webhooks/types.js";
import type { ErrorCode, Outcome } from "./ae.js";

export interface DeliveryResult {
  outcome: Extract<Outcome, "success" | "retry" | "perm_fail">;
  httpStatus: number; // 0 if no response (network/timeout)
  latencyMs: number;
  errorMessage: string | null;
  errorCode: ErrorCode | null;
}

export interface DeliverOptions {
  masterKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Returns current time as unix seconds. Used for HMAC timestamp + header. */
  now?: () => number;
}

const WEBHOOK_VERSION = "1";
// AE blob budget — keep error bodies short.
const BODY_EXCERPT_BYTES = 200;

export async function deliver(
  message: DeliveryMessage,
  opts: DeliverOptions,
): Promise<DeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  let request: Request;
  if (message.format === "slack") {
    // Slack incoming webhooks take a Block Kit body and ignore/forbid our
    // signature headers — the URL is the secret, so we send unsigned.
    const body = JSON.stringify(formatSlackMessage(message.event.release));
    request = new Request(message.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `releases-webhooks/${WEBHOOK_VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } else {
    const ts = now();
    const body = JSON.stringify(message.event);
    const signingKey = await deriveSigningKey(
      opts.masterKey,
      message.subscriptionId,
      message.secretVersion,
    );
    const signature = await signPayload(signingKey, ts, body);
    request = new Request(message.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Releases-Version": WEBHOOK_VERSION,
        "X-Releases-Event-Id": message.event.id,
        "X-Releases-Timestamp": String(ts),
        "X-Releases-Signature": signature,
        "User-Agent": `releases-webhooks/${WEBHOOK_VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  }

  const start = Date.now();
```

Leave everything from `const start = Date.now();` onward (the `try { const res = await fetchImpl(request); … }` block) exactly as-is.

- [ ] **Step 6: Run the deliver tests**

Run: `bun test workers/webhooks/src/deliver.test.ts`
Expected: PASS — the new slack test passes and all existing json tests (`sends the expected headers`, etc.) still pass.

- [ ] **Step 7: Type-check both workers**

Run: `(cd workers/api && npx tsc --noEmit) && (cd workers/webhooks && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/webhooks/types.ts workers/api/src/webhooks/expand.ts workers/api/src/webhooks/expand-follows.ts workers/webhooks/src/deliver.ts workers/webhooks/src/deliver.test.ts
git commit -m "feat(webhooks): deliver slack-formatted body for format=slack subscriptions"
```

---

### Task 5: Route handling — accept `format`, validate Slack host, omit key

**Files:**

- Modify: `workers/api/src/webhooks/url-safety.ts`
- Create: `workers/api/src/webhooks/url-safety.test.ts` additions (append) — file exists, add cases
- Modify: `workers/api/src/webhooks/queries.ts` (`insertWebhookSubscription`, `WebhookSubscriptionUpdates`)
- Modify: `workers/api/src/webhooks/shared.ts` (`buildWebhookPatchUpdates`)
- Modify: `workers/api/src/routes/me-webhooks.ts` (POST create, PATCH, test handler)

**Interfaces:**

- Consumes: `WebhookFormat` (Task 1).
- Produces: `validateSlackWebhookUrl(url): string | null`; `insertWebhookSubscription` accepts `format`; create/patch read + persist `format`; create response omits `signingKey` for slack.

- [ ] **Step 1: Write the failing host-validation test.** Append to `workers/api/src/webhooks/url-safety.test.ts`:

```ts
import { validateSlackWebhookUrl } from "./url-safety.js";

describe("validateSlackWebhookUrl", () => {
  test("accepts a hooks.slack.com URL", () => {
    expect(validateSlackWebhookUrl("https://hooks.slack.com/services/T/B/X")).toBeNull();
  });
  test("accepts a GovSlack hooks host", () => {
    expect(validateSlackWebhookUrl("https://hooks.slack-gov.com/services/T/B/X")).toBeNull();
  });
  test("rejects a non-Slack host", () => {
    expect(validateSlackWebhookUrl("https://example.com/hook")).toMatch(/hooks\.slack\.com/);
  });
  test("rejects a lookalike host", () => {
    expect(validateSlackWebhookUrl("https://hooks.slack.com.evil.com/x")).not.toBeNull();
  });
});
```

(If `describe`/`test`/`expect` aren't already imported at the top of the file, add `import { describe, expect, test } from "bun:test";` — check first.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test workers/api/src/webhooks/url-safety.test.ts`
Expected: FAIL — `validateSlackWebhookUrl` is not exported.

- [ ] **Step 3: Implement `validateSlackWebhookUrl`.** Append to `workers/api/src/webhooks/url-safety.ts`:

```ts
/** Slack incoming-webhook hosts: standard + Enterprise Grid share hooks.slack.com; GovSlack uses hooks.slack-gov.com. */
const SLACK_WEBHOOK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

/** Host allowlist for `format = slack` subscriptions. Returns an error message or null. */
export function validateSlackWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is invalid";
  }
  if (!SLACK_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return "Slack webhooks must point at a hooks.slack.com incoming webhook URL";
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test workers/api/src/webhooks/url-safety.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `format` through `insertWebhookSubscription` + `WebhookSubscriptionUpdates`** in `workers/api/src/webhooks/queries.ts`. Add to the `WebhookSubscriptionUpdates` type (after `releaseType`):

```ts
  releaseType: "feature" | "rollup" | null;
  format: "json" | "slack";
}>;
```

Add `format` to the `insertWebhookSubscription` input type and the inserted values:

```ts
export async function insertWebhookSubscription(
  db: D1Db,
  input: {
    scope?: "org" | "follows";
    orgId: string | null;
    url: string;
    sourceId: string | null;
    productId?: string | null;
    releaseType?: "feature" | "rollup" | null;
    format?: "json" | "slack";
    description: string | null;
    userId?: string | null;
  },
): Promise<WebhookSubscription> {
  const scope = input.scope ?? "org";
  const [row] = await db
    .insert(webhookSubscriptions)
    .values({
      scope,
      orgId: input.orgId,
      url: input.url,
      sourceId: scope === "follows" ? null : input.sourceId,
      productId: scope === "follows" ? null : (input.productId ?? null),
      releaseType: input.releaseType ?? null,
      format: input.format ?? "json",
      description: input.description,
      userId: input.userId ?? null,
    })
    .returning();
  return row;
}
```

- [ ] **Step 6: Add `format` validation to `buildWebhookPatchUpdates`** in `workers/api/src/webhooks/shared.ts`. Widen the param type and handle `format` (reject non-slack hosts when switching a patched URL to slack):

```ts
import { validateWebhookUrl, validateSlackWebhookUrl } from "./url-safety.js";

export { validateWebhookUrl };

// … inside buildWebhookPatchUpdates, widen the body type:
export function buildWebhookPatchUpdates(
  body: Partial<{
    url: string;
    description: string | null;
    enabled: boolean;
    disabledReason: string | null;
    format: "json" | "slack";
  }>,
): WebhookSubscriptionUpdates | { error: string } {
  const updates: WebhookSubscriptionUpdates = {};
  if (body.url !== undefined) {
    const urlError = validateWebhookUrl(body.url);
    if (urlError) return { error: urlError };
    updates.url = body.url;
  }
  if (body.format !== undefined) {
    if (body.format !== "json" && body.format !== "slack") {
      return { error: "format must be 'json' or 'slack'" };
    }
    // When switching to slack with a URL in the same patch, enforce the Slack host.
    if (body.format === "slack" && body.url !== undefined) {
      const slackError = validateSlackWebhookUrl(body.url);
      if (slackError) return { error: slackError };
    }
    updates.format = body.format;
  }
  if (body.description !== undefined) updates.description = body.description;
  // … rest unchanged (enabled handling) …
```

- [ ] **Step 7: Wire create + patch + (no-op) test handler in `workers/api/src/routes/me-webhooks.ts`.**

In the **POST create** handler, after the existing `assertPublicWebhookTarget` check, parse + validate format, and pass it to **every** `insertWebhookSubscription({...})` call (both the org and follows branches):

```ts
// after: const urlError = await assertPublicWebhookTarget(url); if (urlError) …
const format = body.format === "slack" ? "slack" : "json";
if (format === "slack") {
  const slackError = validateSlackWebhookUrl(url);
  if (slackError) return c.json({ error: "bad_request", message: slackError }, 400);
}
```

Add `format,` to each `insertWebhookSubscription({ … })` payload in this handler (org branch shown ~line 212, plus the follows branch):

```ts
const sub = await insertWebhookSubscription(db, {
  scope: "org",
  orgId: org.id,
  url,
  sourceId: resolvedSourceId,
  productId: resolvedProductId,
  releaseType: releaseTypeFilter,
  format,
  description,
  userId: session.user.id,
});
```

Change the create response to omit the signing key for slack (replace ~lines 223–227):

```ts
const signingKey =
  format === "slack" ? undefined : await signingKeyFor(masterKey, sub.id, sub.secretVersion);
return c.json(
  {
    ...jsonSubscription(sub),
    orgSlug: org.slug,
    orgName: org.name,
    ...(signingKey ? { signingKey } : {}),
  },
  201,
);
```

Update the import at the top to pull in the Slack validator:

```ts
import { assertPublicWebhookTarget, validateSlackWebhookUrl } from "../webhooks/url-safety.js";
```

The **PATCH** handler already routes the body through `buildWebhookPatchUpdates` (now format-aware), so it needs no extra code beyond passing `body` through unchanged — confirm `body.format` reaches `buildWebhookPatchUpdates`. The **test** handler needs `format` so the synthetic event renders as Slack: in the `synthetic: DeliveryMessage` object (~line 437) add `format: sub.format,` after `secretVersion: sub.secretVersion,`.

- [ ] **Step 8: Write a route regression test for slack-host rejection.** Find the existing route test for me-webhooks (e.g. `workers/api/src/routes/me-webhooks.test.ts`; if none, create it following a sibling route test's setup). Add:

```ts
it("rejects format=slack with a non-Slack host", async () => {
  const res = await postMeWebhook({
    url: "https://example.com/x",
    scope: "follows",
    format: "slack",
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.message).toMatch(/hooks\.slack\.com/);
});

it("creates a slack webhook without returning a signing key", async () => {
  const res = await postMeWebhook({
    url: "https://hooks.slack.com/services/T/B/X",
    scope: "follows",
    format: "slack",
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.format).toBe("slack");
  expect(body.signingKey).toBeUndefined();
});
```

(Use whatever in-process request helper the sibling test uses — see memory: smoke worker routes in-process via `routes.request(path, init, env)`. If the existing me-webhooks tests stub the DB, reuse that harness; do not invent a new one.)

- [ ] **Step 9: Run the api worker tests + type-check**

Run: `(cd workers/api && npx tsc --noEmit) && bun test workers/api/src/webhooks/ workers/api/src/routes/me-webhooks.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add workers/api/src/webhooks/url-safety.ts workers/api/src/webhooks/url-safety.test.ts workers/api/src/webhooks/queries.ts workers/api/src/webhooks/shared.ts workers/api/src/routes/me-webhooks.ts workers/api/src/routes/me-webhooks.test.ts
git commit -m "feat(webhooks): accept format on create/patch, validate Slack host, omit key for slack"
```

---

### Task 6: Web account UI — format selector + Slack chrome gating

**Files:**

- Modify: `web/src/lib/webhooks.ts` (createWebhook input + re-export)
- Modify: `web/src/components/webhooks-panel.tsx` (form state, selector, submit, key reveal, per-row chrome)

**Interfaces:**

- Consumes: `UserWebhookFormat` (Task 2), `createWebhook` (extended).

- [ ] **Step 1: Add `format` to the client `createWebhook` input** in `web/src/lib/webhooks.ts`. Extend the imports + input type:

```ts
import type {
  CreateUserWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookListResponse,
  UserWebhookReleaseTypeFilter,
  UserWebhookScope,
} from "@buildinternet/releases-api-types";

export type {
  CreateUserWebhookResponse,
  RotateUserWebhookSecretResponse,
  TestUserWebhookResponse,
  UserWebhookFormat,
  UserWebhookListItem,
  UserWebhookScope,
};

export async function createWebhook(input: {
  url: string;
  scope?: UserWebhookScope;
  orgSlug?: string;
  productSlug?: string;
  sourceSlug?: string;
  releaseType?: UserWebhookReleaseTypeFilter;
  format?: UserWebhookFormat;
  description?: string;
}): Promise<CreateUserWebhookResponse> {
  // … body unchanged (already JSON.stringify(input)) …
}
```

- [ ] **Step 2: Add format state + selector to the create form** in `web/src/components/webhooks-panel.tsx`. Add state near the other `useState` calls (~line 162):

```tsx
const [format, setFormat] = useState<UserWebhookFormat>("json");
```

Import the type at the top from `@/lib/webhooks` (alongside the existing `UserWebhookScope` import). Add a selector to the create form (place it near the URL field; match the existing select styling used by the `releaseType` dropdown):

```tsx
<label className="block text-[12px] font-medium text-stone-700 dark:text-stone-300">
  Format
  <select
    value={format}
    onChange={(e) => setFormat(e.target.value as UserWebhookFormat)}
    className={selectClass}
  >
    <option value="json">JSON (signed payload)</option>
    <option value="slack">Slack message</option>
  </select>
</label>;
{
  format === "slack" && (
    <p className="text-[12px] text-stone-500 dark:text-stone-400">
      Posts a formatted message to a Slack incoming webhook URL (hooks.slack.com). No signature is
      sent.
    </p>
  );
}
```

(Reuse whatever class constant the panel already uses for selects; if it inlines Tailwind on the `releaseType` select, copy that exact className instead of `selectClass`.)

- [ ] **Step 3: Pass `format` in the submit handler + guard the key reveal.** In `onCreate` (~line 207), add `format` to the `createWebhook({...})` args and only reveal a key when one is returned:

```tsx
const created = await createWebhook({
  url: url.trim(),
  scope,
  format,
  ...(scope === "org"
    ? {
        orgSlug: orgSlug.trim(),
        ...(productSlug.trim() ? { productSlug: productSlug.trim() } : {}),
        ...(sourceSlug.trim() ? { sourceSlug: sourceSlug.trim() } : {}),
      }
    : {}),
  ...(releaseType ? { releaseType } : {}),
  ...(description.trim() ? { description: description.trim() } : {}),
});
if (created.signingKey) {
  setRevealedKey(created.signingKey);
  setSuccess("Webhook created. Copy the signing key before dismissing.");
} else {
  setSuccess("Slack webhook created.");
}
setUrl("");
setOrgSlug("");
setProductSlug("");
setSourceSlug("");
setReleaseType("");
setFormat("json");
setDescription("");
await refresh();
```

- [ ] **Step 4: Hide signing-key affordances per-row for slack subs.** In the subscription list rendering, gate the "Rotate secret" / verify-key actions on `sub.format !== "slack"`, and add a small "Posts to Slack" chip for slack rows. Locate the per-row action buttons (the rotate-secret button) and wrap it:

```tsx
{
  sub.format !== "slack" && (
    <button type="button" onClick={() => onRotate(sub.id)} className={buttonClass}>
      Rotate secret
    </button>
  );
}
{
  sub.format === "slack" && (
    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
      Slack
    </span>
  );
}
```

- [ ] **Step 5: Type-check the web app**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. (Restore any dev-only `web/next-env.d.ts` change — do not commit it.)

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/webhooks.ts web/src/components/webhooks-panel.tsx
git commit -m "feat(web): webhook format selector + Slack chrome on the notifications panel"
```

---

### Task 7: CLI `--format` flag (releases-cli)

**Files (in `/Users/zachdunn/Code/releases-cli`):**

- Modify: `src/cli/commands/webhook-manage.ts` (`add` + `edit` commands)
- Modify: the CLI webhook API client where `createMyWebhook`/patch payloads are built (find via `rg -n "createMyWebhook|updateMyWebhook" src`)
- Create: a changeset `.changeset/<name>.md`

**Interfaces:**

- Consumes: the wire `format` field (additive JSON; no monorepo dependency).

- [ ] **Step 1: Add `--format` to `webhook add`.** In `src/cli/commands/webhook-manage.ts` add the option + thread it into the request, and skip the signing-key print when none is returned:

```ts
  .option("--format <format>", "Delivery format: json (default) or slack")
```

In the `add` action, validate + pass it:

```ts
const format = opts.format === "slack" ? "slack" : "json";
if (opts.format && opts.format !== "json" && opts.format !== "slack") {
  logger.error("--format must be 'json' or 'slack'.");
  process.exit(1);
}
const result = await createMyWebhook({
  url: opts.url,
  scope,
  format,
  ...(scope === "org"
    ? {
        orgSlug: opts.org,
        ...(opts.source ? { sourceSlug: opts.source } : {}),
        ...(opts.product ? { productSlug: opts.product } : {}),
      }
    : {}),
  ...(releaseType ? { releaseType } : {}),
  description: opts.description,
});
if (opts.json) return writeJson(result);
printSubscription(result);
if (result.signingKey) {
  logger.info("");
  logger.info(chalk.bold("Signing key (shown once — store it now):"));
  logger.info(`  ${chalk.green(result.signingKey)}`);
  logger.info(chalk.dim("  Re-derive only via `webhook rotate-secret` (invalidates the old key)."));
} else {
  logger.info("");
  logger.info(chalk.dim("  Slack webhook — no signing key (the URL is the secret)."));
}
```

Add `format?: string` to the `add` action's `opts` type, and `format?: "json" | "slack"` to the `createMyWebhook` input type in the CLI's webhook client (widen its local type; the request body is plain JSON so no api-types bump is required).

- [ ] **Step 2: Add `--format` to `webhook edit`.** Add the option and include it in the patch payload when provided:

```ts
  .option("--format <format>", "Change delivery format: json or slack")
```

In the edit action's patch-building block, add:

```ts
      ...(opts.format ? { format: opts.format } : {}),
```

and add `format?: string` to the edit `opts` type.

- [ ] **Step 3: Add a changeset.** Create `.changeset/slack-webhook-format.md`:

```md
---
"@buildinternet/releases": minor
---

Add `--format slack` to `releases webhook add`/`edit` to deliver releases as formatted Slack messages via a Slack incoming webhook URL.
```

- [ ] **Step 4: Type-check + test the CLI**

Run: `cd /Users/zachdunn/Code/releases-cli && npx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit (in the CLI repo)**

```bash
cd /Users/zachdunn/Code/releases-cli
git add src/cli/commands/webhook-manage.ts .changeset/slack-webhook-format.md
git commit -m "feat: add --format slack to webhook add/edit"
```

---

### Task 8: Docs

**Files:**

- Modify: `web/src/content/docs/api/webhooks.md`

**Interfaces:** none.

- [ ] **Step 1: Add a "Slack delivery" section.** After the scopes/management section, add:

```md
## Slack delivery

Set `format: "slack"` (or `--format slack` on the CLI) and point the subscription
at a [Slack incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
URL (`https://hooks.slack.com/services/...`). Each release is posted as a compact
Slack message — a linked title, a short summary, and a context line with the
organization's avatar and date.

Slack webhooks are **unsigned**: the URL itself is the secret, so no signing key is
issued and no `X-Releases-*` signature headers are sent. There is nothing to
verify on the Slack side. Use the **Test** button (or `releases webhook test <id>`)
to post a sample card.

The host must be `hooks.slack.com` (standard and Enterprise Grid) or
`hooks.slack-gov.com` (GovSlack); other hosts are rejected at creation.
```

- [ ] **Step 2: Sanity-check the docs build / lint if the repo has a docs check**

Run: `bun run format:check` (or the repo's markdown lint, if any)
Expected: PASS (or no docs-specific gate — at minimum the file is valid markdown).

- [ ] **Step 3: Commit**

```bash
git add web/src/content/docs/api/webhooks.md
git commit -m "docs(webhooks): document Slack delivery format"
```

---

## Final verification

- [ ] **Full type-check:** `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd workers/webhooks && npx tsc --noEmit) && (cd web && npx tsc --noEmit)` → all PASS.
- [ ] **Targeted tests:** `bun test packages/rendering/src/slack-message.test.ts workers/webhooks/src/deliver.test.ts workers/api/src/webhooks/` → PASS.
- [ ] **Lint/format:** `bun run lint && bun run format:check` → PASS.
- [ ] **Manual smoke (optional, recommended):** create a real Slack incoming webhook, then `releases webhook add --scope follows --url https://hooks.slack.com/services/... --format slack`, follow an org, and `releases webhook test <id>` — confirm a card lands in the channel.

## Self-Review Notes (coverage vs. spec)

- Data model → Task 1. api-types field → Task 2. Formatter → Task 3. Delivery branch + plumbing → Task 4. Validation (host allowlist, key omission) + routes → Task 5. CLI → Task 7. Web → Task 6. Docs → Task 8. Test event renders as Slack → Task 5 Step 7.
- Spec deferral resolved: release permalink is `https://releases.sh/release/{id}` (baseUrl-parameterized in the formatter).
- Out-of-scope items (Discord, custom templates, threading, Slack OAuth app, feature flag) are intentionally absent.
