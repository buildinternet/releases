import { describe, expect, test } from "bun:test";
import { sourceLastActivityAt } from "./source-last-activity";

const POLLED = "2026-08-01T00:00:00.000Z";
const FETCHED = "2026-10-08T12:00:00.000Z";
const LATEST = "2026-10-05T00:00:00.000Z";

describe("sourceLastActivityAt", () => {
  test("poll-fed: last poll wins, falling back to last fetch", () => {
    const source = { lastPolledAt: POLLED, lastFetchedAt: FETCHED, latestDate: LATEST };
    expect(sourceLastActivityAt(source, false)).toBe(POLLED);
    expect(sourceLastActivityAt({ ...source, lastPolledAt: null }, false)).toBe(FETCHED);
  });

  test("push-fed: ignores a frozen lastPolledAt and shows the last publish", () => {
    const source = { lastPolledAt: POLLED, lastFetchedAt: FETCHED, latestDate: LATEST };
    expect(sourceLastActivityAt(source, true)).toBe(FETCHED);
  });

  test("push-fed: a newer release date beats a stale lastFetchedAt", () => {
    const source = { lastPolledAt: POLLED, lastFetchedAt: POLLED, latestDate: LATEST };
    expect(sourceLastActivityAt(source, true)).toBe(LATEST);
  });

  test("push-fed: falls back to whichever timestamp exists", () => {
    expect(
      sourceLastActivityAt({ lastPolledAt: POLLED, lastFetchedAt: null, latestDate: LATEST }, true),
    ).toBe(LATEST);
    expect(
      sourceLastActivityAt({ lastPolledAt: POLLED, lastFetchedAt: null, latestDate: null }, true),
    ).toBeNull();
  });
});
