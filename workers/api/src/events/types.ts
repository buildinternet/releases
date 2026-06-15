import type { MediaItem } from "@buildinternet/releases-api-types";

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
  /**
   * Source type (`github`/`scrape`/`feed`/`agent`/`appstore`/`video`). Lets the
   * live feed render the source-type icon for a brand-new item. Additive — older
   * buffered events (and pinned workers) omit it; clients treat `undefined` as
   * unknown and skip the icon.
   */
  sourceType?: string;
  /**
   * Owning org context so the live feed can render an avatar + org name the
   * instant an event arrives, matching the REST-backfilled rows. Resolved at
   * publish time from the source's `org_id`; absent for orphan sources or when
   * the publish-time lookup is unavailable. Avatar fallback: `avatarUrl` →
   * `github.com/<githubHandle>.png` → an initial.
   */
  org?: {
    slug: string;
    name: string;
    avatarUrl: string | null;
    githubHandle: string | null;
  } | null;
  /** Owning product (`sources.product_id`), when grouped. `null`/absent when ungrouped. */
  product?: { slug: string; name: string } | null;
  summary: string | null;
  /**
   * AI-generated headline (#852, renamed in #860). Always null at event time —
   * the generator runs post-insert. Present here only so the wire shape mirrors
   * {@link LatestRelease}; clients can fall back to `title`.
   */
  titleGenerated: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). Same caveat as titleGenerated. */
  titleShort: string | null;
  media: MediaItem[];
  /**
   * Cached release-body size — `LENGTH(content)` and `countTokensSafe`. Lets
   * websocket consumers render a "this release is ~1.5K tokens" hint without
   * round-tripping. Nullable because pre-existing rows landed without the
   * columns; populated for every row inserted post-#958.
   */
  contentChars: number | null;
  contentTokens: number | null;
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
