import { describe, expect, it } from "bun:test";
import {
  HERO_MAX_BYTES,
  HERO_MIN_BYTES,
  SMALL_MEDIA_MARKERS,
  clamp,
  formatCount,
  formatDate,
  isHeroImageResponse,
  isJunkMediaUrl,
  stripMarkdown,
} from "../../web/src/lib/og-helpers";

describe("clamp", () => {
  it("returns input unchanged when under the limit", () => {
    expect(clamp("hello", 10)).toBe("hello");
  });

  it("trims to max and appends ellipsis when over", () => {
    expect(clamp("abcdefghij", 6)).toBe("abcde…");
  });

  it("trims whitespace before the ellipsis", () => {
    expect(clamp("hello     world", 7)).toBe("hello…");
  });

  it("strips surrounding whitespace first", () => {
    expect(clamp("  hi  ", 10)).toBe("hi");
  });
});

describe("stripMarkdown", () => {
  it("returns empty string for nullish input", () => {
    expect(stripMarkdown(null)).toBe("");
    expect(stripMarkdown(undefined)).toBe("");
    expect(stripMarkdown("")).toBe("");
  });

  it("removes fenced code blocks", () => {
    expect(stripMarkdown("hello ```js\nconst x = 1;\n``` world")).toBe("hello world");
  });

  it("unwraps inline code spans to their contents", () => {
    expect(stripMarkdown("use `npm install` then run")).toBe("use npm install then run");
  });

  it("keeps identifiers inside code spans intact", () => {
    expect(stripMarkdown("verdicts (`none`/`minor`/`major`) via `whats_changed`")).toBe(
      "verdicts (none/minor/major) via whats_changed",
    );
  });

  it("keeps link text but drops the URL", () => {
    expect(stripMarkdown("see [the docs](https://example.com) for more")).toBe(
      "see the docs for more",
    );
  });

  it("removes image markdown entirely", () => {
    expect(stripMarkdown("before ![alt](img.png) after")).toBe("before after");
  });

  it("strips emphasis markers", () => {
    expect(stripMarkdown("**bold** ~strike~")).toBe("bold strike");
  });

  it("strips heading and blockquote markers at the start of a line", () => {
    expect(stripMarkdown("# Heading\n> quoted")).toBe("Heading quoted");
  });

  it("leaves mid-line '>' alone so code and arrows survive", () => {
    expect(stripMarkdown("call `() => x` when a > b")).toBe("call () => x when a > b");
  });

  it("collapses whitespace runs", () => {
    expect(stripMarkdown("a   b\n\nc\t\td")).toBe("a b c d");
  });
});

describe("formatCount", () => {
  it("returns '0' for nullish input", () => {
    expect(formatCount(null)).toBe("0");
    expect(formatCount(undefined)).toBe("0");
  });

  it("returns plain string for small numbers", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(42)).toBe("42");
    expect(formatCount(999)).toBe("999");
  });

  it("formats thousands with one decimal", () => {
    expect(formatCount(1000)).toBe("1.0k");
    expect(formatCount(1500)).toBe("1.5k");
    expect(formatCount(9999)).toBe("10.0k");
  });

  it("drops the decimal past 10k", () => {
    expect(formatCount(10_000)).toBe("10k");
    expect(formatCount(42_500)).toBe("43k");
    expect(formatCount(1_500_000)).toBe("1500k");
  });
});

describe("formatDate", () => {
  it("returns null for nullish input", () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
    expect(formatDate("")).toBeNull();
  });

  it("returns null for invalid dates", () => {
    expect(formatDate("not-a-date")).toBeNull();
  });

  it("formats ISO dates in UTC regardless of local timezone", () => {
    expect(formatDate("2026-04-16T00:00:00.000Z")).toBe("Apr 16, 2026");
    expect(formatDate("2026-04-16T23:59:59.999Z")).toBe("Apr 16, 2026");
    expect(formatDate("2026-01-01T00:00:00.000Z")).toBe("Jan 1, 2026");
  });
});

describe("isJunkMediaUrl", () => {
  it("rejects Vercel/Contentful small-image transforms", () => {
    expect(
      isJunkMediaUrl(
        "https://assets.vercel.com/image/upload/f_auto,c_fill,w_44,h_44,q_75/contentful/image/foo.png",
      ),
    ).toBe(true);
  });

  it("rejects generic avatar paths", () => {
    expect(isJunkMediaUrl("https://example.com/avatar/user.png")).toBe(true);
  });

  it("rejects known tiny-size GitHub-style query params", () => {
    expect(isJunkMediaUrl("https://example.com/x.png?s=44")).toBe(true);
    expect(isJunkMediaUrl("https://example.com/x.png?v=1&s=48")).toBe(true);
  });

  it("accepts full-size media URLs", () => {
    expect(isJunkMediaUrl("https://media.releases.sh/sources/vercel/e8e2541d89c3a4cf.png")).toBe(
      false,
    );
    expect(
      isJunkMediaUrl("https://assets.vercel.com/image/upload/contentful/image/flags-ga-light.png"),
    ).toBe(false);
  });

  it("treats missing URLs as non-junk (caller handles absence)", () => {
    expect(isJunkMediaUrl(null)).toBe(false);
    expect(isJunkMediaUrl(undefined)).toBe(false);
    expect(isJunkMediaUrl("")).toBe(false);
  });

  it("enumerates expected markers", () => {
    expect(SMALL_MEDIA_MARKERS).toContain("c_fill,w_44");
    expect(SMALL_MEDIA_MARKERS).toContain("/avatar/");
  });
});

describe("isHeroImageResponse", () => {
  const validSize = (HERO_MIN_BYTES + HERO_MAX_BYTES) / 2;

  it("accepts supported image mime types within size bounds", () => {
    expect(isHeroImageResponse("image/png", validSize)).toBe(true);
    expect(isHeroImageResponse("image/jpeg", validSize)).toBe(true);
    expect(isHeroImageResponse("image/jpg", validSize)).toBe(true);
    expect(isHeroImageResponse("image/webp", validSize)).toBe(true);
  });

  it("is case-insensitive on content-type and tolerates a charset suffix", () => {
    expect(isHeroImageResponse("IMAGE/PNG", validSize)).toBe(true);
    expect(isHeroImageResponse("image/png; charset=binary", validSize)).toBe(true);
  });

  it("rejects non-image and unsupported image types", () => {
    expect(isHeroImageResponse("text/html", validSize)).toBe(false);
    expect(isHeroImageResponse("image/gif", validSize)).toBe(false);
    expect(isHeroImageResponse("image/svg+xml", validSize)).toBe(false);
    expect(isHeroImageResponse("", validSize)).toBe(false);
  });

  it("rejects images below the minimum size", () => {
    expect(isHeroImageResponse("image/png", HERO_MIN_BYTES - 1)).toBe(false);
    expect(isHeroImageResponse("image/png", 0)).toBe(false);
  });

  it("rejects images above the maximum size", () => {
    expect(isHeroImageResponse("image/png", HERO_MAX_BYTES + 1)).toBe(false);
  });

  it("accepts images exactly at the min/max bounds", () => {
    expect(isHeroImageResponse("image/png", HERO_MIN_BYTES)).toBe(true);
    expect(isHeroImageResponse("image/png", HERO_MAX_BYTES)).toBe(true);
  });
});
