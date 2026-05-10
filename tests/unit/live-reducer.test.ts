import { describe, expect, test } from "bun:test";
import {
  liveReducer,
  type LiveState,
  type LiveRelease,
  INITIAL_LIVE_STATE,
  LIVE_MAX_ITEMS,
  fromStreamEvent,
  fromLatestItem,
} from "../../web/src/hooks/use-release-stream";

const rel = (id: string, overrides: Partial<LiveRelease> = {}): LiveRelease => ({
  id,
  title: `Release ${id}`,
  version: "1.0.0",
  publishedAt: "2026-04-23T10:00:00Z",
  source: { slug: "acme", name: "ACME" },
  url: undefined,
  ...overrides,
});

describe("liveReducer", () => {
  test("ready action sets seq and marks connected", () => {
    const next = liveReducer(INITIAL_LIVE_STATE, { type: "ws-ready", seq: 42 });
    expect(next.lastSeq).toBe(42);
    expect(next.connected).toBe(true);
    expect(next.mode).toBe("websocket");
  });

  test("ws-event prepends a release and advances seq", () => {
    const base: LiveState = { ...INITIAL_LIVE_STATE, connected: true, lastSeq: 0 };
    const next = liveReducer(base, {
      type: "ws-event",
      seq: 1,
      release: rel("rel_a"),
    });
    expect(next.releases[0]?.id).toBe("rel_a");
    expect(next.lastSeq).toBe(1);
  });

  test("dedupes releases by id across ws and rest actions", () => {
    const s1 = liveReducer(INITIAL_LIVE_STATE, {
      type: "ws-event",
      seq: 1,
      release: rel("rel_a"),
    });
    const s2 = liveReducer(s1, { type: "rest-batch", releases: [rel("rel_a"), rel("rel_b")] });
    // rel_a dedupes; rel_b is fresh and prepends (REST `latest` is newest-first).
    expect(s2.releases.map((r) => r.id)).toEqual(["rel_b", "rel_a"]);
  });

  test("ws-event lifts connected even if ws-ready never arrived", () => {
    const next = liveReducer(INITIAL_LIVE_STATE, {
      type: "ws-event",
      seq: 1,
      release: rel("rel_a"),
    });
    expect(next.connected).toBe(true);
  });

  test("rest-batch inserts fresh items when list is already at LIVE_MAX_ITEMS", () => {
    let state: LiveState = INITIAL_LIVE_STATE;
    for (let i = 0; i < LIVE_MAX_ITEMS; i++) {
      state = liveReducer(state, { type: "ws-event", seq: i + 1, release: rel(`rel_${i}`) });
    }
    const next = liveReducer(state, { type: "rest-batch", releases: [rel("rel_new")] });
    expect(next.releases.length).toBe(LIVE_MAX_ITEMS);
    expect(next.releases[0]?.id).toBe("rel_new");
  });

  test("polling-start does not flip mode while connected", () => {
    const s1 = liveReducer(INITIAL_LIVE_STATE, { type: "ws-ready", seq: 1 });
    const s2 = liveReducer(s1, { type: "polling-start" });
    expect(s2.mode).toBe("websocket");
  });

  test("caps release list at LIVE_MAX_ITEMS, newest first", () => {
    let state: LiveState = INITIAL_LIVE_STATE;
    for (let i = 0; i < LIVE_MAX_ITEMS + 5; i++) {
      state = liveReducer(state, {
        type: "ws-event",
        seq: i + 1,
        release: rel(`rel_${i}`),
      });
    }
    expect(state.releases.length).toBe(LIVE_MAX_ITEMS);
    expect(state.releases[0]?.id).toBe(`rel_${LIVE_MAX_ITEMS + 4}`);
  });

  test("ws-close flips connected off and leaves releases intact", () => {
    const s1 = liveReducer(INITIAL_LIVE_STATE, {
      type: "ws-event",
      seq: 1,
      release: rel("rel_a"),
    });
    const s2 = liveReducer(s1, { type: "ws-close" });
    expect(s2.connected).toBe(false);
    expect(s2.releases.length).toBe(1);
  });

  test("polling-start flips mode to polling once", () => {
    const closed = liveReducer(INITIAL_LIVE_STATE, { type: "ws-close" });
    const polling = liveReducer(closed, { type: "polling-start" });
    expect(polling.mode).toBe("polling");
  });

  test("snapshot-gap clears lastSeq so next connect is fresh", () => {
    const s1 = liveReducer(INITIAL_LIVE_STATE, { type: "ws-ready", seq: 99 });
    const s2 = liveReducer(s1, { type: "snapshot-gap" });
    expect(s2.lastSeq).toBeUndefined();
  });

  test("rest-batch does not downgrade connected state", () => {
    const s1 = liveReducer(INITIAL_LIVE_STATE, { type: "ws-ready", seq: 10 });
    const s2 = liveReducer(s1, { type: "rest-batch", releases: [rel("rel_a")] });
    expect(s2.connected).toBe(true);
    expect(s2.mode).toBe("websocket");
  });
});

describe("normalizers", () => {
  test("fromStreamEvent maps WS payload to LiveRelease", () => {
    const out = fromStreamEvent({
      id: "evt_1",
      seq: 5,
      ts: 1713880800000,
      type: "release.created",
      release: {
        id: "rel_a",
        title: "v1.2.3",
        version: "1.2.3",
        publishedAt: "2026-04-23T10:00:00Z",
        sourceName: "ACME",
        sourceSlug: "acme",
        summary: null,
        contentSummary: null,
        media: [],
      },
    });
    expect(out).toEqual({
      id: "rel_a",
      title: "v1.2.3",
      version: "1.2.3",
      publishedAt: "2026-04-23T10:00:00Z",
      source: { slug: "acme", name: "ACME" },
      url: undefined,
    });
  });

  test("fromLatestItem maps REST payload to LiveRelease", () => {
    const out = fromLatestItem({
      id: "rel_b",
      version: null,
      type: "feature",
      title: "Big launch",
      summary: null,
      publishedAt: "2026-04-23T11:00:00Z",
      url: "https://example.com/blog/big",
      media: [],
      source: { slug: "acme", name: "ACME", type: "scrape" },
    });
    expect(out).toEqual({
      id: "rel_b",
      title: "Big launch",
      version: null,
      publishedAt: "2026-04-23T11:00:00Z",
      source: { slug: "acme", name: "ACME" },
      url: "https://example.com/blog/big",
    });
  });
});
