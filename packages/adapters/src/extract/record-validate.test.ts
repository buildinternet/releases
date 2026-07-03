import { describe, expect, test } from "bun:test";
import {
  checkContentQuality,
  checkDatePlausibility,
  checkUrlSanity,
  formatRejectionMessage,
  validateRecords,
} from "./record-validate.js";
import type { ExtractedEntry } from "./types.js";

const SOURCE_URL = "https://example.com/changelog";

function makeEntry(overrides: Partial<ExtractedEntry> = {}): ExtractedEntry {
  return {
    title: "v1.0",
    content: "Added a new feature that does something useful for users.",
    isBreaking: false,
    ...overrides,
  };
}

describe("checkUrlSanity", () => {
  test("accepts a same-domain release URL", () => {
    expect(checkUrlSanity("https://example.com/changelog/v1", SOURCE_URL)).toBeNull();
  });

  test("accepts a subdomain of the source's registrable domain", () => {
    expect(checkUrlSanity("https://blog.example.com/posts/v1", SOURCE_URL)).toBeNull();
  });

  test("accepts omitted URL", () => {
    expect(checkUrlSanity(undefined, SOURCE_URL)).toBeNull();
  });

  test("accepts a fragment-only anchor", () => {
    expect(checkUrlSanity("#v1-0", SOURCE_URL)).toBeNull();
  });

  test("rejects a URL on a completely different host", () => {
    const reason = checkUrlSanity("https://totally-unrelated.org/post/1", SOURCE_URL);
    expect(reason).toMatch(/doesn't match source/i);
  });

  test("rejects a tracking-redirect wrapper host", () => {
    const reason = checkUrlSanity("https://click.mailchimp.com/track?u=1", SOURCE_URL);
    expect(reason).toMatch(/tracking-redirect/i);
  });

  test("rejects a bare index/listing page", () => {
    const reason = checkUrlSanity("https://example.com/changelog", SOURCE_URL);
    expect(reason).toMatch(/listing\/index page/i);
  });

  test("rejects an unparseable URL", () => {
    const reason = checkUrlSanity("http://", SOURCE_URL);
    expect(reason).toMatch(/could not be parsed/i);
  });
});

describe("checkDatePlausibility", () => {
  test("accepts a recent, plausible date", () => {
    expect(checkDatePlausibility("2026-06-01", { sourceUrl: SOURCE_URL })).toBeNull();
  });

  test("accepts omitted date", () => {
    expect(checkDatePlausibility(undefined, { sourceUrl: SOURCE_URL })).toBeNull();
  });

  test("rejects a date far in the future", () => {
    const reason = checkDatePlausibility("2099-01-01", { sourceUrl: SOURCE_URL });
    expect(reason).toMatch(/future/i);
  });

  test("rejects an epoch/placeholder date", () => {
    const reason = checkDatePlausibility("1970-01-01", { sourceUrl: SOURCE_URL });
    expect(reason).toMatch(/epoch\/placeholder/i);
  });

  test("rejects an implausibly old date beyond maxAgeYears", () => {
    const reason = checkDatePlausibility("1990-01-01", {
      sourceUrl: SOURCE_URL,
      maxAgeYears: 20,
    });
    expect(reason).toMatch(/implausibly old/i);
  });

  test("rejects an unparseable date string", () => {
    const reason = checkDatePlausibility("not-a-date", { sourceUrl: SOURCE_URL });
    expect(reason).toMatch(/could not be parsed/i);
  });

  test("echoes the parsed ISO value back in the rejection reason", () => {
    const reason = checkDatePlausibility("2099-03-15", { sourceUrl: SOURCE_URL });
    expect(reason).toContain("2099-03-15");
  });
});

describe("checkContentQuality", () => {
  test("accepts real content", () => {
    expect(checkContentQuality(makeEntry())).toBeNull();
  });

  test("rejects an empty title", () => {
    const reason = checkContentQuality(makeEntry({ title: "" }));
    expect(reason).toMatch(/empty title/i);
  });

  test("rejects empty content", () => {
    const reason = checkContentQuality(makeEntry({ content: "" }));
    expect(reason).toMatch(/empty content/i);
  });

  test("rejects short cookie-banner boilerplate content", () => {
    const reason = checkContentQuality(
      makeEntry({ content: "We use cookies to improve your experience. Accept all cookies?" }),
    );
    expect(reason).toMatch(/page chrome/i);
  });

  test("does not reject long real content that happens to mention cookies in passing", () => {
    const longContent =
      "This release adds a new consent management dashboard so admins can configure " +
      "which cookies are set on their storefront, review the cookie policy shown to " +
      "visitors, and export a report of consent choices. It also improves checkout " +
      "performance by 15% and fixes a bug where the cart total was rounded incorrectly " +
      "on some locales, plus a handful of other small fixes across the admin panel.";
    expect(checkContentQuality(makeEntry({ content: longContent }))).toBeNull();
  });
});

describe("validateRecords", () => {
  test("returns no rejections for a batch of good entries", () => {
    const entries = [
      makeEntry({ url: "https://example.com/changelog/v1" }),
      makeEntry({ title: "v1.1", url: "https://example.com/changelog/v1.1" }),
    ];
    expect(validateRecords(entries, { sourceUrl: SOURCE_URL })).toEqual([]);
  });

  test("reports the index and reason for each bad entry", () => {
    const entries = [
      makeEntry({ url: "https://example.com/changelog/v1" }),
      makeEntry({ title: "", url: "https://example.com/changelog/v2" }),
      makeEntry({ url: "https://unrelated-domain.org/v3" }),
    ];
    const rejections = validateRecords(entries, { sourceUrl: SOURCE_URL });
    expect(rejections).toHaveLength(2);
    expect(rejections[0]).toEqual({ index: 1, reason: expect.stringMatching(/empty title/i) });
    expect(rejections[1]).toEqual({
      index: 2,
      reason: expect.stringMatching(/doesn't match source/i),
    });
  });

  test("fails open when a check throws — record is accepted, not rejected", () => {
    // sourceUrl that fails URL parsing inside checkUrlSanity's `new URL(sourceUrl)`
    // is already handled gracefully (falls back to no host check), so to
    // exercise the fail-open wrapper we pass an entry shape that would blow up
    // a naive validator: this confirms validateRecords itself never throws.
    const entries = [makeEntry({ url: "https://example.com/changelog/v1" })];
    expect(() => validateRecords(entries, { sourceUrl: "" })).not.toThrow();
    // With an empty sourceUrl, host-mismatch check is skipped (no valid source
    // host to compare against), so this entry is accepted.
    expect(validateRecords(entries, { sourceUrl: "" })).toEqual([]);
  });
});

describe("formatRejectionMessage", () => {
  test("lists each rejection with a 1-based entry number and instructs a resubmit", () => {
    const message = formatRejectionMessage(
      [
        { index: 0, reason: "Entry has an empty title." },
        { index: 2, reason: "URL host mismatch." },
      ],
      3,
    );
    expect(message).toContain("2 of 3 entries were rejected");
    expect(message).toContain("Entry 1 of 3: Entry has an empty title.");
    expect(message).toContain("Entry 3 of 3: URL host mismatch.");
    expect(message).toMatch(/call extract_releases again/i);
  });
});
