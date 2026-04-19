import type { MediaItem } from "@releases/lib/api-types";

/** Max events retained per DO. Ring buffer — oldest trimmed when exceeded. ~7 days at current ~700 events/day. */
export const EVENT_BUFFER_SIZE = 7000;

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
