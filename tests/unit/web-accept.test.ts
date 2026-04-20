import { describe, expect, it } from "bun:test";
import { negotiate, parseAccept } from "../../web/src/lib/accept";

describe("parseAccept", () => {
  it("treats missing header as */*", () => {
    const ranges = parseAccept(null);
    expect(ranges).toEqual([{ type: "*", subtype: "*", q: 1, specificity: 1, order: 0 }]);
  });

  it("parses q-values", () => {
    const ranges = parseAccept("text/html;q=0.5, text/markdown;q=1.0");
    expect(ranges[0].q).toBe(0.5);
    expect(ranges[1].q).toBe(1);
  });

  it("defaults missing q to 1.0", () => {
    const ranges = parseAccept("text/markdown, text/html;q=0.9");
    expect(ranges[0].q).toBe(1);
    expect(ranges[1].q).toBe(0.9);
  });

  it("clamps q to [0, 1]", () => {
    const ranges = parseAccept("text/html;q=2.0, text/plain;q=-0.5");
    expect(ranges[0].q).toBe(1);
    expect(ranges[1].q).toBe(0);
  });

  it("scores specificity", () => {
    const ranges = parseAccept("*/*, text/*, text/markdown");
    expect(ranges[0].specificity).toBe(1);
    expect(ranges[1].specificity).toBe(2);
    expect(ranges[2].specificity).toBe(3);
  });

  it("ignores malformed media ranges", () => {
    const ranges = parseAccept("not-a-media-type, text/markdown");
    expect(ranges.length).toBe(1);
    expect(ranges[0].subtype).toBe("markdown");
  });
});

describe("negotiate", () => {
  const OFFERED = ["text/html", "text/markdown"] as const;

  it("returns first offered when no header present", () => {
    expect(negotiate(null, OFFERED)).toBe("text/html");
  });

  it("returns markdown for explicit markdown request", () => {
    expect(negotiate("text/markdown", OFFERED)).toBe("text/markdown");
  });

  it("returns markdown when markdown has higher q", () => {
    expect(negotiate("text/markdown, text/html;q=0.8", OFFERED)).toBe("text/markdown");
  });

  it("returns html when html has higher q", () => {
    expect(negotiate("text/markdown;q=0.1, text/html;q=0.9", OFFERED)).toBe("text/html");
  });

  it("returns html for browser-style Accept", () => {
    expect(
      negotiate(
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        OFFERED,
      ),
    ).toBe("text/html");
  });

  it("prefers more specific range over wildcard", () => {
    // text/markdown matches */* with q=0.5 but text/html matches exactly with q=1
    expect(negotiate("text/html, */*;q=0.5", OFFERED)).toBe("text/html");
  });

  it("returns null when only unsupported types accepted (406)", () => {
    expect(negotiate("application/json", OFFERED)).toBe(null);
    expect(negotiate("application/xml, image/png", OFFERED)).toBe(null);
  });

  it("returns null when every match has q=0", () => {
    expect(negotiate("text/html;q=0, text/markdown;q=0", OFFERED)).toBe(null);
  });

  it("honors */* wildcard", () => {
    expect(negotiate("*/*", OFFERED)).toBe("text/html");
  });

  it("honors type/* wildcard", () => {
    expect(negotiate("text/*", OFFERED)).toBe("text/html");
  });

  it("picks markdown when only markdown is offered and html-only client", () => {
    expect(negotiate("text/html", ["text/markdown"] as const)).toBe(null);
  });

  it("handles q with quoted value", () => {
    expect(negotiate('text/markdown;q="0.9", text/html;q="1.0"', OFFERED)).toBe("text/html");
  });

  it("breaks q-ties by offered order", () => {
    expect(negotiate("text/html, text/markdown", OFFERED)).toBe("text/html");
  });
});
