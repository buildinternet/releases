import type { LatestRelease } from "./types.js";

export type ServerReady = { type: "ready"; seq: number };
export type SnapshotGap = { type: "snapshot_gap"; since: number; oldestSeq: number };
export type ReleaseCreated = {
  type: "release.created";
  id: string;
  seq: number;
  ts: number;
  release: LatestRelease;
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
    // Jittered sleep avoids thundering-herd reconnects when many clients
    // were disconnected by the same upstream blip.
    await sleep(backoff * (0.5 + Math.random() * 0.5));
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
