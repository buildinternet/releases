# Release Event Bus Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a `ReleaseHub` Durable Object + WebSocket stream endpoint so clients can subscribe to `release.created` events as they happen. Switch `releases tail -f` from 60s polling to live streaming as the end-to-end proof.

**Architecture:** A single global `ReleaseHub` Durable Object maintains a 1000-event ring buffer in DO storage and fans out `release.created` events over hibernatable WebSockets. Both ingestion paths (`POST /sources/:slug/releases/batch` and the hourly cron `fetchOne`) publish to the hub via `ctx.waitUntil` after D1 commits — publish is fire-and-forget so hub failures never block ingestion. Clients connect to `GET /v1/releases/stream` with an optional `?since=<seq>` for resume after reconnect; if `since` is older than the buffer head, the server emits a `snapshot_gap` message and clients fall back to REST backfill + polling.

**Tech Stack:** Cloudflare Workers (Hono), Durable Objects with Hibernation API, D1, TypeScript strict, Bun test.

---

## Follow-up plans (roadmap, not part of this plan)

This plan delivers only the foundation. Subsequent plans reuse the same bus and DO:

1. **(this plan)** Release event bus + `tail -f` streaming
2. Webhook delivery (subscriptions table + Cloudflare Queue + delivery worker with retry/DLQ/signing) + web live-view page
3. Ingestion-pipeline decoupling (embeddings/media/coverage via Queues) + push-based KV cache invalidation + event-driven overview regen
4. Cron → Queue fan-out for source fetches
5. MCP streaming tool ("subscribe to new releases matching query X")

Each follow-up plan should start with a fresh spec brainstorm before implementation.

---

## Execution notes

- Run in a dedicated worktree / feature branch (memory: no direct pushes to `main`). Suggested branch: `feat/release-event-bus-foundation`.
- All DO + stream work happens under `RELEASED_API_URL=http://localhost:8787` via `bunx wrangler dev` in `workers/api/`. The CLI is already bun-linked, so smoke-test with `RELEASED_API_URL=http://localhost:8787 releases tail -f`.
- Type-check every task with `npx tsc --noEmit`. Unit tests: `bun test tests/unit/<file>.test.ts`.
- Don't run `eval:*` — this plan doesn't touch AI paths.

---

## File structure

### New files

| Path                                        | Responsibility                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `workers/api/src/events/types.ts`           | `ReleaseEvent` wire type, `ReleaseEventPayload`, `EVENT_BUFFER_SIZE`, event-id helper                          |
| `workers/api/src/events/buffer.ts`          | Pure ring-buffer store helpers (`appendEvent`, `replayEvents`) over a tiny `EventStore` interface (KV-shaped). |
| `workers/api/src/events/build-event.ts`     | Pure function mapping inserted rows + source context → `ReleaseEventPayload[]`.                                |
| `workers/api/src/events/publish.ts`         | `publishReleaseEvents(env, { rows, src })` — builds events, POSTs to the hub DO, swallows errors.              |
| `workers/api/src/release-hub.ts`            | `ReleaseHub` Durable Object class (mirrors `status-hub.ts` location).                                          |
| `workers/api/src/routes/stream.ts`          | `GET /v1/releases/stream` WebSocket upgrade route — proxies to the DO.                                         |
| `src/api/stream.ts`                         | Client-side `streamReleases()` async generator with reconnect + `since` resume.                                |
| `tests/unit/event-buffer.test.ts`           | Buffer unit tests with in-memory store.                                                                        |
| `tests/unit/event-build.test.ts`            | Event-build unit tests.                                                                                        |
| `tests/unit/publish-release-events.test.ts` | Publisher unit test (mock DO namespace).                                                                       |
| `tests/unit/stream-client.test.ts`          | Client stream helper unit tests (mock `WebSocket`).                                                            |
| `docs/architecture/events.md`               | Architecture doc: event contract, DO, replay semantics, publish path.                                          |

### Modified files

| Path                                 | Change                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `workers/api/wrangler.jsonc`         | Add `RELEASE_HUB` DO binding + v2 migration.                                                     |
| `workers/api/src/index.ts`           | Export `ReleaseHub`, add `RELEASE_HUB` to `Env.Bindings`, mount `streamRoutes`.                  |
| `workers/api/src/routes/sources.ts`  | After the `/releases/batch` D1 commit, call `ctx.waitUntil(publishReleaseEvents(...))`.          |
| `workers/api/src/cron/poll-fetch.ts` | After `fetchOne` insert, call `publishReleaseEvents` (thread `RELEASE_HUB` through the env arg). |
| `src/cli/commands/tail.ts`           | Follow mode: try `streamReleases()`; fall back to existing polling on error or `snapshot_gap`.   |
| `docs/architecture/remote-mode.md`   | Add a "Realtime streaming" subsection linking to `events.md`.                                    |
| `README.md`                          | Mention `tail -f` now streams (2-3 words).                                                       |

---

## Task 1: Event types + ring buffer (pure)

**Files:**

- Create: `workers/api/src/events/types.ts`
- Create: `workers/api/src/events/buffer.ts`
- Create: `tests/unit/event-buffer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/event-buffer.test.ts
import { describe, it, expect } from "bun:test";
import { appendEvent, replayEvents, type EventStore } from "../../workers/api/src/events/buffer.js";
import type { ReleaseEvent, ReleaseEventPayload } from "../../workers/api/src/events/types.js";

function makeStore(): EventStore {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (map.get(key) ?? null) as T | null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(keys) {
      for (const k of keys) map.delete(k);
    },
    async list<T>({ prefix, startAfter }: { prefix: string; startAfter?: string }) {
      const out = new Map<string, T>();
      const sorted = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      for (const k of sorted) {
        if (startAfter && k <= startAfter) continue;
        out.set(k, map.get(k) as T);
      }
      return out;
    },
  };
}

function payload(id: string): ReleaseEventPayload {
  return {
    id,
    title: `t-${id}`,
    version: null,
    publishedAt: null,
    sourceName: "Acme",
    sourceSlug: "acme",
    contentSummary: null,
    media: [],
  };
}

describe("appendEvent", () => {
  it("assigns monotonic seq starting at 1", async () => {
    const store = makeStore();
    const a = await appendEvent(store, payload("rel_a"), 1000);
    const b = await appendEvent(store, payload("rel_b"), 1000);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.id).toMatch(/^evt_/);
    expect(a.ts).toBeGreaterThan(0);
  });

  it("trims the oldest event when buffer exceeds max size", async () => {
    const store = makeStore();
    for (let i = 0; i < 4; i++) await appendEvent(store, payload(`r${i}`), 2);
    const events = await replayEvents(store, 0);
    expect(events.map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe("replayEvents", () => {
  it("returns events with seq > since in order", async () => {
    const store = makeStore();
    for (let i = 0; i < 3; i++) await appendEvent(store, payload(`r${i}`), 1000);
    const events = await replayEvents(store, 1);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("returns empty when since is at or beyond current head", async () => {
    const store = makeStore();
    await appendEvent(store, payload("r0"), 1000);
    expect(await replayEvents(store, 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/event-buffer.test.ts
```

