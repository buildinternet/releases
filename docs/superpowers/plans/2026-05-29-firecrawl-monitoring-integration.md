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

## Phase 2 — Ingest (outline; expand to bite-sized steps after Phase 0 confirms premise)

**Why outlined, not bite-sized yet:** Phase 2 is gated on Phase 0 (no point detailing ingest if Firecrawl can't reach OpenAI). It also requires reading the exact scrape-body→records extraction signature — `extractFromBody` (referenced in `AGENTS.md` under "Extract tier"; the code-explorer found `fetchOne`'s _feed_ branch uses `fetchAndParseFeed`, but the _scrape_ branch uses the AI extract path). **First action of Phase 2:** read `workers/api/src/cron/extract.ts` (and `extract-with-tools.ts`) to pin `extractFromBody`'s real signature, then expand the tasks below.

### Task 7: Extract shared ingest helper from `fetchOne`

Lift the tail of `fetchOne` (`poll-fetch.ts`) into a reusable function:

```ts
// signature to implement (in poll-fetch.ts or a new cron/ingest-core.ts)
export async function ingestRawReleases(
  db: ReturnType<typeof drizzle>,
  source: Source,
  rawReleases: RawRelease[],
  env: FetchOneEnv,
  opts: { sessionId: string; path: string /* "firecrawl" */ },
): Promise<{ insertedIds: string[]; found: number; inserted: number }>;
```

It runs: `selectNewReleaseIndices` → build rows → chunked `db.insert(releases).onConflictDoNothing().returning(...)` (use the existing `RELEASES_BATCH_CHUNK_SIZE`) → `publishReleaseEvents` → return ids. The cron `fetchOne` is refactored to call it (proves no drift). `embedReleasesForSource` + `generateContentForReleases` stay as separate workflow steps. TDD: add a test that the helper inserts new rows and dedups existing ones against a `createTestDb()` instance.

### Task 8: `extractFromBody` wrapper for markdown → `RawRelease[]`

Wrap the confirmed `extractFromBody` so the workflow can turn Firecrawl markdown into `RawRelease[]` for a source with no feed. Reuse the existing extract-tier gate (one-shot vs toolloop). TDD with a small fixed markdown fixture + a stubbed Anthropic client returning a known tool payload.

### Task 9: `FirecrawlIngestWorkflow`

New `workers/api/src/workflows/firecrawl-ingest.ts`, `WorkflowEntrypoint<FirecrawlIngestEnv, FirecrawlIngestParams>` with params `{ sourceId, url, markdown, checkId, status, judgment? }`. Steps (each `step.do` with a retry config mirroring `RETRY_FETCH`/`RETRY_EMBED` in `poll-and-fetch.ts`):

1. `load-source` — `db.select().from(sources).where(eq(sources.id, sourceId))`; bail via `NonRetryableError` if missing or `!firecrawl.enabled`.
2. `extract` — `extractFromBody`-wrapper(markdown) → `RawRelease[]`.
3. `dedup-insert` — `ingestRawReleases(...)` with `path: "firecrawl"`.
4. `embed-summarize` — `embedReleasesForSource` + `generateContentForReleases` (only when `insertedIds.length > 0`).
5. `bookkeep` — `fetch_log` insert (`status`, `releasesFound`, `releasesInserted`) + source-counter update (`lastFetchedAt`, clear backoff) + stamp `metadata.firecrawl.lastCheckId`/`lastChangeAt`, via `db.batch([...])`.

Export from `index.ts` (`export { FirecrawlIngestWorkflow } from "./workflows/firecrawl-ingest.js";`). Add the wrangler `workflows` array entry: `{ "name": "firecrawl-ingest", "binding": "FIRECRAWL_INGEST_WORKFLOW", "class_name": "FirecrawlIngestWorkflow" }` (prod + staging). TDD: in-process workflow test mirroring `tests/api/poll-and-fetch-workflow.test.ts` (`mkFakeStep`, `_drizzleOverride`).

### Task 10: Inbound receiver `POST /v1/integrations/firecrawl/webhook`

Add to `workers/api/src/routes/firecrawl.ts`. The route is mounted via `mountV1Routes`; because `integrations` is in **neither** `publicReadRoutes` nor `adminRoutes`, no auth middleware runs — the handler self-authenticates:

1. Constant-time compare `c.req.header("X-Firecrawl-Token")` vs `getSecret(env.FIRECRAWL_WEBHOOK_SECRET)` (use `crypto.subtle.timingSafeEqual` over encoded bytes, or a length-checked constant-time compare). Fail → 401.
2. Parse `monitor.page` payload (confirm field names against Firecrawl events doc — `markdown`, `status`, `judgment`, `checkId`, `metadata.sourceId`).
3. Resolve `metadata.sourceId`. Unknown / `!firecrawl.enabled` → 200 + log (no 4xx).
4. KV idempotency guard on `checkId + url` (short TTL) — skip if seen.
5. **Gate:** `status === "new"` ⇒ enqueue; `status === "changed"` ⇒ enqueue iff `judgment?.meaningful === true` OR `judgment` absent/`judgeEnabled` false (fail-open); else log `gate-skip-*` and 200.
6. `env.FIRECRAWL_INGEST_WORKFLOW.create({ id: \`fc-${checkId}-${hash(url)}\`, params: {...} })`; return 200.

TDD: route test covering the **gate matrix** (`new`/`changed`×{meaningful,absent,low-confidence}/`same`/`error`/`removed`) with a fake workflow binding `{ create: async () => {} }` recording spawns, plus auth (good/bad/missing token).

### Task 11: Poll-fetch exclusion

In `pollAndFetch` (`poll-fetch.ts`) eligibility, add `!getSourceMeta(source).firecrawl?.enabled` to the predicate that decides whether a source is due, so firecrawl-owned sources are never double-fetched by cron. TDD: unit test that a firecrawl-enabled source is excluded from the due set.

### Task 12: End-to-end verification

Deploy; `runMonitor` on the OpenAI source; confirm a release row appears, `fetch_log` shows a `path="firecrawl"` row, and Axiom shows `firecrawl-webhook` + `firecrawl-ingest-workflow` events.

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
