# Firecrawl Monitoring Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use Firecrawl monitoring as an external fetch + change-detection backend for hard-to-reach sources (OpenAI release notes et al. that fail Cloudflare managed challenge), pushing meaningful changes to an authenticated inbound webhook that feeds our existing ingest pipeline.

**Architecture:** Admin-triggered, idempotent monitor lifecycle (desired-state derived from `source.metadata.firecrawl`) provisions Firecrawl monitors. Monitors POST `monitor.page` events to a new self-authenticating receiver on the API worker; the receiver applies a cost gate (`new` always extracts, `changed` gates on `judgment.meaningful`, fail-open) and spawns a `FirecrawlIngestWorkflow` that runs the changed markdown through extract → dedup → insert → publish → embed → summarize.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle/D1, Cloudflare Workflows, Firecrawl v2 API. Spec: `docs/superpowers/specs/2026-05-29-firecrawl-monitoring-integration-design.md`.

**Gating:** Phase 0 is a spike that proves Firecrawl clears the managed challenge on the real OpenAI URL. **Phases 1–2 only proceed if Phase 0 succeeds.** Phase 2 tasks are expanded to bite-sized steps after Phase 0 confirms the premise and the scrape-extract path (`extractFromBody`) signature is read at execution time (see note in Phase 2).

---

## File structure

| File                                            | Responsibility                                                                                           | Phase                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------- |
| `scripts/firecrawl-spike.ts`                    | Throwaway: scrape OpenAI URL via Firecrawl, print result. Deleted after Phase 0.                         | 0                       |
| `packages/adapters/src/firecrawl.ts`            | Pure Firecrawl v2 client (monitor CRUD + scrapeOnce) + types. Caller passes `{ apiKey, fetch? }`.        | 1                       |
| `packages/adapters/src/firecrawl.test.ts`       | Unit tests for the client (mock `fetch`).                                                                | 1                       |
| `packages/adapters/src/source-meta.ts`          | Add `firecrawl` block to `SourceMetadata`.                                                               | 1                       |
| `workers/api/src/lib/firecrawl-sync.ts`         | `deriveMonitorSpec` (pure) + `syncFirecrawlMonitor` (reconcile).                                         | 1                       |
| `workers/api/src/lib/firecrawl-sync.test.ts`    | Unit tests for spec derivation + reconcile.                                                              | 1                       |
| `workers/api/wrangler.jsonc`                    | Add `FIRECRAWL_API_KEY` + `FIRECRAWL_WEBHOOK_SECRET` Secrets Store bindings (prod + staging).            | 1                       |
| `workers/api/src/routes/firecrawl.ts`           | `POST /v1/sources/:slug/firecrawl/sync` (admin) + `POST /v1/integrations/firecrawl/webhook` (self-auth). | 1 (sync) / 2 (receiver) |
| `workers/api/src/routes/firecrawl.test.ts`      | Route tests (auth + gate matrix).                                                                        | 1 / 2                   |
| `workers/api/src/workflows/firecrawl-ingest.ts` | `FirecrawlIngestWorkflow` + extracted ingest helpers.                                                    | 2                       |
| `workers/api/src/cron/poll-fetch.ts`            | Add `!firecrawl?.enabled` to poll eligibility; export shared ingest helpers.                             | 2                       |
| `workers/api/src/index.ts`                      | Export `FirecrawlIngestWorkflow`; mount firecrawl routes.                                                | 1 / 2                   |

`Env.Bindings` (in `index.ts`) gains `FIRECRAWL_API_KEY?: SecretBinding`, `FIRECRAWL_WEBHOOK_SECRET?: SecretBinding`, `FIRECRAWL_INGEST_WORKFLOW?: Workflow`.

---

## Phase 0 — Premise spike (GATE)

### Task 0: Confirm Firecrawl clears the OpenAI managed challenge

**Files:**

- Create (throwaway): `scripts/firecrawl-spike.ts`

- [ ] **Step 1: Write the spike script**

```ts
// scripts/firecrawl-spike.ts — throwaway, delete after Phase 0
const KEY = process.env.FIRECRAWL_API_KEY;
if (!KEY) throw new Error("FIRECRAWL_API_KEY not set");

// The canonical blocked source. Confirm the exact URL from the paused source row first.
const URL = "https://help.openai.com/en/articles/6825453-chatgpt-release-notes";

const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: URL, formats: ["markdown"], proxy: "auto" }),
});
const json = (await res.json()) as { success?: boolean; data?: { markdown?: string } };
const md = json?.data?.markdown ?? "";
console.log("status:", res.status, "success:", json?.success);
console.log("markdown length:", md.length);
console.log("first 800 chars:\n", md.slice(0, 800));
// Heuristic: a challenge page is short and mentions "Just a moment" / "Verify you are human".
const looksBlocked = md.length < 500 || /just a moment|verify you are human|cf-browser/i.test(md);
console.log(
  looksBlocked ? "LIKELY BLOCKED — premise fails" : "LIKELY REAL CONTENT — premise holds",
);
```

- [ ] **Step 2: Run the spike**

Run: `bun run scripts/firecrawl-spike.ts`
Expected: prints markdown length in the thousands and real release-note prose → "LIKELY REAL CONTENT". If `proxy: "auto"` looks blocked, retry once with `proxy: "stealth"`/`"enhanced"` (whichever the API accepts — check the error body for the allowed enum).

- [ ] **Step 3: Decision checkpoint**

- **Real content** → premise holds. Note the working `proxy` value + observed credit cost; proceed to Phase 1. Delete the spike script: `git rm scripts/firecrawl-spike.ts` is not needed (untracked) — just `rm scripts/firecrawl-spike.ts`.
- **Blocked on every proxy** → STOP. Report to the user; the integration does not help OpenAI and the scope must be reconsidered. Do not proceed.

- [ ] **Step 4: Commit the decision (no code)**

If proceeding, record the spike outcome in the spec's "Open risks" section (mark risk #1 resolved with the working proxy + observed credits), then commit:

```bash
git add docs/superpowers/specs/2026-05-29-firecrawl-monitoring-integration-design.md
git commit -m "docs: Phase 0 spike — Firecrawl clears OpenAI managed challenge (proxy=<value>)"
```

---

## Phase 1 — Monitor management

### Task 1: Firecrawl v2 client

**Files:**

- Create: `packages/adapters/src/firecrawl.ts`
- Test: `packages/adapters/src/firecrawl.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/adapters/src/firecrawl.test.ts
import { describe, expect, it } from "bun:test";
import { createFirecrawlClient, type FirecrawlMonitorSpec } from "./firecrawl.js";

const spec: FirecrawlMonitorSpec = {
  name: "test-monitor",
  schedule: "every 6 hours",
  targets: [{ type: "scrape", url: "https://example.com/changelog" }],
  proxy: "auto",
  goal: "Detect new releases",
  judgeEnabled: true,
  webhook: {
    url: "https://api.example.com/hook",
    headers: { "X-Firecrawl-Token": "secret" },
    metadata: { sourceId: "src_123" },
    events: ["page"],
  },
};

it("createMonitor POSTs the spec and returns the monitor id", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true, monitor: { id: "mon_abc" } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const client = createFirecrawlClient({ apiKey: "k", fetch: fakeFetch });
  const id = await client.createMonitor(spec);

  expect(id).toBe("mon_abc");
  expect(calls[0].url).toBe("https://api.firecrawl.dev/v2/monitor");
  expect(calls[0].init.method).toBe("POST");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer k");
});

it("deleteMonitor DELETEs the monitor id", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createFirecrawlClient({ apiKey: "k", fetch: fakeFetch });
  await client.deleteMonitor("mon_abc");
  expect(calls[0]).toBe("https://api.firecrawl.dev/v2/monitor/mon_abc");
});

it("throws on non-2xx", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  const client = createFirecrawlClient({ apiKey: "k", fetch: fakeFetch });
  await expect(client.createMonitor(spec)).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/adapters/src/firecrawl.test.ts`
