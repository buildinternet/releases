import { mock, afterEach } from "bun:test";
import { Hono, type ErrorHandler } from "hono";
import { createTestDb as createSnapshotDb, type TestDb } from "../../../tests/db-helper";

export type { TestDb };

// ── pristine globalThis.fetch capture (#1553) ────────────────────────────────
// This preload runs once per test process, before any test module body — so
// fetch is guaranteed pristine here. Capture it on a well-known global that
// `tests/global-fetch.ts` reads, and register a process-wide `afterEach` net so
// a mock installed by any test can never leak into the next file, regardless of
// bun's file-execution order. `??=` keeps the first (pristine) capture if the
// preload ever runs more than once.
const fetchGlobal = globalThis as { __REAL_FETCH__?: typeof fetch };
fetchGlobal.__REAL_FETCH__ ??= globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchGlobal.__REAL_FETCH__!;
});

// Records every `cache.purge(...)` call made through the `cloudflare:workers`
// stub below (there is no real Workers Cache outside workerd). Tests read
// this via `globalThis.__CACHE_PURGE_CALLS__`; cleared after each test so a
// purge in one test can never leak into the next.
const cachePurgeCalls: unknown[] = [];
(globalThis as { __CACHE_PURGE_CALLS__?: unknown[] }).__CACHE_PURGE_CALLS__ = cachePurgeCalls;
afterEach(() => {
  cachePurgeCalls.length = 0;
});

// Stub out cloudflare:workers so Bun can import Durable Objects,
// WorkflowEntrypoints, and the Workers Cache `cache.purge` API outside a
// Worker runtime.
mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class WorkflowEntrypoint {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  cache: {
    purge: async (options: unknown) => {
      cachePurgeCalls.push(options);
      return { success: true, errors: [] };
    },
  },
}));

// Stub cloudflare:workflows. `NonRetryableError` must extend Error and
// carry the right constructor name so the workflow and FakeWorkflowStep
// can detect it via `err.constructor.name`.
mock.module("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {
    constructor(message: string, name?: string) {
      super(message);
      this.name = name ?? "NonRetryableError";
    }
  },
}));

/**
 * In-memory drizzle handle backed by the migrated-DB snapshot in
 * `tests/db-helper.ts`. The snapshot is built once per process; each call
 * deserialises it instead of re-applying every migration file.
 */
export function createTestDb(): TestDb {
  return createSnapshotDb().db;
}

/**
 * Build a fetch-style entrypoint against a Hono app that mounts the given
 * route module(s) under `/v1`. Returns a function with the same shape as the
 * worker's `fetch` handler. Extra env bindings beyond `DB` (e.g. `STATUS_HUB`,
 * `ANTHROPIC_API_KEY`) and a custom `onError` can be passed via `opts`.
 */
// `routes` is typed as `any` because each route module declares its own Hono
// generics (Env, Schema) that don't unify across files — the production app
// has the same issue and resolves it by routing through `.route("/", ...)`.
export function createTestApp(
  db: TestDb,
  // oxlint-disable-next-line no-explicit-any
  routes: any | any[],
  opts: {
    env?: Record<string, unknown>;
    onError?: ErrorHandler;
    // Override the no-op context — e.g. to collect waitUntil promises so a
    // test can await post-response side effects before asserting DB state.
    executionCtx?: ExecutionContext;
  } = {},
): (req: Request) => Response | Promise<Response> {
  // Spread first so an accidental opts.env.DB can't shadow the injected handle.
  const fakeEnv = { ...opts.env, DB: db };
  const fakeCtx =
    opts.executionCtx ??
    ({
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
  const app = new Hono();
  if (opts.onError) app.onError(opts.onError);
  const v1 = new Hono();
  for (const r of Array.isArray(routes) ? routes : [routes]) {
    v1.route("/", r);
  }
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}