Expected: FAIL with "Cannot find module" for `../events/buffer.js` and `../events/types.js`.

- [ ] **Step 3: Create the types module**

```ts
// workers/api/src/events/types.ts
import type { MediaItem } from "@releases/api/types.js";

/** Max events retained per DO. Ring buffer — oldest trimmed when exceeded. */
export const EVENT_BUFFER_SIZE = 1000;

/** Zero-padding width for seq-based storage keys so lexicographic list() returns chronological order. */
export const SEQ_PAD_WIDTH = 16;

/** Payload shape for a release.created event. Mirrors api/types.LatestRelease so clients can render without re-fetching. */
export interface ReleaseEventPayload {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  sourceName: string;
  sourceSlug: string;
  contentSummary: string | null;
  media: MediaItem[];
}

/** A stored event with DO-assigned sequence number and id. */
export interface ReleaseEvent {
  /** Globally-unique event id (`evt_<ulid-like>`). Used as `Last-Event-ID` on resume. */
  id: string;
  /** Monotonic sequence number within the DO. Starts at 1. */
  seq: number;
  /** Publish time at the DO (epoch ms). */
  ts: number;
  /** Event type — only `release.created` in this plan. Future: update, delete, coverage-linked, etc. */
  type: "release.created";
  /** The release payload. */
  release: ReleaseEventPayload;
}

/** Short, URL-safe event id — 10 chars of base32-ish random + 4-char timestamp suffix. No crypto dependency. */
export function newEventId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let rand = "";
  for (let i = 0; i < 10; i++) rand += alphabet[Math.floor(Math.random() * alphabet.length)];
  const ts = Date.now().toString(36).slice(-4);
  return `evt_${rand}${ts}`;
}

/** Zero-pad a seq into a fixed-width string so storage list() returns events in order. */
export function padSeq(seq: number): string {
  return seq.toString().padStart(SEQ_PAD_WIDTH, "0");
}
```

- [ ] **Step 4: Create the buffer module**

```ts
// workers/api/src/events/buffer.ts
import { type ReleaseEvent, type ReleaseEventPayload, newEventId, padSeq } from "./types.js";

/** Minimal storage interface matching Cloudflare DurableObjectStorage's KV subset. */
export interface EventStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<void>;
  list<T>(opts: { prefix: string; startAfter?: string }): Promise<Map<string, T>>;
}

const SEQ_KEY = "seq";
const EVT_PREFIX = "evt:";

/** Append one event to the buffer, assigning seq + id. Trims oldest when maxSize exceeded. Returns the stored event. */
export async function appendEvent(
  store: EventStore,
  payload: ReleaseEventPayload,
  maxSize: number,
): Promise<ReleaseEvent> {
  const current = (await store.get<number>(SEQ_KEY)) ?? 0;
  const seq = current + 1;
  const event: ReleaseEvent = {
    id: newEventId(),
    seq,
    ts: Date.now(),
    type: "release.created",
    release: payload,
  };

  await store.put(`${EVT_PREFIX}${padSeq(seq)}`, event);
  await store.put(SEQ_KEY, seq);

  // Trim oldest if buffer exceeded maxSize.
  if (seq > maxSize) {
    const oldSeq = seq - maxSize;
    await store.delete([`${EVT_PREFIX}${padSeq(oldSeq)}`]);
  }

  return event;
}

/** Replay events with seq > since, in ascending order. */
export async function replayEvents(store: EventStore, since: number): Promise<ReleaseEvent[]> {
  const after = since > 0 ? `${EVT_PREFIX}${padSeq(since)}` : undefined;
  const entries = await store.list<ReleaseEvent>({
    prefix: EVT_PREFIX,
    startAfter: after,
  });
  return [...entries.values()];
}

/** Current head seq, or 0 if empty. */
export async function currentSeq(store: EventStore): Promise<number> {
  return (await store.get<number>(SEQ_KEY)) ?? 0;
}

/** Oldest retained seq, or 0 if empty. Used to decide if a caller's `since` is beyond our buffer. */
export async function oldestSeq(store: EventStore): Promise<number> {
  const entries = await store.list<ReleaseEvent>({ prefix: EVT_PREFIX });
  if (entries.size === 0) return 0;
  const first = entries.values().next().value;
  return first?.seq ?? 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/unit/event-buffer.test.ts
```

Expected: PASS (4 passing).

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/events/types.ts workers/api/src/events/buffer.ts tests/unit/event-buffer.test.ts
git commit -m "feat(events): release event types + ring-buffer helpers"
```

---

## Task 2: Event-build pure function

**Files:**

- Create: `workers/api/src/events/build-event.ts`
- Create: `tests/unit/event-build.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/event-build.test.ts
import { describe, it, expect } from "bun:test";
import { buildReleaseEventPayloads } from "../../workers/api/src/events/build-event.js";