Expected: FAIL — `Cannot find module './firecrawl.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/adapters/src/firecrawl.ts
const BASE = "https://api.firecrawl.dev/v2";

export type FirecrawlProxy = "basic" | "enhanced" | "auto";

export interface FirecrawlMonitorSpec {
  name: string;
  schedule: string; // cron or natural-language; 15-min minimum
  targets: Array<{ type: "scrape" | "crawl"; url: string }>;
  proxy: FirecrawlProxy;
  goal?: string;
  judgeEnabled: boolean;
  webhook: {
    url: string;
    headers: Record<string, string>;
    metadata: Record<string, string>;
    events: Array<"page" | "check.completed">;
  };
}

export interface FirecrawlMonitor {
  id: string;
  // Other fields (schedule, normalizedCron, nextRunAt, …) intentionally left
  // loose until pinned against the live API in Phase 1 integration.
  [k: string]: unknown;
}

export interface FirecrawlClientOpts {
  apiKey: string;
  fetch?: typeof fetch;
}

async function call(
  f: typeof fetch,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await f(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firecrawl ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

export function createFirecrawlClient(opts: FirecrawlClientOpts) {
  const f = opts.fetch ?? fetch;
  const key = opts.apiKey;
  return {
    async createMonitor(spec: FirecrawlMonitorSpec): Promise<string> {
      const json = (await call(f, key, "POST", "/monitor", spec)) as { monitor?: { id?: string } };
      const id = json?.monitor?.id;
      if (!id) throw new Error("Firecrawl createMonitor returned no monitor id");
      return id;
    },
    async getMonitor(id: string): Promise<FirecrawlMonitor> {
      const json = (await call(f, key, "GET", `/monitor/${id}`)) as { monitor?: FirecrawlMonitor };
      if (!json?.monitor) throw new Error(`Firecrawl getMonitor ${id} returned no monitor`);
      return json.monitor;
    },
    async updateMonitor(id: string, spec: FirecrawlMonitorSpec): Promise<void> {
      await call(f, key, "PUT", `/monitor/${id}`, spec);
    },
    async deleteMonitor(id: string): Promise<void> {
      await call(f, key, "DELETE", `/monitor/${id}`);
    },
    async runMonitor(id: string): Promise<void> {
      await call(f, key, "POST", `/monitor/${id}/run`);
    },
    async scrapeOnce(url: string, p?: { proxy?: FirecrawlProxy }): Promise<string> {
      const json = (await call(f, key, "POST", "/scrape", {
        url,
        formats: ["markdown"],
        proxy: p?.proxy ?? "auto",
      })) as { data?: { markdown?: string } };
      return json?.data?.markdown ?? "";
    },
  };
}

export type FirecrawlClient = ReturnType<typeof createFirecrawlClient>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/adapters/src/firecrawl.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/firecrawl.ts packages/adapters/src/firecrawl.test.ts
git commit -m "feat(adapters): Firecrawl v2 monitor client"
```

### Task 2: `SourceMetadata.firecrawl` + `deriveMonitorSpec`

**Files:**

- Modify: `packages/adapters/src/source-meta.ts` (add to `SourceMetadata` interface, after the `appStore` block ~line 223)
- Create: `workers/api/src/lib/firecrawl-sync.ts`
- Test: `workers/api/src/lib/firecrawl-sync.test.ts`

- [ ] **Step 1: Add the metadata block**

In `packages/adapters/src/source-meta.ts`, inside `interface SourceMetadata`, after the `appStore?: {...}` block:

```ts
  /**
   * Firecrawl monitoring opt-in. Present on sources whose fetch is delegated
   * to Firecrawl's external scrape + change-detection (anti-bot escape hatch
   * for sources our own pipeline can't reach). Desired-state source of truth;
   * the monitor spec is derived from this + source.url. See
   * docs/superpowers/specs/2026-05-29-firecrawl-monitoring-integration-design.md
   */
  firecrawl?: {
    enabled: boolean; // opt-in master switch
    monitorId?: string; // stamped after create; cleared on delete
    schedule?: string; // cron or natural-language; default "every 6 hours"
    proxy?: "basic" | "enhanced" | "auto"; // default "auto"
    goal?: string; // natural-language judge goal
    judgeEnabled?: boolean; // default true; false = always extract (gate off)
    lastCheckId?: string; // observability
    lastChangeAt?: string; // observability (ISO)
  };
```

- [ ] **Step 2: Write the failing test for `deriveMonitorSpec`**

```ts
// workers/api/src/lib/firecrawl-sync.test.ts
import { describe, expect, it } from "bun:test";
import { deriveMonitorSpec } from "./firecrawl-sync.js";

const baseSource = {
  id: "src_123",
  slug: "chatgpt-release-notes",
  url: "https://help.openai.com/en/articles/6825453",
  metadata: JSON.stringify({ firecrawl: { enabled: true } }),
} as unknown as import("@buildinternet/releases-core/schema").Source;

it("derives a spec from source + metadata with defaults applied", () => {
  const spec = deriveMonitorSpec(baseSource, {
    webhookUrl: "https://api.releases.sh/v1/integrations/firecrawl/webhook",
    webhookSecret: "shh",
  });
  expect(spec.targets).toEqual([{ type: "scrape", url: baseSource.url }]);
  expect(spec.schedule).toBe("every 6 hours");
  expect(spec.proxy).toBe("auto");
  expect(spec.judgeEnabled).toBe(true);
  expect(spec.webhook.metadata.sourceId).toBe("src_123");
  expect(spec.webhook.headers["X-Firecrawl-Token"]).toBe("shh");
  expect(spec.webhook.events).toEqual(["page"]);
});

it("honors explicit schedule/proxy/goal overrides", () => {
  const src = {
    ...baseSource,
    metadata: JSON.stringify({
      firecrawl: {
        enabled: true,
        schedule: "daily",
        proxy: "enhanced",
        goal: "x",
        judgeEnabled: false,
      },
    }),
  } as typeof baseSource;
  const spec = deriveMonitorSpec(src, { webhookUrl: "u", webhookSecret: "s" });
  expect(spec.schedule).toBe("daily");
  expect(spec.proxy).toBe("enhanced");
  expect(spec.goal).toBe("x");
  expect(spec.judgeEnabled).toBe(false);
});

it("is deterministic — same input yields identical spec", () => {
  const a = deriveMonitorSpec(baseSource, { webhookUrl: "u", webhookSecret: "s" });
  const b = deriveMonitorSpec(baseSource, { webhookUrl: "u", webhookSecret: "s" });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test workers/api/src/lib/firecrawl-sync.test.ts`
Expected: FAIL — `Cannot find module './firecrawl-sync.js'`.

