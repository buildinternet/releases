import { DurableObject } from "cloudflare:workers";
import {
  appendEvent,
  replayEvents,
  currentSeq,
  oldestSeq,
  type EventStore,
} from "./events/buffer.js";
import {
  EVENT_BUFFER_SIZE,
  type ReleaseEvent,
  type ReleaseEventPayload,
} from "./events/types.js";

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
    if (request.method === "GET" && url.pathname === "/subscribe") {
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
          pair[1].send(JSON.stringify({ type: "snapshot_gap", since, oldestSeq: oldest } satisfies ServerMessage));
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
  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}

  private broadcast(event: ReleaseEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* disconnected */ }
    }
  }
}

function parseSince(raw: string | null): number | null {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
