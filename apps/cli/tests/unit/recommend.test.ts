import { describe, it, expect } from "bun:test";
import {
  validateUrl,
  buildRecommendationPayload,
  submitErrorMessage,
  buildNotifyAddedBody,
} from "../../src/cli/commands/recommend.js";
import { InvalidInputError } from "../../src/lib/errors.js";

describe("validateUrl", () => {
  it("rejects an empty url", () => {
    const r = validateUrl("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("url");
  });

  it("rejects a non-http(s) scheme", () => {
    const r = validateUrl("ftp://example.com/releases");
    expect(r.ok).toBe(false);
  });

  it("rejects a string that is not a url", () => {
    expect(validateUrl("not a url at all").ok).toBe(false);
  });

  it("accepts a full https url", () => {
    expect(validateUrl("https://example.com/releases")).toEqual({
      ok: true,
      url: "https://example.com/releases",
    });
  });

  it("adds https:// when the scheme is omitted", () => {
    const r = validateUrl("example.com/changelog");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://example.com/changelog");
  });

  it("rejects a url longer than 2048 chars", () => {
    const r = validateUrl("https://example.com/" + "a".repeat(2100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("long");
  });
});

describe("buildRecommendationPayload", () => {
  it("builds a source recommendation with the cli surface", () => {
    const p = buildRecommendationPayload("https://example.com/releases", {});
    expect(p.type).toBe("source");
    expect(p.url).toBe("https://example.com/releases");
    expect(p.surface).toBe("cli");
    expect(p.note).toBeUndefined();
    expect(p.contactEmail).toBeUndefined();
  });

  it("includes trimmed note and contact when provided", () => {
    const p = buildRecommendationPayload("https://example.com/releases", {
      note: "  GitHub: acme/acme  ",
      contact: "  me@x.com  ",
    });
    expect(p.note).toBe("GitHub: acme/acme");
    expect(p.contactEmail).toBe("me@x.com");
  });

  it("omits blank note and contact rather than sending empty strings", () => {
    const p = buildRecommendationPayload("https://example.com/releases", {
      note: "   ",
      contact: "",
    });
    expect(p.note).toBeUndefined();
    expect(p.contactEmail).toBeUndefined();
  });
});

describe("submitErrorMessage", () => {
  it("maps each known API error code to an operator-friendly message", () => {
    expect(submitErrorMessage("url_required", 400)).toContain("URL");
    expect(submitErrorMessage("invalid_email", 400).toLowerCase()).toContain("email");
    expect(submitErrorMessage("rate_limited", 429).toLowerCase()).toContain("too many");
    expect(submitErrorMessage("recommendations_disabled", 503).toLowerCase()).toContain("disabled");
    expect(submitErrorMessage("payload_too_large", 413).toLowerCase()).toContain("too large");
  });

  it("falls back to the raw status for an unknown code", () => {
    expect(submitErrorMessage("something_new", 500)).toBe("server returned 500");
    expect(submitErrorMessage(undefined, 502)).toBe("server returned 502");
  });
});

describe("buildNotifyAddedBody", () => {
  it("requires a trimmed org slug and omits a blank source", () => {
    expect(buildNotifyAddedBody("  acme  ")).toEqual({ orgSlug: "acme" });
    expect(buildNotifyAddedBody("acme", "   ")).toEqual({ orgSlug: "acme" });
  });

  it("includes a trimmed source slug when provided", () => {
    expect(buildNotifyAddedBody("acme", "  changelog  ")).toEqual({
      orgSlug: "acme",
      sourceSlug: "changelog",
    });
  });

  it("rejects a dirty org or source identifier", () => {
    expect(() => buildNotifyAddedBody("acme?x")).toThrow(InvalidInputError);
    expect(() => buildNotifyAddedBody("acme", "src_../x")).toThrow(InvalidInputError);
  });
});