- [ ] **Step 4: Implement `deriveMonitorSpec`**

```ts
// workers/api/src/lib/firecrawl-sync.ts
import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import type { FirecrawlMonitorSpec } from "@releases/adapters/firecrawl.js";

const DEFAULT_SCHEDULE = "every 6 hours";
const DEFAULT_GOAL =
  "Detect new product releases, version announcements, or changelog entries on this page.";

export function deriveMonitorSpec(
  source: Source,
  opts: { webhookUrl: string; webhookSecret: string },
): FirecrawlMonitorSpec {
  const fc = getSourceMeta(source).firecrawl ?? { enabled: false };
  return {
    name: `releases:${source.slug}`,
    schedule: fc.schedule ?? DEFAULT_SCHEDULE,
    targets: [{ type: "scrape", url: source.url }],
    proxy: fc.proxy ?? "auto",
    goal: fc.goal ?? DEFAULT_GOAL,
    judgeEnabled: fc.judgeEnabled ?? true,
    webhook: {
      url: opts.webhookUrl,
      headers: { "X-Firecrawl-Token": opts.webhookSecret },
      metadata: { sourceId: source.id },
      events: ["page"],
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test workers/api/src/lib/firecrawl-sync.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify the schema-pairing CI gate**

`source-meta.ts` is not `schema.ts`, so no migration is required (the `firecrawl` block is JSON inside the existing `metadata` text column). Confirm: `git diff --name-only` shows no `schema.ts` change. If it somehow does, add a marker migration per `reference_schema_pairing_gate_marker_migration`.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/source-meta.ts workers/api/src/lib/firecrawl-sync.ts workers/api/src/lib/firecrawl-sync.test.ts
git commit -m "feat(api): source.metadata.firecrawl block + deriveMonitorSpec (pure)"
```

### Task 3: `syncFirecrawlMonitor` reconcile helper

**Files:**

- Modify: `workers/api/src/lib/firecrawl-sync.ts`
- Test: `workers/api/src/lib/firecrawl-sync.test.ts`

- [ ] **Step 1: Write the failing test (create / update / delete branches)**

```ts
// append to workers/api/src/lib/firecrawl-sync.test.ts
import { syncFirecrawlMonitor } from "./firecrawl-sync.js";
import type { FirecrawlClient } from "@releases/adapters/firecrawl.js";

function fakeClient(over: Partial<FirecrawlClient> = {}): FirecrawlClient {
  return {
    createMonitor: async () => "mon_new",
    getMonitor: async () => ({ id: "mon_existing" }),
    updateMonitor: async () => {},
    deleteMonitor: async () => {},
    runMonitor: async () => {},
    scrapeOnce: async () => "",
    ...over,
  } as FirecrawlClient;
}

const opts = { webhookUrl: "u", webhookSecret: "s" };

it("creates a monitor when enabled and no monitorId", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: true } }),
  } as any;
  let created = false;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      createMonitor: async () => {
        created = true;
        return "mon_new";
      },
    }),
    opts,
  );
  expect(created).toBe(true);
  expect(patch.firecrawl?.monitorId).toBe("mon_new");
  expect(patch.firecrawl?.enabled).toBe(true);
});

it("deletes and clears monitorId when disabled", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: false, monitorId: "mon_existing" } }),
  } as any;
  let deleted: string | null = null;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      deleteMonitor: async (id: string) => {
        deleted = id;
      },
    }),
    opts,
  );
  expect(deleted).toBe("mon_existing");
  expect(patch.firecrawl?.monitorId).toBeUndefined();
});

it("updates the monitor when enabled with an existing id", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: true, monitorId: "mon_existing" } }),
  } as any;
  let updated: string | null = null;
  const patch = await syncFirecrawlMonitor(
    src,
    fakeClient({
      updateMonitor: async (id: string) => {
        updated = id;
      },
    }),
    opts,
  );
  expect(updated).toBe("mon_existing");
  expect(patch.firecrawl?.monitorId).toBe("mon_existing");
});

it("no-ops when disabled and no monitorId", async () => {
  const src = {
    id: "src_1",
    slug: "s",
    url: "https://x.com",
    metadata: JSON.stringify({ firecrawl: { enabled: false } }),
  } as any;
  const patch = await syncFirecrawlMonitor(src, fakeClient(), opts);
  expect(patch.firecrawl?.monitorId).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/lib/firecrawl-sync.test.ts`
Expected: FAIL — `syncFirecrawlMonitor` is not exported.

- [ ] **Step 3: Implement `syncFirecrawlMonitor`**

```ts
// append to workers/api/src/lib/firecrawl-sync.ts
import type { FirecrawlClient } from "@releases/adapters/firecrawl.js";
import type { SourceMetadata } from "@releases/adapters/source-meta.js";

/**
 * Reconcile a single source's Firecrawl monitor to match its desired state.
 * Idempotent + keyed on deriveMonitorSpec — a future reconcile sweep is just a
 * loop over this. Returns a metadata patch the caller persists (merge into the
 * existing metadata; only the `firecrawl` key is authoritative here).
 */
export async function syncFirecrawlMonitor(
  source: Source,
  client: FirecrawlClient,
  opts: { webhookUrl: string; webhookSecret: string },
): Promise<Pick<SourceMetadata, "firecrawl">> {
  const meta = getSourceMeta(source);
  const fc = meta.firecrawl ?? { enabled: false };

  if (!fc.enabled) {
    if (fc.monitorId) await client.deleteMonitor(fc.monitorId);
    const { monitorId: _drop, ...rest } = fc;
    return { firecrawl: { ...rest, enabled: false } };
  }

  const spec = deriveMonitorSpec(source, opts);
  if (fc.monitorId) {
    await client.updateMonitor(fc.monitorId, spec);
    return { firecrawl: { ...fc, enabled: true, monitorId: fc.monitorId } };
  }
  const monitorId = await client.createMonitor(spec);
  return { firecrawl: { ...fc, enabled: true, monitorId } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/src/lib/firecrawl-sync.test.ts`
Expected: PASS (all branches).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/firecrawl-sync.ts workers/api/src/lib/firecrawl-sync.test.ts
git commit -m "feat(api): syncFirecrawlMonitor reconcile helper (create/update/delete)"
```

### Task 4: Secrets Store bindings + Env types

**Files:**

- Modify: `workers/api/wrangler.jsonc` (`secrets_store_secrets` array — prod block ~lines 303-375, AND the `env.staging` block)
- Modify: `workers/api/src/index.ts` (`Env.Bindings` type)

- [ ] **Step 1: Add the two Secrets Store bindings (prod block)**

In the `"secrets_store_secrets"` array, after the `WEBHOOK_HMAC_MASTER` entry, add:

```jsonc
    {
      "binding": "FIRECRAWL_API_KEY",
      "store_id": "a887a71cab084105b79706df23380723",
      "secret_name": "FIRECRAWL_API_KEY",
    },
    {
      "binding": "FIRECRAWL_WEBHOOK_SECRET",
      "store_id": "a887a71cab084105b79706df23380723",
      "secret_name": "FIRECRAWL_WEBHOOK_SECRET",
    },
