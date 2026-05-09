import { describe, it, expect } from "bun:test";
import { applyCitationMarkers } from "../../web/src/lib/overview-citations";
import type { OverviewCitation } from "@buildinternet/releases-api-types";

const PAGE_ID = "p1";

function cite(
  partial: Partial<OverviewCitation> & Pick<OverviewCitation, "startIndex" | "endIndex">,
): OverviewCitation {
  return {
    sourceUrl: "https://acme.com/post",
    title: null,
    citedText: "stub",
    ...partial,
  };
}

describe("applyCitationMarkers", () => {
  it("returns content unchanged when no citations are provided", () => {
    const out = applyCitationMarkers("Body text.", undefined, PAGE_ID);
    expect(out.content).toBe("Body text.");
    expect(out.rendered).toEqual([]);
  });

  it("returns content unchanged when citations is an empty array", () => {
    const out = applyCitationMarkers("Body text.", [], PAGE_ID);
    expect(out.content).toBe("Body text.");
  });

  it("strips a leading heading when no citations are present", () => {
    const out = applyCitationMarkers("# Acme\n\nHello.", [], PAGE_ID);
    expect(out.content).toBe("Hello.");
  });

  it("inserts a footnote marker at endIndex and appends a definition", () => {
    const content = "Acme shipped v2.";
    const out = applyCitationMarkers(
      content,
      [cite({ startIndex: 0, endIndex: 16, title: "v2 launch", sourceUrl: "https://acme.com/v2" })],
      PAGE_ID,
    );
    expect(out.content).toContain("Acme shipped v2.[^p1-1]");
    expect(out.content).toContain("[^p1-1]: [v2 launch](https://acme.com/v2)");
    expect(out.rendered).toHaveLength(1);
    expect(out.rendered[0]?.number).toBe(1);
  });

  it("numbers citations left-to-right by startIndex", () => {
    const content = "Alpha then beta then gamma.";
    const out = applyCitationMarkers(
      content,
      [
        cite({ startIndex: 11, endIndex: 15, sourceUrl: "https://b.com" }),
        cite({ startIndex: 0, endIndex: 5, sourceUrl: "https://a.com" }),
        cite({ startIndex: 21, endIndex: 26, sourceUrl: "https://c.com" }),
      ],
      PAGE_ID,
    );
    // [^p1-1] should follow "Alpha"
    expect(out.content).toMatch(/Alpha\[\^p1-1\]/);
    expect(out.content).toMatch(/beta\[\^p1-2\]/);
    expect(out.content).toMatch(/gamma\[\^p1-3\]/);
    // Definitions appear in display order
    const defs = out.content.split("\n").filter((l) => l.startsWith("[^"));
    expect(defs[0]).toContain("https://a.com");
    expect(defs[1]).toContain("https://b.com");
    expect(defs[2]).toContain("https://c.com");
  });

  it("handles overlapping markers without corrupting offsets (back-to-front insertion)", () => {
    // Two citations on adjacent spans — inserting from end keeps the earlier
    // offset valid.
    const content = "Acme shipped v2. Also v3 dropped.";
    const out = applyCitationMarkers(
      content,
      [
        cite({ startIndex: 0, endIndex: 16, sourceUrl: "https://a.com/v2" }),
        cite({ startIndex: 17, endIndex: 33, sourceUrl: "https://a.com/v3" }),
      ],
      PAGE_ID,
    );
    expect(out.content).toMatch(/Acme shipped v2\.\[\^p1-1\] Also v3 dropped\.\[\^p1-2\]/);
  });

  it("shifts and clamps offsets when a leading heading is stripped", () => {
    // Heading + body. Citation #1 falls inside the heading region (drop),
    // #2 starts inside heading and ends in body (clamp start to 0), #3 lives
    // entirely in body (shift only).
    const heading = "# Acme Inc\n\n"; // 12 chars
    const body = "Acme shipped v2 with major work."; // citation 16-32 in body
    const raw = heading + body;
    const out = applyCitationMarkers(
      raw,
      [
        cite({ startIndex: 2, endIndex: 6, sourceUrl: "https://a.com/x" }), // inside heading → drop
        cite({ startIndex: 8, endIndex: 16, sourceUrl: "https://a.com/y" }), // straddles → clamp
        cite({ startIndex: 28, endIndex: 44, sourceUrl: "https://a.com/z" }), // body → shift
      ],
      PAGE_ID,
    );
    // The dropped citation should not appear.
    expect(out.content).not.toContain("a.com/x");
    // Two surviving citations rendered in order.
    expect(out.rendered).toHaveLength(2);
    expect(out.content).toContain("a.com/y");
    expect(out.content).toContain("a.com/z");
    // Heading was stripped.
    expect(out.content.startsWith("# Acme")).toBe(false);
  });

  it("drops every citation cleanly when all spans fall inside the stripped heading", () => {
    // Heading is 12 chars; both citations sit entirely inside it. After the
    // clamp, numbered is empty — no markers, no Sources footer, no dangling
    // blank lines.
    const heading = "# Acme Inc\n\n";
    const body = "Body text without citations.";
    const out = applyCitationMarkers(
      heading + body,
      [
        cite({ startIndex: 2, endIndex: 6, sourceUrl: "https://a.com/x" }),
        cite({ startIndex: 7, endIndex: 11, sourceUrl: "https://a.com/y" }),
      ],
      PAGE_ID,
    );
    expect(out.rendered).toEqual([]);
    expect(out.content).toBe(body);
    expect(out.content).not.toContain("a.com/x");
    expect(out.content).not.toContain("a.com/y");
    expect(out.content).not.toContain("[^");
  });

  it("falls back to a hostname-shaped label when title is missing", () => {
    const out = applyCitationMarkers(
      "Hi.",
      [
        cite({
          startIndex: 0,
          endIndex: 3,
          title: null,
          sourceUrl: "https://acme.com/blog/post-2",
        }),
      ],
      PAGE_ID,
    );
    expect(out.content).toContain("[acme.com/blog/post-2](https://acme.com/blog/post-2)");
  });

  it("falls back to the raw URL string when sourceUrl is not a valid URL", () => {
    const out = applyCitationMarkers(
      "Hi.",
      [cite({ startIndex: 0, endIndex: 3, title: null, sourceUrl: "not-a-url" })],
      PAGE_ID,
    );
    expect(out.content).toContain("[not-a-url](not-a-url)");
  });

  it("scopes footnote labels per pageId so two overviews don't collide", () => {
    const a = applyCitationMarkers(
      "X.",
      [cite({ startIndex: 0, endIndex: 2, sourceUrl: "https://a.com" })],
      "page-A",
    );
    const b = applyCitationMarkers(
      "Y.",
      [cite({ startIndex: 0, endIndex: 2, sourceUrl: "https://b.com" })],
      "page-B",
    );
    expect(a.content).toContain("[^page-A-1]");
    expect(b.content).toContain("[^page-B-1]");
  });
});
