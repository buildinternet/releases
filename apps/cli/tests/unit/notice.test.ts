import { describe, it, expect, spyOn } from "bun:test";
import {
  isAbsoluteUrl,
  validateCoordinate,
  buildNoticePatch,
  formatNotice,
  NOTICE_MESSAGE_MAX,
  NOTICE_LINK_TEXT_MAX,
  NOTICE_HREF_MAX,
  type Notice,
} from "../../src/lib/notice.js";

// Intercept process.exit so invalid-input tests don't kill the runner.
function withExitTrap(fn: () => void): void {
  const spy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

const noopLogger = { error: (_msg: string) => {} };

// ── isAbsoluteUrl ─────────────────────────────────────────────────────────────

describe("isAbsoluteUrl", () => {
  it("returns true for https:// URLs", () => {
    expect(isAbsoluteUrl("https://example.com/post")).toBe(true);
  });

  it("returns true for http:// URLs", () => {
    expect(isAbsoluteUrl("http://example.com")).toBe(true);
  });

  it("returns false for registry coordinates", () => {
    expect(isAbsoluteUrl("cognition/devin")).toBe(false);
    expect(isAbsoluteUrl("cognition")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isAbsoluteUrl("")).toBe(false);
  });
});

// ── validateCoordinate ────────────────────────────────────────────────────────

describe("validateCoordinate", () => {
  it("accepts a bare org slug", () => {
    expect(validateCoordinate("cognition")).toBeNull();
    expect(validateCoordinate("my-org")).toBeNull();
    expect(validateCoordinate("org_slug.v2")).toBeNull();
  });

  it("accepts a two-segment org/product coordinate", () => {
    expect(validateCoordinate("cognition/devin")).toBeNull();
    expect(validateCoordinate("vercel/next-js")).toBeNull();
  });

  it("rejects a URL with a scheme", () => {
    const result = validateCoordinate("https://example.com");
    expect(result).not.toBeNull();
    expect(result).toContain("URL");
  });

  it("rejects more than two segments", () => {
    const result = validateCoordinate("a/b/c");
    expect(result).not.toBeNull();
    expect(result).toContain("1–2");
  });

  it("rejects leading slash", () => {
    const result = validateCoordinate("/cognition");
    expect(result).not.toBeNull();
  });

  it("rejects trailing slash", () => {
    const result = validateCoordinate("cognition/");
    expect(result).not.toBeNull();
  });

  it("rejects doubled slash", () => {
    const result = validateCoordinate("a//b");
    expect(result).not.toBeNull();
  });

  it("rejects segments with special characters", () => {
    const result = validateCoordinate("cognition devin");
    expect(result).not.toBeNull();
  });

  it("rejects a segment with a colon", () => {
    const result = validateCoordinate("cog:nition");
    expect(result).not.toBeNull();
  });
});

// ── buildNoticePatch ──────────────────────────────────────────────────────────

describe("buildNoticePatch", () => {
  it("returns null when no notice flags are provided", () => {
    expect(buildNoticePatch({}, noopLogger)).toBeNull();
  });

  it("returns { notice: null } when --clear-notice is set", () => {
    expect(buildNoticePatch({ clearNotice: true }, noopLogger)).toEqual({ notice: null });
  });

  it("rejects --clear-notice combined with --notice", () => {
    withExitTrap(() => {
      expect(() => buildNoticePatch({ clearNotice: true, notice: "hello" }, noopLogger)).toThrow(
        "process.exit called",
      );
    });
  });

  it("builds a minimal notice with message only", () => {
    const result = buildNoticePatch({ notice: "Hello world" }, noopLogger);
    expect(result).toEqual({ notice: { message: "Hello world" } });
  });

  it("routes a https:// link to the href field", () => {
    const result = buildNoticePatch(
      { notice: "See the new home", noticeLink: "https://example.com/new" },
      noopLogger,
    );
    expect(result).toEqual({
      notice: { message: "See the new home", href: "https://example.com/new" },
    });
  });

  it("routes a coordinate to the coordinate field", () => {
    const result = buildNoticePatch(
      { notice: "Moved to Cognition", noticeLink: "cognition/devin" },
      noopLogger,
    );
    expect(result).toEqual({
      notice: { message: "Moved to Cognition", coordinate: "cognition/devin" },
    });
  });

  it("includes linkText when provided", () => {
    const result = buildNoticePatch(
      {
        notice: "See Devin",
        noticeLink: "cognition/devin",
        noticeLinkText: "Cognition Devin",
      },
      noopLogger,
    );
    expect(result).toEqual({
      notice: {
        message: "See Devin",
        coordinate: "cognition/devin",
        linkText: "Cognition Devin",
      },
    });
  });

  it("rejects a message that exceeds NOTICE_MESSAGE_MAX", () => {
    withExitTrap(() => {
      const longMsg = "a".repeat(NOTICE_MESSAGE_MAX + 1);
      expect(() => buildNoticePatch({ notice: longMsg }, noopLogger)).toThrow(
        "process.exit called",
      );
    });
  });

  it("accepts a message at exactly NOTICE_MESSAGE_MAX", () => {
    const exactMsg = "a".repeat(NOTICE_MESSAGE_MAX);
    const result = buildNoticePatch({ notice: exactMsg }, noopLogger);
    expect(result?.notice).not.toBeNull();
  });

  it("rejects a linkText that exceeds NOTICE_LINK_TEXT_MAX", () => {
    withExitTrap(() => {
      const longText = "x".repeat(NOTICE_LINK_TEXT_MAX + 1);
      expect(() =>
        buildNoticePatch({ notice: "msg", noticeLinkText: longText }, noopLogger),
      ).toThrow("process.exit called");
    });
  });

  it("rejects a href that exceeds NOTICE_HREF_MAX", () => {
    withExitTrap(() => {
      const longHref = "https://example.com/" + "a".repeat(NOTICE_HREF_MAX);
      expect(() => buildNoticePatch({ notice: "msg", noticeLink: longHref }, noopLogger)).toThrow(
        "process.exit called",
      );
    });
  });

  it("rejects an invalid coordinate in noticeLink", () => {
    withExitTrap(() => {
      expect(() => buildNoticePatch({ notice: "msg", noticeLink: "a/b/c" }, noopLogger)).toThrow(
        "process.exit called",
      );
    });
  });
});

// ── formatNotice ──────────────────────────────────────────────────────────────

describe("formatNotice", () => {
  it("formats a message-only notice", () => {
    const notice: Notice = { message: "This product has moved" };
    expect(formatNotice(notice)).toBe("Notice: This product has moved");
  });

  it("appends a coordinate pointer with →", () => {
    const notice: Notice = { message: "Moved to Cognition", coordinate: "cognition/devin" };
    expect(formatNotice(notice)).toBe("Notice: Moved to Cognition → cognition/devin");
  });

  it("appends an href pointer with →", () => {
    const notice: Notice = { message: "See announcement", href: "https://example.com/post" };
    expect(formatNotice(notice)).toBe("Notice: See announcement → https://example.com/post");
  });

  it("prefers coordinate over href when both are present (coordinate wins)", () => {
    const notice: Notice = {
      message: "Multi-pointer",
      coordinate: "org/slug",
      href: "https://example.com",
    };
    // coordinate is checked first in the formatter
    expect(formatNotice(notice)).toBe("Notice: Multi-pointer → org/slug");
  });

  it("ignores linkText in the text rendering (linkText is for web/MCP)", () => {
    const notice: Notice = {
      message: "Moved",
      linkText: "Click here",
      coordinate: "org/slug",
    };
    expect(formatNotice(notice)).toBe("Notice: Moved → org/slug");
  });
});