```

Add the **same two entries** to the `secrets_store_secrets` array inside the `"env": { "staging": { ... } }` block.

- [ ] **Step 2: Add the binding types to `Env.Bindings`**

In `workers/api/src/index.ts`, in the `Env` `Bindings` type (where `ANTHROPIC_API_KEY?: SecretBinding;` lives), add:

```ts
  FIRECRAWL_API_KEY?: SecretBinding;
  FIRECRAWL_WEBHOOK_SECRET?: SecretBinding;
  FIRECRAWL_INGEST_WORKFLOW?: Workflow; // bound in Phase 2
```

- [ ] **Step 3: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS (the `Workflow` type is already imported for `POLL_AND_FETCH_WORKFLOW`; if not, mirror that binding's type).

- [ ] **Step 4: Commit**

```bash
git add workers/api/wrangler.jsonc workers/api/src/index.ts
git commit -m "chore(api): bind FIRECRAWL_API_KEY + FIRECRAWL_WEBHOOK_SECRET (prod + staging)"
```

> **Operator action (not a code step):** the user adds the two secret _values_ to CF Secrets Store (`FIRECRAWL_API_KEY` already exists; generate `FIRECRAWL_WEBHOOK_SECRET` via `openssl rand -hex 32`). Per global rules, the agent does not edit `.env` or push secret material.

### Task 5: `POST /v1/sources/:slug/firecrawl/sync` admin route

**Files:**

- Create: `workers/api/src/routes/firecrawl.ts`
- Modify: `workers/api/src/index.ts` (mount the routes inside `mountV1Routes`; add `firecrawl/sync` admin gating)
- Modify: `workers/api/src/route-namespaces.ts` (see auth note)
- Test: `workers/api/src/routes/firecrawl.test.ts`

**Auth note:** `sources` is already in `publicReadRoutes`, so `publicReadAuthMiddleware` already requires Bearer auth on this non-GET path — sufficient for admin-only. No `route-namespaces.ts` change is needed for the sync route. (The receiver in Phase 2 needs the `integrations` namespace to stay OUT of both lists.)

- [ ] **Step 1: Write the failing route test**

```ts
// workers/api/src/routes/firecrawl.test.ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { firecrawlRoutes } from "./firecrawl.js";
import { createTestDb } from "../../../../tests/db-helper.js";

function mockSecret(v: string) {
  return { get: () => Promise.resolve(v) };
}