describe("buildReleaseEventPayloads", () => {
  it("maps inserted rows + source context to the wire shape", () => {
    const events = buildReleaseEventPayloads({
      src: { name: "Claude Code", slug: "claude-code" },
      inserted: [
        {
          id: "rel_a",
          title: "v1.2.3",
          version: "1.2.3",
          publishedAt: "2026-04-18T10:00:00Z",
          media: '[{"type":"image","url":"https://ex/1.png"}]',
        },
        {
          id: "rel_b",
          title: "v1.2.4",
          version: null,
          publishedAt: null,
          media: null,
        },
      ],
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: "rel_a",
      title: "v1.2.3",
      version: "1.2.3",
      publishedAt: "2026-04-18T10:00:00Z",
      sourceName: "Claude Code",
      sourceSlug: "claude-code",
      contentSummary: null,
      media: [{ type: "image", url: "https://ex/1.png" }],
    });
    expect(events[1].media).toEqual([]);
    expect(events[1].version).toBeNull();
  });

  it("silently yields empty media when the JSON blob is malformed", () => {
    const events = buildReleaseEventPayloads({
      src: { name: "X", slug: "x" },
      inserted: [{ id: "r", title: "t", version: null, publishedAt: null, media: "{not-json" }],
    });
    expect(events[0].media).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/event-build.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create the module**

```ts
// workers/api/src/events/build-event.ts
import type { MediaItem } from "@releases/api/types.js";
import type { ReleaseEventPayload } from "./types.js";

/** Minimal inserted-row shape the batch handler + cron fetchOne already build. */
export interface InsertedReleaseRow {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  /** JSON string as written to D1 (`releases.media`). May be null. */
  media: string | null;
}

export interface BuildEventsInput {
  src: { name: string; slug: string };
  inserted: InsertedReleaseRow[];
}

function parseMedia(raw: string | null): MediaItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as MediaItem[];
  } catch {
    return [];
  }
}

/** Map inserted rows + source context to event payloads. Pure; no I/O. */
export function buildReleaseEventPayloads(input: BuildEventsInput): ReleaseEventPayload[] {
  return input.inserted.map((r) => ({
    id: r.id,
    title: r.title,
    version: r.version,
    publishedAt: r.publishedAt,
    sourceName: input.src.name,
    sourceSlug: input.src.slug,
    contentSummary: null,
    media: parseMedia(r.media),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/event-build.test.ts
```

Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/events/build-event.ts tests/unit/event-build.test.ts
git commit -m "feat(events): pure helper to build release event payloads"
```

---

## Task 3: `ReleaseHub` Durable Object

**Files:**

- Create: `workers/api/src/release-hub.ts`

No unit test — the class is a thin wrapper over Task 1/2 logic + Cloudflare runtime primitives (`DurableObject`, `WebSocketPair`, `acceptWebSocket`). Integration-verified via `wrangler dev` in Task 10's smoke test.

- [ ] **Step 1: Create the DO class**

```ts
// workers/api/src/release-hub.ts
import { DurableObject } from "cloudflare:workers";
import {
  appendEvent,
  replayEvents,
  currentSeq,
  oldestSeq,
  type EventStore,
} from "./events/buffer.js";
import { EVENT_BUFFER_SIZE, type ReleaseEvent, type ReleaseEventPayload } from "./events/types.js";

/** Adapt DurableObjectStorage to our EventStore interface. */
function storageAsEventStore(storage: DurableObjectStorage): EventStore {
  return {
    get: (key) => storage.get(key) as Promise<any>,
    put: (key, value) => storage.put(key, value),
    delete: (keys) => storage.delete(keys).then(() => undefined),
    list: ((opts: { prefix: string; startAfter?: string }) =>
      storage.list(opts) as unknown) as EventStore["list"],
  };
}

/** Messages the server sends to subscribers. */
type ServerMessage =
  | { type: "ready"; seq: number }
  | { type: "snapshot_gap"; since: number; oldestSeq: number }
  | ReleaseEvent;

export class ReleaseHub extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /publish — accept one or more event payloads from the Worker.
    if (request.method === "POST" && url.pathname === "/publish") {
      const body = (await request.json()) as { events: ReleaseEventPayload[] };
      const store = storageAsEventStore(this.ctx.storage);
      const stored: ReleaseEvent[] = [];
      for (const payload of body.events) {
        stored.push(await appendEvent(store, payload, EVENT_BUFFER_SIZE));
      }
      // Fan out to attached sockets. Iteration order is insertion.
      for (const event of stored) this.broadcast(event);
      return new Response(JSON.stringify({ published: stored.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /subscribe — WebSocket upgrade with optional ?since for resume.
    if (url.pathname === "/subscribe") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const since = parseSince(url.searchParams.get("since"));

      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);

      const store = storageAsEventStore(this.ctx.storage);
      const head = await currentSeq(store);

      // Handshake: always emit `ready` so the client learns current head for future resume.
      pair[1].send(JSON.stringify({ type: "ready", seq: head } satisfies ServerMessage));

      if (since !== null) {
        const oldest = await oldestSeq(store);
        if (oldest > 0 && since < oldest - 1) {
          // Caller's cursor is beyond our buffer — they must REST backfill.
          pair[1].send(
            JSON.stringify({
              type: "snapshot_gap",
              since,
              oldestSeq: oldest,
            } satisfies ServerMessage),
          );
        } else if (since < head) {
          // Replay buffered events they missed.
          const replay = await replayEvents(store, since);
          for (const e of replay) pair[1].send(JSON.stringify(e));
        }
      }

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /seq — debugging / test harness aid.
    if (request.method === "GET" && url.pathname === "/seq") {
      const store = storageAsEventStore(this.ctx.storage);
      return new Response(JSON.stringify({ seq: await currentSeq(store) }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {}
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}

  private broadcast(event: ReleaseEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* disconnected */
      }
    }
  }
}

function parseSince(raw: string | null): number | null {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. (The `storageAsEventStore` cast is deliberate — `DurableObjectStorage.list` has a wider type than our `EventStore.list`.)

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/release-hub.ts
git commit -m "feat(events): ReleaseHub Durable Object with publish/subscribe + replay"
```

---

## Task 4: Wrangler config + Env binding

**Files:**

- Modify: `workers/api/wrangler.jsonc`
- Modify: `workers/api/src/index.ts`

- [ ] **Step 1: Add DO binding + migration to wrangler.jsonc**

Find this block:

```jsonc
  "durable_objects": {
    "bindings": [
      { "class_name": "StatusHub", "name": "STATUS_HUB" }
    ]
  },
  "migrations": [
    { "new_classes": ["StatusHub"], "tag": "v1" }
  ],
```

Replace with:

```jsonc
  "durable_objects": {
    "bindings": [
      { "class_name": "StatusHub", "name": "STATUS_HUB" },
      { "class_name": "ReleaseHub", "name": "RELEASE_HUB" }
    ]
  },
  "migrations": [
    { "new_classes": ["StatusHub"], "tag": "v1" },
    { "new_classes": ["ReleaseHub"], "tag": "v2" }
  ],
```

- [ ] **Step 2: Export `ReleaseHub` and add to `Env` in index.ts**

In `workers/api/src/index.ts`, locate the `StatusHub` re-export near line 36:

```ts
export { StatusHub } from "./status-hub.js";
```

Add below it:

```ts
export { ReleaseHub } from "./release-hub.js";
```

In the `Env.Bindings` block (around line 45), locate:

```ts
STATUS_HUB: DurableObjectNamespace;
```

Add below it:

```ts
RELEASE_HUB: DurableObjectNamespace;
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke-check wrangler config**

```bash
(cd workers/api && bunx wrangler deploy --dry-run)
```

Expected: dry-run succeeds, output mentions both `StatusHub` and `ReleaseHub` bindings.

- [ ] **Step 5: Commit**

```bash
git add workers/api/wrangler.jsonc workers/api/src/index.ts
git commit -m "feat(events): bind ReleaseHub durable object in api worker"
```

---

## Task 5: Stream route

**Files:**

- Create: `workers/api/src/routes/stream.ts`
- Modify: `workers/api/src/index.ts`

- [ ] **Step 1: Create the route**

```ts
// workers/api/src/routes/stream.ts
import { Hono } from "hono";
import type { Env } from "../index.js";

export const streamRoutes = new Hono<Env>();

/**
 * GET /v1/releases/stream — public WebSocket that streams `release.created`
 * events as they are published to the release hub.
 *
 * Query params:
 *   - `since=<seq>`  — replay any buffered events with seq > since on connect.
 *                       If since < oldestSeq the server emits a `snapshot_gap`
 *                       message; clients must REST-backfill and re-subscribe.
 *
 * On connect the server sends `{ "type": "ready", "seq": <head> }` so callers
 * that don't pass `?since` still learn the current sequence for later resume.
 */
streamRoutes.get("/releases/stream", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const stub = c.env.RELEASE_HUB.get(c.env.RELEASE_HUB.idFromName("global"));
  const url = new URL(c.req.raw.url);
  const since = url.searchParams.get("since");
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  return stub.fetch(
    new Request(`https://do/subscribe${qs}`, {
      headers: c.req.raw.headers,
    }),
  );
});
```

- [ ] **Step 2: Mount in index.ts**

In `workers/api/src/index.ts`, add with the other route imports near the top:

```ts
import { streamRoutes } from "./routes/stream.js";
```

Add to the no-auth route group near line 97:

```ts
v1.route("/", streamRoutes);
```

(Place it alongside `statusRoutes` and `mediaRoutes` — stream is public, no auth middleware.)

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke-check**

Start the worker:

```bash
(cd workers/api && bunx wrangler dev)
```

In another terminal:

```bash
curl -i http://localhost:8787/v1/releases/stream
```

Expected: `HTTP/1.1 426 Upgrade Required` with body `Expected WebSocket upgrade`.

Stop wrangler.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/stream.ts workers/api/src/index.ts
git commit -m "feat(api): GET /v1/releases/stream WebSocket route"
```

---

## Task 6: Publisher helper

**Files:**

- Create: `workers/api/src/events/publish.ts`
- Create: `tests/unit/publish-release-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/publish-release-events.test.ts
import { describe, it, expect, mock } from "bun:test";
import { publishReleaseEvents } from "../../workers/api/src/events/publish.js";

function makeHub() {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const stub = {
    fetch: async (req: Request) => {
      calls.push({ url: req.url, method: req.method, body: await req.text() });
      return new Response(JSON.stringify({ published: 1 }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const namespace = {
    idFromName: (name: string) => name as any,
    get: () => stub as any,
  };
  return { namespace, calls };
}

describe("publishReleaseEvents", () => {
  it("POSTs /publish with mapped payloads to the global DO", async () => {
    const { namespace, calls } = makeHub();
    await publishReleaseEvents(
      { RELEASE_HUB: namespace as any },
      {
        src: { name: "Claude Code", slug: "claude-code" },
        inserted: [{ id: "rel_a", title: "t", version: null, publishedAt: null, media: null }],
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toMatch(/\/publish$/);
    const body = JSON.parse(calls[0].body ?? "{}");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].sourceSlug).toBe("claude-code");
  });

  it("is a no-op on empty inserted arrays (no DO call)", async () => {
    const { namespace, calls } = makeHub();
    await publishReleaseEvents(
      { RELEASE_HUB: namespace as any },
      { src: { name: "x", slug: "x" }, inserted: [] },
    );
    expect(calls).toHaveLength(0);
  });

  it("swallows errors from the hub (ingestion must not fail on publish errors)", async () => {
    const namespace = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async () => {
          throw new Error("hub down");
        },
      }),
    };
    await expect(
      publishReleaseEvents(
        { RELEASE_HUB: namespace as any },
        {
          src: { name: "x", slug: "x" },
          inserted: [{ id: "r", title: "t", version: null, publishedAt: null, media: null }],
        },
      ),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/publish-release-events.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create the publisher**

```ts
// workers/api/src/events/publish.ts
import { buildReleaseEventPayloads, type InsertedReleaseRow } from "./build-event.js";

export interface PublishContext {
  src: { name: string; slug: string };
  inserted: InsertedReleaseRow[];
}

/**
 * Publish release.created events to the ReleaseHub DO. Fire-and-forget —
 * callers wrap this in `ctx.waitUntil()` after the D1 write. Hub failures
 * are logged but never thrown, so ingestion never fails on publish errors.
 *
 * No-op when `inserted` is empty.
 */
export async function publishReleaseEvents(
  env: { RELEASE_HUB: DurableObjectNamespace },
  ctx: PublishContext,
): Promise<void> {
  if (ctx.inserted.length === 0) return;
  const events = buildReleaseEventPayloads(ctx);
  try {
    const stub = env.RELEASE_HUB.get(env.RELEASE_HUB.idFromName("global"));
    const res = await stub.fetch(
      new Request("https://do/publish", {
        method: "POST",
        body: JSON.stringify({ events }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    if (!res.ok) {
      console.warn(`[events] publish returned ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    console.warn(`[events] publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/publish-release-events.test.ts
```

Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/events/publish.ts tests/unit/publish-release-events.test.ts
git commit -m "feat(events): publisher helper that fans events into ReleaseHub"
```

---

## Task 7: Publish on `/releases/batch`

**Files:**

- Modify: `workers/api/src/routes/sources.ts`

- [ ] **Step 1: Add the import**

At the top of `workers/api/src/routes/sources.ts`, with the other local imports (around line 10):

```ts
import { publishReleaseEvents } from "../events/publish.js";
```

- [ ] **Step 2: Publish after the D1 commit**

Locate the batch-insert block around line 298–305 (after the `for` loop that inserts chunks and builds `insertedIds`). Just before the existing `if (insertedIds.length > 0) { c.executionCtx.waitUntil(...)` embedding block, add:

```ts
// Fire-and-forget publish to the ReleaseHub DO so subscribers (CLI
// `tail -f`, the upcoming web live view, webhook delivery) see new
// releases in real time. Builds the event payload from the already-
// prepared chunk, so no extra D1 roundtrip is needed.
if (insertedIds.length > 0) {
  const publishRows = body.releases
    .map((r, i) => ({
      id: insertedIds[i] ?? "",
      title: r.title,
      version: r.version ?? null,
      publishedAt: r.publishedAt ?? null,
      media: r.media ?? null,
    }))
    .filter((r) => r.id !== "");
  c.executionCtx.waitUntil(
    publishReleaseEvents(c.env, {
      src: { name: src.name, slug: src.slug },
      inserted: publishRows,
    }),
  );
}
```

**Note:** `body.releases` and `insertedIds` can diverge in length when `onConflictDoUpdate` returns fewer rows than submitted (pure no-ops still return the row, but the parallel-array assumption holds because RETURNING preserves input order for the `VALUES(...)` batch). The `.filter` guards against any edge case where the loop truncates.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Verify existing tests still pass**

```bash
bun test tests/unit/api-client.test.ts
```

Expected: PASS (unchanged count).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "feat(api): publish release events on /sources/:slug/releases/batch"
```

---

## Task 8: Publish on cron `fetchOne`

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts`

- [ ] **Step 1: Thread `RELEASE_HUB` through `fetchOne`'s env arg**

Read `workers/api/src/cron/poll-fetch.ts` to find the `fetchOne` signature and its env type. Add `RELEASE_HUB?: DurableObjectNamespace;` to the env type that `fetchOne` accepts (it will be the same env object the route/cron caller passes; `index.ts` already has it on `Env.Bindings`).

If `fetchOne` is called from `pollAndFetch` in the same file, no additional plumbing is needed — the env object passed to `pollAndFetch` in `index.ts:216-226` already contains `RELEASE_HUB`.

- [ ] **Step 2: Add the import**

At the top of `workers/api/src/cron/poll-fetch.ts`:

```ts
import { publishReleaseEvents } from "../events/publish.js";
```

- [ ] **Step 3: Publish after the insert, before the embed side-effect**

Locate the block around line 296–305 (inside `fetchOne`, just after the `for` loop that builds `insertedIds`, and before the `if (insertedIds.length > 0 && env.RELEASES_INDEX)` embedding block). Add:

```ts
if (insertedIds.length > 0 && env.RELEASE_HUB) {
  // Build event rows from the already-prepared `rows` array (parallel
  // to insertedIds by insertion order). Fire-and-forget — publish
  // errors are swallowed inside publishReleaseEvents.
  const publishRows = rows.slice(0, insertedIds.length).map((r, i) => ({
    id: insertedIds[i],
    title: r.title,
    version: r.version ?? null,
    publishedAt: r.publishedAt,
    media: r.media ?? null,
  }));
  await publishReleaseEvents(
    { RELEASE_HUB: env.RELEASE_HUB },
    { src: { name: source.name, slug: source.slug }, inserted: publishRows },
  );
}
```

**Note:** Cron runs inside a `ctx.waitUntil` at the scheduled handler in `index.ts`, so `await`-ing publish is fine — it still shares the cron's duration budget, but errors are internally swallowed.

`rows.slice(0, insertedIds.length)` is defensive — `rows` is the full pre-insert array while `insertedIds` only contains rows that survived `onConflictDoNothing`. On cron, no-ops silently drop, so the two arrays can diverge in length. Preserving insertion order gives us the correct zip for the ones that made it.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts
git commit -m "feat(cron): publish release events from hourly fetch pipeline"
```

---

## Task 9: Client stream helper

**Files:**

- Create: `src/api/stream.ts`
- Create: `tests/unit/stream-client.test.ts`

This helper runs in Bun (CLI), not in the Worker. Bun provides the `WebSocket` global natively.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/stream-client.test.ts
import { describe, it, expect } from "bun:test";
import { streamReleases, type StreamMessage } from "../../src/api/stream.js";

// Tiny mock WebSocket that replays a scripted message sequence and then closes.
function mockWs(script: Array<StreamMessage | "close">) {
  const listeners: Record<string, (ev: any) => void> = {};
  const ws: any = {
    readyState: 0,
    close() {
      listeners.close?.({});
    },
    addEventListener(type: string, fn: (ev: any) => void) {
      listeners[type] = fn;
    },
    removeEventListener(type: string, _fn: any) {
      delete listeners[type];
    },
    send() {},
  };
  setTimeout(() => {
    ws.readyState = 1;
    listeners.open?.({});
    for (const msg of script) {
      if (msg === "close") {
        listeners.close?.({ wasClean: true });
        break;
      }
      listeners.message?.({ data: JSON.stringify(msg) });
    }
    listeners.close?.({ wasClean: true });
  }, 0);
  return ws;
}

describe("streamReleases", () => {
  it("yields release.created events and the ready handshake", async () => {
    const ws = mockWs([
      { type: "ready", seq: 0 },
      { type: "release.created", id: "evt_1", seq: 1, ts: 0, release: stubPayload("a") },
      { type: "release.created", id: "evt_2", seq: 2, ts: 0, release: stubPayload("b") },
      "close",
    ]);
    const messages: StreamMessage[] = [];
    for await (const m of streamReleases({
      url: "ws://fake",
      openWebSocket: () => ws,
      reconnect: false,
    })) {
      messages.push(m);
    }
    expect(messages.map((m) => m.type)).toEqual(["ready", "release.created", "release.created"]);
  });

  it("signals snapshot_gap so the caller can switch to polling", async () => {
    const ws = mockWs([
      { type: "ready", seq: 100 },
      { type: "snapshot_gap", since: 1, oldestSeq: 50 },
      "close",
    ]);
    const seen: string[] = [];
    for await (const m of streamReleases({
      url: "ws://fake",
      openWebSocket: () => ws,
      reconnect: false,
    })) {
      seen.push(m.type);
      if (m.type === "snapshot_gap") break;
    }
    expect(seen).toContain("snapshot_gap");
  });
});

function stubPayload(id: string) {
  return {
    id,
    title: `t-${id}`,
    version: null,
    publishedAt: null,
    sourceName: "x",
    sourceSlug: "x",
    contentSummary: null,
    media: [],
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/stream-client.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create the client**

```ts
// src/api/stream.ts
import type { ReleaseEvent, ReleaseEventPayload } from "@releases/events/types.js";

// We don't have a TS path alias for workers/api internals from the CLI.
// Inline the minimal type surface we need rather than crossing that boundary.

export type ServerReady = { type: "ready"; seq: number };
export type SnapshotGap = { type: "snapshot_gap"; since: number; oldestSeq: number };
export type ReleaseCreated = {
  type: "release.created";
  id: string;
  seq: number;
  ts: number;
  release: ReleaseEventPayload;
};
export type StreamMessage = ServerReady | SnapshotGap | ReleaseCreated;

export interface StreamOptions {
  /** Full WebSocket URL including `?since=` if resuming. */
  url: string;
  /** Override for tests — defaults to `new WebSocket(url)`. */
  openWebSocket?: (url: string) => WebSocket;
  /** Reconnect on close. Default `true`; tests pass `false` for determinism. */
  reconnect?: boolean;
  /** Initial reconnect backoff, ms. Default 500. Doubles up to 30s. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Async generator that yields server messages from the release stream.
 * The caller decides what to do with each message (render, log, break).
 *
 * On `snapshot_gap` the caller should REST-backfill; we still yield the message
 * so the caller is explicit about the recovery path rather than the helper
 * silently swallowing state drift.
 *
 * Auto-reconnects with exponential backoff on transport close, reusing the
 * most recent `seq` as `?since` so no events are missed across reconnects.
 */
export async function* streamReleases(opts: StreamOptions): AsyncGenerator<StreamMessage> {
  const open = opts.openWebSocket ?? ((u) => new WebSocket(u));
  const minMs = opts.minBackoffMs ?? 500;
  const maxMs = opts.maxBackoffMs ?? 30_000;
  const reconnect = opts.reconnect ?? true;

  let lastSeq = 0;
  let backoff = minMs;

  while (true) {
    const url = lastSeq > 0 ? urlWithSince(opts.url, lastSeq) : opts.url;
    const buffered: StreamMessage[] = [];
    const pending: Array<(v: { done: boolean; value?: StreamMessage }) => void> = [];
    let closed = false;

    const ws = open(url);
    const push = (m: StreamMessage) => {
      if (pending.length > 0) pending.shift()!({ done: false, value: m });
      else buffered.push(m);
    };
    const finish = () => {
      closed = true;
      while (pending.length > 0) pending.shift()!({ done: true });
    };

    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as StreamMessage;
        if (m.type === "ready") lastSeq = Math.max(lastSeq, m.seq);
        if (m.type === "release.created") lastSeq = Math.max(lastSeq, m.seq);
        push(m);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("close", () => finish());
    ws.addEventListener("error", () => finish());

    // Drain: yield whatever comes down the socket until it closes.
    while (true) {
      if (buffered.length > 0) {
        yield buffered.shift()!;
        continue;
      }
      if (closed) break;
      const next = await new Promise<{ done: boolean; value?: StreamMessage }>((resolve) =>
        pending.push(resolve),
      );
      if (next.done) break;
      yield next.value!;
    }

    if (!reconnect) return;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, maxMs);
  }
}

function urlWithSince(url: string, since: number): string {
  const u = new URL(url);
  u.searchParams.set("since", String(since));
  return u.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Note:** The `@releases/events/types.js` import crosses the worker/CLI boundary. The project's tsconfig maps `@releases/*` to `src/*`, not `workers/api/src/*`. Resolve this by **inlining the types** rather than adding a new alias — the worker's `ReleaseEventPayload` and our CLI-side one should drift independently. Remove the import line and replace with:

```ts
import type { MediaItem } from "./types.js";

interface ReleaseEventPayload {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  sourceName: string;
  sourceSlug: string;
  contentSummary: string | null;
  media: MediaItem[];
}
```

Apply that fix, re-check.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/stream-client.test.ts
```

Expected: PASS (2 passing).

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/stream.ts tests/unit/stream-client.test.ts
git commit -m "feat(cli): WebSocket stream client with reconnect + seq resume"
```

---

## Task 10: `tail -f` uses streaming with fallback

**Files:**

- Modify: `src/cli/commands/tail.ts`

The existing polling loop already tracks seen IDs — that stays intact. We insert a streaming mode above polling that kicks in when follow mode is requested; polling becomes the fallback.

- [ ] **Step 1: Add imports at the top of tail.ts**

```ts
import { streamReleases, type StreamMessage } from "../../api/stream.js";
import { getApiUrl, isRemoteMode } from "../../lib/mode.js";
```

- [ ] **Step 2: Build a helper that returns the stream URL (or null in local mode)**

Near the top of the file, before `registerTailCommand`, add:

```ts
function streamUrl(): string | null {
  if (!isRemoteMode()) return null;
  const http = getApiUrl();
  if (!http) return null;
  const ws = http.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${ws}/v1/releases/stream`;
}
```

- [ ] **Step 3: Replace the follow-mode `while(true) { poll }` block**

Locate the current follow-mode tail (lines 104–129 of `src/cli/commands/tail.ts`):

```ts
if (!opts.follow) return;

const seen = new Set<string>();
rememberSeen(
  seen,
  rows.map((r) => r.id),
);
console.error(chalk.dim(`\n  Following (every ${intervalSeconds}s). Ctrl-C to stop.`));

while (true) {
  await sleep(intervalSeconds * 1000);
  const fresh = await getLatestReleases(fetchOpts);
  const novel = fresh.filter((r) => !seen.has(r.id));
  if (novel.length === 0) continue;

  rememberSeen(
    seen,
    novel.map((r) => r.id),
  );
  const ordered = novel.slice().reverse();
  if (opts.json) {
    for (const row of ordered) console.log(JSON.stringify(row));
  } else {
    for (const row of ordered) console.log(renderStreamLine(row));
  }
}
```

Replace with:

```ts
      if (!opts.follow) return;

      const seen = new Set<string>();
      rememberSeen(seen, rows.map((r) => r.id));

      // Try live streaming first in remote mode. On snapshot_gap or transport
      // failure, fall through to polling using the same seen-id dedup set so
      // transport transitions don't double-print.
      const wsUrl = streamUrl();
      const streamed = wsUrl
        ? await tryStream(wsUrl, fetchOpts, seen, opts.json === true)
        : false;

      if (!streamed) {
        console.error(
          chalk.dim(`\n  Following (every ${intervalSeconds}s). Ctrl-C to stop.`),
        );
        while (true) {
          await sleep(intervalSeconds * 1000);
          const fresh = await getLatestReleases(fetchOpts);
          const novel = fresh.filter((r) => !seen.has(r.id));
          if (novel.length === 0) continue;

          rememberSeen(seen, novel.map((r) => r.id));
          const ordered = novel.slice().reverse();
          if (opts.json) {
            for (const row of ordered) console.log(JSON.stringify(row));
          } else {
            for (const row of ordered) console.log(renderStreamLine(row));
          }
        }
      }
    });
}
```

- [ ] **Step 4: Add the `tryStream` helper below `registerTailCommand`**

```ts
/**
 * Stream live events. Returns true when it finished cleanly (process should
 * exit), false when it never connected (caller should fall back to polling),
 * or runs forever until the process is signalled.
 *
 * Fall-through cases:
 *   - Initial connection fails (no ready handshake within 5s).
 *   - Server emits `snapshot_gap` — our seq cursor fell behind the buffer.
 */
async function tryStream(
  url: string,
  fetchOpts: {
    slug?: string;
    orgSlug?: string;
    count: number;
    includeCoverage?: boolean;
  },
  seen: Set<string>,
  asJson: boolean,
): Promise<boolean> {
  console.error(chalk.dim(`\n  Streaming. Ctrl-C to stop.`));
  let connected = false;

  try {
    for await (const msg of streamReleases({ url })) {
      if (msg.type === "ready") {
        connected = true;
        continue;
      }
      if (msg.type === "snapshot_gap") {
        console.error(chalk.yellow("  Stream fell behind — falling back to polling."));
        return false;
      }
      if (msg.type === "release.created") {
        if (seen.has(msg.release.id)) continue;
        rememberSeen(seen, [msg.release.id]);
        // Apply client-side filters equivalent to the REST endpoint —
        // the stream is unfiltered, so callers with --org or a source slug
        // must drop non-matching events.
        if (fetchOpts.slug && msg.release.sourceSlug !== fetchOpts.slug) continue;
        // --org filtering cannot be done purely from the payload (we'd
        // need orgSlug on the event). For now skip org filtering on the
        // stream path and fall back to polling when --org is set.
        if (fetchOpts.orgSlug) return false;
        if (asJson) console.log(JSON.stringify(msg.release));
        else console.log(renderStreamLine(msg.release));
      }
    }
    return connected;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(chalk.yellow(`  Stream error: ${reason}. Falling back to polling.`));
    return false;
  }
}
```

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Smoke test end-to-end locally**

In terminal 1:

```bash
cd workers/api && bunx wrangler dev
```

In terminal 2 (seed one release via the batch endpoint, then observe the stream):

```bash
export RELEASED_API_URL=http://localhost:8787
releases tail -f
```

Expected: within ~1s, the CLI prints `Streaming. Ctrl-C to stop.` (no errors). Leave it running.

In terminal 3, trigger a write against a dev source (substitute a known slug if the local DB has one; otherwise skip this step and rely on the ingest-hook test below):

```bash
# If dev DB has a source, pick one and force a re-fetch.
releases admin source fetch <slug> --max 1
```

Expected behavior in terminal 2: a new `release.created` line is printed within 1-2s, no retry-polling banner shown. Ctrl-C to stop.

**If the dev DB has no suitable source**, note the limitation in the commit message and rely on the integration check after deploy (see Task 11 docs).

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/tail.ts
git commit -m "feat(cli): tail -f uses live WebSocket stream with polling fallback"
```

---

## Task 11: Documentation

**Files:**

- Create: `docs/architecture/events.md`
- Modify: `docs/architecture/remote-mode.md`
- Modify: `README.md`

- [ ] **Step 1: Write the architecture doc**

````markdown
<!-- docs/architecture/events.md -->

# Release event bus

The API worker publishes a `release.created` event each time a release row is
inserted (or upserted) into D1. Subscribers receive the events over a
WebSocket at `GET /v1/releases/stream`. A single global Durable Object
(`ReleaseHub`, bound as `RELEASE_HUB`) owns fan-out and a 1000-event ring
buffer for short-window resume.

## Event contract

```jsonc
{
  "type": "release.created",
  "id": "evt_abc123def4xyz", // globally unique event id
  "seq": 42, // monotonic sequence within the DO
  "ts": 1713484800000, // epoch ms at publish time
  "release": {
    "id": "rel_...",
    "title": "v1.2.3",
    "version": "1.2.3",
    "publishedAt": "2026-04-18T10:00:00Z",
    "sourceName": "Claude Code",
    "sourceSlug": "claude-code",
    "contentSummary": null, // omitted on publish; clients fetch via REST if needed
    "media": [],
  },
}
```
````

`seq` is the cursor. Clients should store the most recent seq they
observed and pass it as `?since=<seq>` on reconnect.

## Handshake and replay

1. Client opens `GET /v1/releases/stream[?since=<seq>]` with an `Upgrade: websocket` header.
2. Server sends `{ "type": "ready", "seq": <head> }` as the first frame — even when `since` is omitted, so the client knows the current head for future resume.
3. If `since` was provided and is within the buffer (`since >= oldestSeq - 1`), the server replays each missed event in order.
4. If `since` is older than the buffer head, the server sends `{ "type": "snapshot_gap", "since": <caller>, "oldestSeq": <head> }`. The client should REST-backfill via `GET /v1/releases/latest` and re-subscribe from the new head.

## Publish path

Two ingest sites call `publishReleaseEvents(env, { src, inserted })` via
`ctx.waitUntil` after the D1 commit:

- `POST /v1/sources/:slug/releases/batch` (primary CLI fetch path) — `workers/api/src/routes/sources.ts`
- Hourly cron `fetchOne` — `workers/api/src/cron/poll-fetch.ts`

`publishReleaseEvents` is fire-and-forget: any hub failure is logged and
swallowed so publish errors cannot fail ingestion. `onConflictDoUpdate` can
produce duplicate events on URL collisions; clients dedupe by `release.id`.

## Cost envelope (initial rollout)

With an average of ~10 new releases per hour and ~70 subscribers (mix of
CLI tails and future web live-view tabs + webhook consumers), the hub
runs in the pennies-per-month range. Hibernation keeps idle connections
free; the buffer is bounded at 1000 events so DO storage stays flat.

See `docs/architecture/remote-mode.md` for how this relates to the
cached `/v1/releases/latest` endpoint (which remains the REST fallback
and the backfill path after `snapshot_gap`).

````

- [ ] **Step 2: Add a Realtime subsection to remote-mode.md**

At the end of `docs/architecture/remote-mode.md`, append:

```markdown

## Realtime streaming

`GET /v1/releases/stream` is a public WebSocket that emits `release.created`
events as they land in D1. Backed by the global `ReleaseHub` Durable Object
with hibernation. The CLI's `tail -f` uses this stream in remote mode and
falls back to polling `/v1/releases/latest` on transport failure or
`snapshot_gap`. See [events.md](./events.md).
````

- [ ] **Step 3: Add a short mention to README.md**

Find the section documenting `tail -f` or `tail`. If `tail -f` is described, add one line indicating it uses live streaming in remote mode and falls back to polling. Otherwise skip — don't introduce a new README section for this.

- [ ] **Step 4: Verify no docs reference a nonexistent endpoint**

```bash
grep -rn "releases/stream" docs README.md AGENTS.md
```

Expected: references only in the new `events.md` and the updated `remote-mode.md` (and optionally README.md).

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/events.md docs/architecture/remote-mode.md README.md
git commit -m "docs: release event bus architecture"
```

---

## Final verification

- [ ] **Step 1: Type-check the full repo**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run all unit tests**

```bash
bun test
```

Expected: PASS (existing count + 9 new tests from Tasks 1/2/6/9).

- [ ] **Step 3: Dry-run deploy to validate wrangler config**

```bash
(cd workers/api && bunx wrangler deploy --dry-run)
```

Expected: success. Output lists `StatusHub` + `ReleaseHub` as DO bindings and shows a v2 migration.

- [ ] **Step 4: Open a PR on a feature branch**

```bash
git push -u origin feat/release-event-bus-foundation
gh pr create --title "feat: release event bus foundation (tail -f streaming)" --body-file /tmp/pr-body.md
```

Prior to running `gh pr create`, write the PR body to `/tmp/pr-body.md` with a short summary, the link to this plan, a test plan checklist (type-check, unit tests, wrangler dry-run, manual `tail -f` smoke), and the follow-up roadmap. Memory rule: prefer `--body-file` over HEREDOC to avoid backtick escaping in rendered markdown.

---

## Self-review

**Spec coverage:**

- Event model (contract) — Task 1 + doc
- `ReleaseHub` DO (WebSocket + hibernation + buffer + replay) — Task 3
- Wrangler binding + migration — Task 4
- Stream endpoint — Task 5
- Publisher helper — Task 6
- Publish from `/releases/batch` — Task 7
- Publish from cron — Task 8
- CLI client w/ reconnect + resume — Task 9
- `tail -f` integration with graceful fallback — Task 10
- Docs — Task 11

All items from the "Plan 1" brainstorm are covered. Web live view, webhooks, Queue-backed decoupling, cache push-invalidation, MCP streaming, and cron queue fan-out are explicitly deferred to follow-up plans.

**Placeholder scan:** no TBDs. Every code block is complete. Tests have real assertions, not outlines.

**Type consistency:**

- `ReleaseEvent`, `ReleaseEventPayload`, `EVENT_BUFFER_SIZE`, `EventStore`, `InsertedReleaseRow` names are stable across Tasks 1-6.
- `publishReleaseEvents(env, ctx)` signature matches between Task 6 (definition) and Tasks 7/8 (callers).
- `streamReleases(opts)` signature in Task 9 matches the call in Task 10.
- `StreamMessage` union types match between server (`release-hub.ts`) and client (`stream.ts`) — both use `ready`, `snapshot_gap`, `release.created`.
- `fetchOpts` passed into `tryStream` (Task 10) matches the existing shape in `tail.ts`.

**Known cross-boundary note (intentional):** Task 9 inlines a copy of `ReleaseEventPayload` in the CLI rather than importing from the worker — the worker/CLI tsconfigs don't share aliases, and the two types are allowed to drift (the worker can enrich the event payload without forcing a CLI release). Documented inline where it happens.
