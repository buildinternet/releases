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
    // Use separate sentences so each citation keeps a distinct anchor —
    // markers within one sentence cluster at the sentence end, which is
    // covered by the snap-to-sentence-end tests below.
    const content = "Alpha shipped. Then beta shipped. Then gamma shipped.";
    const out = applyCitationMarkers(
      content,
      [
        cite({ startIndex: 20, endIndex: 24, sourceUrl: "https://b.com" }), // "beta"
        cite({ startIndex: 0, endIndex: 5, sourceUrl: "https://a.com" }), // "Alpha"
        cite({ startIndex: 39, endIndex: 44, sourceUrl: "https://c.com" }), // "gamma"
      ],
      PAGE_ID,
    );
    // Each marker snaps to the end of its sentence.
    expect(out.content).toMatch(/Alpha shipped\.\[\^p1-1\]/);
    expect(out.content).toMatch(/beta shipped\.\[\^p1-2\]/);
    expect(out.content).toMatch(/gamma shipped\.\[\^p1-3\]/);
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

  describe("snap-to-sentence-end", () => {
    it("snaps a mid-word endIndex to the end of the enclosing sentence", () => {
      // Mirrors the real bug: a citation whose endIndex lands inside
      // "Distributed" should not split the word.
      const content = "Distributed tracing now spans Worker-to-Worker calls automatically.";
      const out = applyCitationMarkers(
        content,
        [cite({ startIndex: 0, endIndex: 4, sourceUrl: "https://a.com" })],
        PAGE_ID,
      );
      expect(out.content).toMatch(/automatically\.\[\^p1-1\]/);
      expect(out.content).not.toMatch(/Dist\[\^p1-1\]ributed/);
    });

    it("snaps a start-of-sentence endIndex forward past the sentence end", () => {
      // Marker at position 2 (right after the leading "\n\n") would otherwise
      // render at the *start* of the next paragraph as "[^1]Stream got...".
      const content = "Prev sentence.\n\nStream got a Workers binding.";
      const out = applyCitationMarkers(
        content,
        [cite({ startIndex: 16, endIndex: 16, sourceUrl: "https://a.com" })],
        PAGE_ID,
      );
      expect(out.content).toMatch(/Stream got a Workers binding\.\[\^p1-1\]/);
      expect(out.content).not.toMatch(/\n\[\^p1-1\]Stream/);
    });

    it("leaves an endIndex that is already at end of sentence untouched", () => {
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

    it("steps past closing markdown formatting after the terminator", () => {
      // The terminator is `binding.` but it's wrapped in **…**. Snapping
      // should land the marker *after* the closing `**`, not inside the
      // bold span.
      const content = "Lead-in **Stream got a Workers binding.** Then more.";
      const out = applyCitationMarkers(
        content,
        [cite({ startIndex: 11, endIndex: 17, sourceUrl: "https://a.com" })],
        PAGE_ID,
      );
      expect(out.content).toMatch(/\*\*Stream got a Workers binding\.\*\*\[\^p1-1\] Then more\./);
    });

    it("clusters multiple citations within one sentence at the sentence end", () => {
      // Three cites point at different phrases inside one sentence; all
      // three should land in a tight cluster at end-of-sentence.
      const content = "Alpha then beta then gamma.";
      const out = applyCitationMarkers(
        content,
        [
          cite({ startIndex: 0, endIndex: 5, sourceUrl: "https://a.com" }),
          cite({ startIndex: 11, endIndex: 15, sourceUrl: "https://b.com" }),
          cite({ startIndex: 21, endIndex: 26, sourceUrl: "https://c.com" }),
        ],
        PAGE_ID,
      );
      expect(out.content).toMatch(/gamma\.\[\^p1-1\]\[\^p1-2\]\[\^p1-3\]/);
    });

    it("does not skip past a sentence-internal decimal like v2.0", () => {
      // The `.` in `v2.0` is followed by a digit, so it isn't a real
      // terminator — snap must keep walking to the real period.
      const content = "We shipped v2.0 with major work last week.";
      const out = applyCitationMarkers(
        content,
        [cite({ startIndex: 3, endIndex: 10, sourceUrl: "https://a.com" })],
        PAGE_ID,
      );
      expect(out.content).toMatch(/last week\.\[\^p1-1\]/);
      expect(out.content).not.toMatch(/v2\.\[\^p1-1\]0/);
    });

    it("falls back to a line break when no sentence terminator exists before EOL", () => {
      // No period in the mid-document heading; the marker should snap to
      // the line break rather than skipping into the next paragraph.
      // Wrapped in an intro paragraph so the leading-heading strip doesn't
      // consume the heading we want to test against.
      const content = "Intro paragraph.\n\n## Mid heading without terminator\n\nNext.";
      const out = applyCitationMarkers(
        content,
        [cite({ startIndex: 21, endIndex: 28, sourceUrl: "https://a.com" })],
        PAGE_ID,
      );
      expect(out.content).toMatch(/## Mid heading without terminator\[\^p1-1\]\n/);
    });
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