it("sync enables a monitor and persists monitorId", async () => {
  const testDb = createTestDb();
  // seed an org + source (use the db-helper's seed utilities or raw inserts)
  // … insert org "o1", source { id:"src_1", slug:"acme-changelog", url:"https://acme.com/changelog", orgId:"o1" }
  const app = new Hono();
  app.route("/v1", firecrawlRoutes);
  const env = {
    DB: testDb.db,
    FIRECRAWL_API_KEY: mockSecret("fc-key"),
    FIRECRAWL_WEBHOOK_SECRET: mockSecret("hook-secret"),
    WEB_BASE_URL: "https://api.releases.sh",
    // inject a fake firecrawl client factory — see Step 3 for the seam
    _firecrawlClientOverride: {
      createMonitor: async () => "mon_seeded",
      deleteMonitor: async () => {},
      updateMonitor: async () => {},
      getMonitor: async () => ({ id: "mon_seeded" }),
      runMonitor: async () => {},
      scrapeOnce: async () => "",
    },
  } as never;

  const res = await app.request(
    "/v1/sources/acme-changelog/firecrawl/sync",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    },
    env,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { firecrawl?: { monitorId?: string } };
  expect(json.firecrawl?.monitorId).toBe("mon_seeded");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/src/routes/firecrawl.test.ts`
Expected: FAIL — `Cannot find module './firecrawl.js'`.

- [ ] **Step 3: Implement the route**

```ts
// workers/api/src/routes/firecrawl.ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import { createFirecrawlClient, type FirecrawlClient } from "@releases/adapters/firecrawl.js";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js"; // mirror an existing route's db factory import
import { deriveMonitorSpec, syncFirecrawlMonitor } from "../lib/firecrawl-sync.js";

export const firecrawlRoutes = new Hono<{ Bindings: Record<string, unknown> }>();

function webhookUrl(env: Record<string, unknown>): string {
  const base = (env.WEB_BASE_URL as string) ?? "https://api.releases.sh";
  return `${base.replace(/\/$/, "")}/v1/integrations/firecrawl/webhook`;
}

async function firecrawlClient(env: Record<string, unknown>): Promise<FirecrawlClient> {
  if (env._firecrawlClientOverride) return env._firecrawlClientOverride as FirecrawlClient;
  const apiKey = await getSecret(env.FIRECRAWL_API_KEY as { get(): Promise<string> } | undefined);
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not bound");
  return createFirecrawlClient({ apiKey });
}

firecrawlRoutes.post("/sources/:slug/firecrawl/sync", async (c) => {
  const env = c.env as Record<string, unknown>;
  const db = createDb(env.DB);
  const slug = c.req.param("slug");
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean;
    schedule?: string;
    proxy?: "basic" | "enhanced" | "auto";
    goal?: string;
  };

  const [source] = await db.select().from(sources).where(eq(sources.slug, slug)).limit(1);
  if (!source) return c.json({ error: "not_found" }, 404);

  const meta = getSourceMeta(source);
  const merged = {
    ...meta,
    firecrawl: {
      ...(meta.firecrawl ?? { enabled: false }),
      enabled: body.enabled ?? meta.firecrawl?.enabled ?? false,
      ...(body.schedule ? { schedule: body.schedule } : {}),
      ...(body.proxy ? { proxy: body.proxy } : {}),
      ...(body.goal ? { goal: body.goal } : {}),
    },
  };
  const sourceForSync = { ...source, metadata: JSON.stringify(merged) };

  const secret = await getSecret(
    env.FIRECRAWL_WEBHOOK_SECRET as { get(): Promise<string> } | undefined,
  );
  if (!secret) return c.json({ error: "webhook_secret_unbound" }, 500);

  const client = await firecrawlClient(env);
  const patch = await syncFirecrawlMonitor(sourceForSync, client, {
    webhookUrl: webhookUrl(env),
    webhookSecret: secret,
  });

  const finalMeta = { ...merged, ...patch };
  await db
    .update(sources)
    .set({ metadata: JSON.stringify(finalMeta) })
    .where(eq(sources.id, source.id));

  logEvent("info", {
    component: "firecrawl-sync",
    event: "synced",
    sourceId: source.id,
    slug,
    enabled: finalMeta.firecrawl.enabled,
    monitorId: finalMeta.firecrawl.monitorId ?? null,
  });
  return c.json(finalMeta);
});
```

> **Execution note:** confirm the real db-factory import (`createDb` / `getDb`) and `WEB_BASE_URL` binding name by reading a sibling route (e.g. `workers/api/src/routes/sources.ts`). Adjust the two imports/names to match — do not invent.

- [ ] **Step 4: Mount the routes**

In `workers/api/src/index.ts`, inside `mountV1Routes(v1)` (where other `v1.route(...)` calls live), add:

```ts
import { firecrawlRoutes } from "./routes/firecrawl.js";
// …
v1.route("/", firecrawlRoutes);
```

- [ ] **Step 5: Run test + type-check**

Run: `bun test workers/api/src/routes/firecrawl.test.ts && cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/firecrawl.ts workers/api/src/routes/firecrawl.test.ts workers/api/src/index.ts
git commit -m "feat(api): POST /v1/sources/:slug/firecrawl/sync admin endpoint"
```

### Task 6: Onboard OpenAI by hand (manual verification, no code)

- [ ] **Step 1:** Deploy the branch to a smoke environment via GHA dispatch (`gh workflow run deploy-workers.yml --ref worktree-firecrawl-monitoring -f worker=api -f environment=production`) OR test against staging.
- [ ] **Step 2:** `POST /v1/sources/chatgpt-release-notes/firecrawl/sync { "enabled": true }` with an admin token. Confirm `monitorId` comes back.
- [ ] **Step 3:** Confirm in the Firecrawl dashboard that a monitor exists with the right URL + schedule + webhook config.
- [ ] **Step 4:** `runMonitor` (force a check). With Phase 2 not yet built, the webhook will hit a 404 (receiver not mounted) — that's expected; this step only verifies the monitor fires. Defer real receipt to Phase 2.

---

## Phase 2 — Ingest

**Recon done (2026-05-29) — corrections to the original outline baked into the tasks below:**

1. **`fetchOne` does NOT call `extractFromBody`.** `extractFromBody` lives in `packages/adapters/src/extract/extract-from-body.ts` (the discovery/CLI path); the API cron only handles feed/github/appstore. The Firecrawl workflow calls `extractFromBody` itself, mirroring the **crawl branch** of `workers/discovery/src/scrape-fetch.ts:670-720`: `extractFromBody({ body, systemPrompt, userMessage, sourceUrl, fetchUrl, useToolLoop }, deps)` → `mapEntries(result.entries, { sourceUrl })`. `extractFromBody` uses only `deps.anthropicClient` / `deps.agentModel` / `deps.logger` (not `deps.repo`), so the worker builds **minimal deps**, no HTTP `ExtractRepo`.
2. **`fetch_log` has NO `path` column** (`packages/core/src/schema.ts:477-505`; `FETCH_LOG_STATUSES = ["success","error","no_change","dry_run","blocked"]`). `sessionId` is the correlation id; "from Firecrawl" observability lives in `logEvent` `component`, not a column.
3. **The `monitor.page` webhook payload is nested and carries a diff, not guaranteed full markdown.** Shape: `{ success, type: "monitor.page", id, webhookId, metadata: { sourceId }, data: [ { monitorId, checkId, url, status: "new"|"changed"|"same"|"removed"|"error", isMeaningful, judgment: { meaningful, confidence, reason, meaningfulChanges }, diff: { text, json }, previousScrapeId, currentScrapeId } ] }`. Because the payload may only carry a diff, **the workflow re-scrapes via `client.scrapeOnce(url)`** (Phase-0-validated to return full markdown) rather than trusting the webhook to deliver full content. Workflow params stay small: `{ sourceId, url, checkId, status }` — no markdown blob through Workflow param serialization.
4. **`deriveMonitorSpec` currently emits `events: ["page"]`** but the docs show the wire value is `"monitor.page"` (Task 15 reconciles this; the receiver stays tolerant of both).
5. **`ingestRawReleases` lifts the contiguous tail** of `fetchOne` (`poll-fetch.ts:1308-1462`) rather than re-implementing a lean insert — every extra in that block (marketing classifier, enrich map, R2 media, coverage cascade, IndexNow) is already conditionally gated by source metadata and **no-ops for a Firecrawl source**, so reuse = zero drift + zero duplication. `embedReleasesForSource` / `generateContentForReleases` / `fetch_log` / changelog refresh stay in `fetchOne` and become separate workflow steps.

**Confirmed handles:** `RELEASES_BATCH_CHUNK_SIZE = 5` (`workers/api/src/lib/d1-limits.ts`). `FIRECRAWL_INGEST_WORKFLOW?: Workflow` already on `Env.Bindings` (`index.ts:231`, Phase 1). `constantTimeEqual` exported from `@buildinternet/releases-core/api-token`. KV namespace `LATEST_CACHE`. `firecrawlRoutes` mounted at `workers/api/src/v1-routes.ts:105` via `v1.route("/", firecrawlRoutes)`. `integrations` is in neither `publicReadRoutes` nor `adminRoutes` (`route-namespaces.ts`). Workflow test harness `mkFakeStep` in `tests/api/_workflow-test-helpers.ts`; `_drizzleOverride` escape hatch on the workflow env.

### Task 7: `ingestRawReleases` — lift the contiguous insert/publish tail of `fetchOne`

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (extract a new exported function; refactor `fetchOne` to call it)
- Test: `workers/api/src/cron/poll-fetch.test.ts` (or `tests/api/ingest-raw-releases.test.ts` if no sibling exists — confirm at execution time)

- [ ] **Step 1: Read the exact block to lift.** Re-read `poll-fetch.ts:1308-1462` (marketing map → enrich map → media pre-pass → `rows` build → chunked `db.insert(releases).onConflictDoNothing().returning(...)` → `clusterAndPersistCascades` → `visiblePublishRows` → `publishReleaseEvents` → `notifyIndexNowForSource`). Note every local it reads (`meta`, `source`, `env`, `rawReleases`) and every module-local helper it calls (all stay in-module, so the lift keeps the same imports).

- [ ] **Step 2: Write the failing test.** Seed a `createTestDb()` with an org + scrape source. Call `ingestRawReleases(db, source, [rawA, rawB], env, { })` with a minimal `env` (`{ DB, RELEASE_HUB: undefined }` so publish is skipped). Assert it returns `{ found: 2, inserted: 2, insertedIds: [<2 ids>], visiblePublishRows: [...] }` and that a second call with the same `url`s returns `inserted: 0` (dedup via `onConflictDoNothing`). Run: `bun test <file>` — expect FAIL (`ingestRawReleases` not exported).

- [ ] **Step 3: Implement the lift.** Add to `poll-fetch.ts`:

```ts
export interface IngestResult {
  insertedIds: string[];
  found: number;
  inserted: number;
  visiblePublishRows: InsertedReleaseRow[];
}

/**
 * The insert+publish tail shared by the cron `fetchOne` and the Firecrawl
 * ingest workflow. Takes RawRelease[] already in hand and runs:
 * marketing classify → enrich → media pre-pass → build rows → chunked
 * onConflictDoNothing insert → coverage cascade → publish → IndexNow.
 * Every "extra" (marketing/enrich/R2/coverage) is metadata-gated and no-ops
 * for sources that don't opt in, so this is safe to reuse verbatim. Embed,
 * fetch_log, and CHANGELOG refresh are the CALLER's responsibility.
 */
export async function ingestRawReleases(
  db: ReturnType<typeof drizzle>,
  source: Source,
  rawReleases: RawRelease[],
  env: FetchOneEnv,
): Promise<IngestResult> {
  const meta = getSourceMeta(source);
  // ... exact body lifted from lines 1308-1462 ...
  return { insertedIds, found: rawReleases.length, inserted, visiblePublishRows };
}
```

Then replace `fetchOne`'s lines 1308-1462 with `const { insertedIds, found, inserted, visiblePublishRows } = await ingestRawReleases(db, source, rawReleases, env);`. Keep `fetchOne`'s embed (1464-1479), `db.batch` fetch_log (1481-1506), and changelog refresh (1508+) exactly as-is — they read `inserted`/`insertedIds` which are now destructured from the return.

- [ ] **Step 4: Run the full worker suite (regression guard).** Run: `bun test workers/api && cd workers/api && npx tsc --noEmit`. The existing `tests/api/poll-and-fetch-workflow.test.ts` exercises `fetchOne`'s tail — it must stay green. Expect PASS.

- [ ] **Step 5: Commit.**

```bash
git add workers/api/src/cron/poll-fetch.ts workers/api/src/cron/poll-fetch.test.ts
git commit -m "refactor(api): extract ingestRawReleases from fetchOne tail (no behavior change)"
```

### Task 8: `extractFirecrawlMarkdown` — markdown → `RawRelease[]`

**Files:**

- Create: `workers/api/src/lib/firecrawl-extract.ts`
- Test: `workers/api/src/lib/firecrawl-extract.test.ts`

- [ ] **Step 1: Read the model.** Read `workers/discovery/src/scrape-fetch.ts:670-720` (crawl branch), `packages/adapters/src/extract/run-agent.ts` (the standard single-page extraction system prompt + `userMessage` it builds — use that, NOT `CRAWL_SYSTEM_PROMPT`, since a Firecrawl source is a single changelog page, not `# <url>`-delimited multi-page crawl output), and `mapEntries`/`MappedEntry` in `packages/adapters/src/extract/shared.ts:304`. Confirm the standard extraction prompt export name.

- [ ] **Step 2: Write the failing test.** Stub an Anthropic-shaped client whose `messages.stream(...).finalMessage()` resolves to a message with one `tool_use` block (`name: "extract_releases"`, `input: { releases: [{ title: "v1.2.0", content: "...", version: "v1.2.0" }] }`). Inject it via a `deps` override seam. Assert `extractFirecrawlMarkdown(markdown, source, { anthropicClient, agentModel: "claude-sonnet-4-6", logger })` returns a `RawRelease[]` of length 1 with `title === "v1.2.0"` and a resolved `url`. Run: expect FAIL.

- [ ] **Step 3: Implement.**

```ts
// workers/api/src/lib/firecrawl-extract.ts
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";
import { extractFromBody, mapEntries, <STANDARD_EXTRACTION_SYSTEM_PROMPT> } from "@releases/adapters/extract";
import type { ExtractDeps } from "@releases/adapters/extract";

export async function extractFirecrawlMarkdown(
  markdown: string,
  source: Source,
  deps: Pick<ExtractDeps, "anthropicClient" | "agentModel" | "logger"> & { useToolLoop?: boolean },
): Promise<{ releases: RawRelease[]; totalInput: number; totalOutput: number; mode: string }> {
  const result = await extractFromBody(
    {
      body: markdown,
      systemPrompt: <STANDARD_EXTRACTION_SYSTEM_PROMPT>,
      userMessage: `Extract every release, version announcement, or changelog entry from this page (source URL: ${source.url}).`,
      sourceUrl: source.url,
      fetchUrl: source.url,
      useToolLoop: deps.useToolLoop ?? false,
    },
    // extractFromBody only reads anthropicClient/agentModel/logger; supply a
    // minimal deps object (cloudflare:null, no repo) cast to ExtractDeps.
    { anthropicClient: deps.anthropicClient, agentModel: deps.agentModel, logger: deps.logger } as ExtractDeps,
  );
  const releases = mapEntries(result.entries, { sourceUrl: source.url }) as RawRelease[];
  return { releases, totalInput: result.totalInput, totalOutput: result.totalOutput, mode: result.mode };
}
```

> **Execution note:** if `extractFromBody` turns out to dereference `deps.repo` / `deps.cloudflare` on some path, add the minimal no-op (`repo: { peekContentHash: async () => false, commitContentHash: async () => {}, updateSourceMeta: async () => {}, getOrgPlaybook: async () => null, logUsage: async () => {} }`, `cloudflare: null`). Confirm by reading `extract-with-tools.ts` (the tool-loop tier) — the one-shot tier (`runOneShot`) does not.

- [ ] **Step 4: Run test + type-check.** `bun test workers/api/src/lib/firecrawl-extract.test.ts && cd workers/api && npx tsc --noEmit`. Expect PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(api): extractFirecrawlMarkdown — markdown → RawRelease[] via extractFromBody"`

### Task 9: `FirecrawlIngestWorkflow`

**Files:**

- Create: `workers/api/src/workflows/firecrawl-ingest.ts`
- Modify: `workers/api/src/index.ts` (export the class)
- Modify: `workers/api/wrangler.jsonc` (`workflows` array — prod + staging)
- Test: `tests/api/firecrawl-ingest-workflow.test.ts`

- [ ] **Step 1: Read the model.** Read `workers/api/src/workflows/poll-and-fetch.ts` for the class shape, `RETRY_FETCH`/`RETRY_EMBED`/`RETRY_GENERATE` constants, `NonRetryableError` import (`cloudflare:workflows`), the `buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(env)) })` pattern (line 273), `embedReleasesForSource`, and `generateContentForReleases`. Read `tests/api/_workflow-test-helpers.ts` (`mkFakeStep`) and `tests/api/poll-and-fetch-workflow.test.ts` for the harness.

- [ ] **Step 2: Write the failing workflow test.** Mirror `poll-and-fetch-workflow.test.ts`: in-memory SQLite via `tests/db-helper.ts`, `applyMigrations`, seed org + a source with `metadata.firecrawl.enabled = true`. Build env with `_drizzleOverride: db`, a fake firecrawl client (`scrapeOnce: async () => "# v1.0\nNotes"`), `FIRECRAWL_API_KEY: { get: async () => "k" }`, `ANTHROPIC_API_KEY: { get: async () => "a" }`, and a stubbed extract. Run `wf.run(event, mkFakeStep(...).step)` with params `{ sourceId, url, checkId: "chk_1", status: "new" }`. Assert a release row was inserted and a `fetch_log` row with `status: "success"` exists. Add a second case: `status: "changed"` with `scrapeOnce` returning identical content ⇒ `inserted: 0` ⇒ `fetch_log` `status: "no_change"`. Run: expect FAIL.

- [ ] **Step 3: Implement the workflow.**

```ts
// workers/api/src/workflows/firecrawl-ingest.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
// ... drizzle, schema, getSecret, buildAnthropicClient, resolveGatewayOpts,
//     createFirecrawlClient, extractFirecrawlMarkdown, ingestRawReleases,
//     embedReleasesForSource, generateContentForReleases, logEvent, getSourceMeta ...

export interface FirecrawlIngestParams {
  sourceId: string;
  url: string;
  checkId: string;
  status: string;
}

export class FirecrawlIngestWorkflow extends WorkflowEntrypoint<FirecrawlIngestEnv, FirecrawlIngestParams> {
  async run(event: WorkflowEvent<FirecrawlIngestParams>, step: WorkflowStep): Promise<void> {
    const { sourceId, url, checkId, status } = event.payload;
    const db = drizzle((this.env._drizzleOverride as D1Database) ?? this.env.DB);
    const start = Date.now();

    // 1. load-source — bail (NonRetryableError) if missing or firecrawl disabled.
    const source = await step.do("load-source", RETRY_POLL, async () => {
      const [s] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
      if (!s) throw new NonRetryableError(`firecrawl: source ${sourceId} not found`);
      if (!getSourceMeta(s).firecrawl?.enabled) throw new NonRetryableError(`firecrawl: ${sourceId} not enabled`);
      return s;
    });

    // 2. scrape — fresh full markdown (webhook only carried a diff).
    const markdown = await step.do("scrape", RETRY_FETCH, async () => {
      const apiKey = await getSecret(this.env.FIRECRAWL_API_KEY);
      if (!apiKey) throw new NonRetryableError("firecrawl: FIRECRAWL_API_KEY unbound");
      const client = this.env._firecrawlClientOverride ?? createFirecrawlClient({ apiKey });
      const md = await client.scrapeOnce(url, { proxy: getSourceMeta(source).firecrawl?.proxy });
      if (!md) throw new Error(`firecrawl: empty scrape for ${url}`);
      return md;
    });

    // 3. extract — markdown → RawRelease[].
    const rawReleases = await step.do("extract", RETRY_FETCH, async () => {
      const apiKey = await getSecret(this.env.ANTHROPIC_API_KEY);
      if (!apiKey) throw new NonRetryableError("firecrawl: ANTHROPIC_API_KEY unbound");
      const client = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(this.env)) });
      const { releases } = await extractFirecrawlMarkdown(markdown, source, {
        anthropicClient: client, agentModel: <DEFAULT_AGENT_MODEL>, logger: <workerLogger>,
      });
      return releases;
    });

    // 4. dedup-insert
    const ingest = await step.do("dedup-insert", RETRY_FETCH, async () =>
      ingestRawReleases(db, source, rawReleases, this.env as FetchOneEnv),
    );

    // 5. embed-summarize (only when something was inserted)
    if (ingest.insertedIds.length > 0) {
      await step.do("embed", RETRY_EMBED, async () => { await embedReleasesForSource(db, source, ingest.insertedIds, this.env); });
      await step.do("summarize", RETRY_GENERATE, async () => { await generateContentForReleases(db, source, ingest.insertedIds, this.env); });
    }

    // 6. bookkeep — fetch_log + source counters + firecrawl.lastCheckId/lastChangeAt, one db.batch.
    await step.do("bookkeep", RETRY_POLL, async () => {
      const meta = getSourceMeta(source);
      const nextMeta = { ...meta, firecrawl: { ...meta.firecrawl!, lastCheckId: checkId, lastChangeAt: new Date().toISOString() } };
      await db.batch([
        db.insert(fetchLog).values({
          sourceId, sessionId: `firecrawl:${checkId}`,
          releasesFound: ingest.found, releasesInserted: ingest.inserted,
          durationMs: Date.now() - start,
          status: ingest.inserted > 0 ? "success" : "no_change",
        }),
        db.update(sources).set({
          lastFetchedAt: new Date().toISOString(),
          consecutiveNoChange: 0, consecutiveErrors: 0, nextFetchAfter: null, changeDetectedAt: null,
          metadata: JSON.stringify(nextMeta),
        }).where(eq(sources.id, sourceId)),
      ] as [any, ...any[]]);
    });

    logEvent("info", { component: "firecrawl-ingest-workflow", event: "ingested", sourceId, checkId, status, found: ingest.found, inserted: ingest.inserted });
  }
}
```

> Confirm exact signatures of `generateContentForReleases`, `embedReleasesForSource`, `resolveGatewayOpts`, and the `DEFAULT_AGENT_MODEL` / `workerLogger` to use, by reading `poll-and-fetch.ts`. The `_firecrawlClientOverride` / `_drizzleOverride` seams on the env mirror the existing test seams.

- [ ] **Step 4: Export + register.** In `index.ts` add `export { FirecrawlIngestWorkflow } from "./workflows/firecrawl-ingest.js";`. In `wrangler.jsonc` `workflows` array add `{ "name": "firecrawl-ingest", "binding": "FIRECRAWL_INGEST_WORKFLOW", "class_name": "FirecrawlIngestWorkflow" }` to the **prod** block and `{ "name": "firecrawl-ingest-staging", "binding": "FIRECRAWL_INGEST_WORKFLOW", "class_name": "FirecrawlIngestWorkflow" }` to **staging** (mirror the `poll-and-fetch` entries' naming).

- [ ] **Step 5: Run test + type-check.** `bun test tests/api/firecrawl-ingest-workflow.test.ts && cd workers/api && npx tsc --noEmit`. Expect PASS.

- [ ] **Step 6: Commit.** `git commit -m "feat(api): FirecrawlIngestWorkflow — scrape → extract → ingest → embed/summarize"`

### Task 10: Inbound receiver `POST /v1/integrations/firecrawl/webhook`

**Files:**

- Modify: `workers/api/src/routes/firecrawl.ts` (add the receiver route to the existing `firecrawlRoutes`)
- Test: `workers/api/src/routes/firecrawl.test.ts` (add gate-matrix + auth cases)

**Auth:** `integrations` is in neither `publicReadRoutes` nor `adminRoutes`, so no middleware runs — the handler self-authenticates. The path is `/v1/integrations/firecrawl/webhook` (the route string on `firecrawlRoutes` is `/integrations/firecrawl/webhook`, since it mounts at `/`).

- [ ] **Step 1: Write the failing tests.** Mount `firecrawlRoutes` on a bare Hono app (mirror the Phase 1 test). Inject `FIRECRAWL_WEBHOOK_SECRET: { get: async () => "hook" }`, `LATEST_CACHE` fake (`{ get: async () => null, put: async () => {} }`), and `FIRECRAWL_INGEST_WORKFLOW: { create: async (o) => spawns.push(o) }`. Seed an enabled source. Cases:
  - missing/incorrect `X-Firecrawl-Token` → 401, no spawn.
  - valid token + `data:[{status:"new",...}]` → 200, one spawn with params `{ sourceId, url, checkId, status:"new" }`.
  - `status:"changed"` + `judgment.meaningful:true` → spawn; `meaningful:false` → no spawn (200); `judgment` absent → spawn (fail-open).
  - `status:"same"` / `"removed"` / `"error"` → no spawn (200).
  - unknown `metadata.sourceId` → 200, no spawn.
  - duplicate `checkId+url` (KV `get` returns truthy) → 200, no spawn.
  - Run: expect FAIL.

- [ ] **Step 2: Implement the receiver.** Add to `firecrawl.ts`:

```ts
import { constantTimeEqual } from "@buildinternet/releases-core/api-token";

interface FirecrawlPageEvent {
  type?: string;
  metadata?: { sourceId?: string };
  data?: Array<{
    checkId?: string;
    url?: string;
    status?: string;
    judgment?: { meaningful?: boolean; confidence?: string };
  }>;
}

firecrawlRoutes.post("/integrations/firecrawl/webhook", async (c) => {
  const env = c.env as Env["Bindings"] & { _firecrawlClientOverride?: FirecrawlClient };
  const secret = await getSecret(env.FIRECRAWL_WEBHOOK_SECRET);
  const token = c.req.header("X-Firecrawl-Token") ?? "";
  if (!secret || !constantTimeEqual(token, secret)) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as FirecrawlPageEvent;
  const sourceId = body.metadata?.sourceId;
  if (!sourceId) return c.json({ ok: true, skipped: "no_source_id" });

  const db = createDb(env.DB);
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  const fc = source ? getSourceMeta(source).firecrawl : undefined;
  if (!source || !fc?.enabled) {
    logEvent("info", { component: "firecrawl-webhook", event: "skip-unknown-source", sourceId });
    return c.json({ ok: true, skipped: "unknown_or_disabled" });
  }

  for (const page of body.data ?? []) {
    const { checkId, url, status, judgment } = page;
    if (!checkId || !url || !status) continue;

    // idempotency
    const key = `firecrawl:webhook:${checkId}:${url}`;
    if (env.LATEST_CACHE && (await env.LATEST_CACHE.get(key))) continue;

    // gate
    const judgeOn = fc.judgeEnabled !== false;
    const meaningful = judgment?.meaningful;
    const enqueue =
      status === "new" ||
      (status === "changed" && (!judgeOn || meaningful === true || meaningful === undefined));
    if (!enqueue) {
      logEvent("info", {
        component: "firecrawl-webhook",
        event: "gate-skip",
        sourceId,
        status,
        meaningful: meaningful ?? null,
      });
      continue;
    }

    await env.LATEST_CACHE?.put(key, "1", { expirationTtl: 3600 });
    if (env.FIRECRAWL_INGEST_WORKFLOW) {
      await env.FIRECRAWL_INGEST_WORKFLOW.create({
        id: `fc-${checkId}`,
        params: { sourceId, url, checkId, status },
      });
    }
    logEvent("info", {
      component: "firecrawl-webhook",
      event: "enqueued",
      sourceId,
      checkId,
      status,
    });
  }
  return c.json({ ok: true });
});
```

> Confirm `env.FIRECRAWL_INGEST_WORKFLOW.create(...)`'s exact option shape against how `POLL_AND_FETCH_WORKFLOW.create` is called elsewhere (`{ id, params }`). Confirm `createDb`/`getSourceMeta`/`sources`/`eq` are already imported in `firecrawl.ts` (they are, from Phase 1).

- [ ] **Step 3: Run test + type-check.** `bun test workers/api/src/routes/firecrawl.test.ts && cd workers/api && npx tsc --noEmit`. Expect PASS.

- [ ] **Step 4: OpenAPI coverage.** The receiver is under `integrations` (not a `publicReadRoutes` prefix), so it is **out of scope** for the coverage gate — no `describeRoute`, no ALLOWLIST entry needed. Confirm `bun run scripts/check-openapi-coverage.ts` (or the CI step) still passes.

- [ ] **Step 5: Commit.** `git commit -m "feat(api): POST /v1/integrations/firecrawl/webhook receiver + gate"`

### Task 11: Poll-fetch exclusion

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (the `fetchable` filter, ~lines 161-194)
- Modify: `workers/api/src/workflows/poll-and-fetch.ts` (the `run` body, after the `changed` check)
- Test: `workers/api/src/cron/poll-fetch.test.ts`

- [ ] **Step 1: Write the failing test.** Build a `pollResults`-shaped input with two changed sources, one with `metadata.firecrawl.enabled = true`. Assert the firecrawl one is absent from `fetchable`. Run: expect FAIL.

- [ ] **Step 2: Implement.** At the top of the `fetchable` filter callback in `pollAndFetch`, add:

```ts
const m = getSourceMeta(s);
if (m.firecrawl?.enabled) return false; // Firecrawl webhook drives ingest — never cron-fetch
```

And in `PollAndFetchWorkflow.run` (after the `pollResult.changed` gate, before the `fetch-and-persist` step), add the same guard returning early (mirror how a not-changed source short-circuits — log `firecrawl-owned-skip` and return). Confirm the exact early-return shape by reading the surrounding lines.

- [ ] **Step 3: Run the full worker suite.** `bun test workers/api && cd workers/api && npx tsc --noEmit`. Expect PASS.

- [ ] **Step 4: Commit.** `git commit -m "feat(api): exclude Firecrawl-owned sources from poll-fetch cron"`

### Task 12: Reconcile monitor `events` wire value

**Files:**

- Modify: `packages/adapters/src/firecrawl.ts` (the `events` type), `workers/api/src/lib/firecrawl-sync.ts` (`deriveMonitorSpec`)
- Test: `workers/api/src/lib/firecrawl-sync.test.ts`

- [ ] **Step 1.** Widen `FirecrawlMonitorSpec.webhook.events` to `Array<"monitor.page" | "monitor.check.completed">` and change `deriveMonitorSpec` to emit `events: ["monitor.page"]`. Update the Phase 1 assertion in `firecrawl-sync.test.ts` (`expect(spec.webhook.events).toEqual(["monitor.page"])`). The receiver (Task 10) does not branch on `type`, so it stays compatible either way.

- [ ] **Step 2: Run + commit.** `bun test workers/api/src/lib/firecrawl-sync.test.ts && cd workers/api && npx tsc --noEmit` → `git commit -m "fix(firecrawl): emit monitor.page webhook event (wire value)"`

### Task 13: End-to-end verification (manual / operator — no code)

- [ ] **Step 1:** Deploy the branch to prod via GHA dispatch (`gh workflow run deploy-workers.yml --ref firecrawl-monitoring-phase-2 -f worker=api -f environment=production`).
- [ ] **Step 2:** `POST /v1/sources/<openai-src-id>/firecrawl/sync { "enabled": true }` with an admin token; confirm `monitorId` is stamped.
- [ ] **Step 3:** `runMonitor` (force a check) OR wait for the schedule. Confirm in Axiom: a `firecrawl-webhook` `enqueued` event, then a `firecrawl-ingest-workflow` `ingested` event, then a `fetch_log` row (`sessionId` `firecrawl:<checkId>`). Confirm a release row appears for the OpenAI source.
- [ ] **Step 4:** Confirm the source is no longer picked up by the hourly poll-fetch cron (no duplicate `fetch_log` rows from the cron path).

---

## Deferred (Phase 3 — not in this plan)

- Reconcile sweep job (loop over firecrawl-enabled sources calling `syncFirecrawlMonitor`).
- Onboard the remaining ~13 conservative blocked sources (x.ai, perplexity, amplitude, firebase, fly.io, granola, posthog).
- **Web admin-panel control** (toggle per source, view/edit schedule + proxy/goal) — a thin client over `POST /v1/sources/:slug/firecrawl/sync`.
- Per-source webhook secrets if revocation granularity is needed.
- CLI verb `releases admin source firecrawl <enable|sync|disable>` (OSS CLI repo).

---

## Self-review

- **Spec coverage:** client (T1), metadata + derive (T2), sync helper (T3), secrets (T4), admin route (T5), receiver + gate (T10), workflow (T9), extract refactor (T7/T8), poll-fetch exclusion (T11), observability via `logEvent` + `fetch_log path="firecrawl"` (T5/T9/T10), Phase 0 spike (T0). All spec sections map to a task.
- **Placeholder scan:** Phase 0–1 steps contain complete code. Phase 2 is explicitly an outline (gated on Phase 0) with concrete signatures + the one read-first dependency (`extractFromBody`) called out — not hidden as a placeholder.
- **Type consistency:** `FirecrawlMonitorSpec` (T1) is consumed unchanged by `deriveMonitorSpec` (T2) and `syncFirecrawlMonitor` (T3); `FirecrawlClient` type threads T1→T3→T5; `ingestRawReleases` signature (T7) is consumed by the workflow (T9); `RawRelease` from `@releases/adapters/types.js` is the shared currency (T7/T8/T9).
- **Execution-time confirmations flagged (not invented):** db-factory import name in routes, `WEB_BASE_URL` binding name, `extractFromBody` signature. Each is called out at its task.
