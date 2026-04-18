import {
  type ReleaseEvent,
  type ReleaseEventPayload,
  newEventId,
  padSeq,
} from "./types.js";

/** Minimal storage interface matching Cloudflare DurableObjectStorage's KV subset. */
export interface EventStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<void>;
  list<T>(opts: { prefix: string; startAfter?: string }): Promise<Map<string, T>>;
}

const SEQ_KEY = "seq";
const OLDEST_SEQ_KEY = "oldest-seq";
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

  // On the very first event, record the oldest retained seq.
  if (current === 0) {
    await store.put(OLDEST_SEQ_KEY, 1);
  }

  // Trim oldest if buffer exceeded maxSize.
  if (seq > maxSize) {
    const oldSeq = seq - maxSize;
    await store.delete([`${EVT_PREFIX}${padSeq(oldSeq)}`]);
    await store.put(OLDEST_SEQ_KEY, oldSeq + 1);
  }

  return event;
}

/** Replay events with seq > since, in ascending order. */
export async function replayEvents(
  store: EventStore,
  since: number,
): Promise<ReleaseEvent[]> {
  // A fresh subscriber passes since=0 meaning "everything". We must pass
  // startAfter=undefined in that case — passing padSeq(0) would still work
  // here (no event is ever written at seq 0), but the undefined path is
  // the explicit contract and costs nothing.
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
  return (await store.get<number>(OLDEST_SEQ_KEY)) ?? 0;
}
