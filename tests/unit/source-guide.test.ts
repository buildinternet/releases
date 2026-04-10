import { describe, it, expect } from "bun:test";
import {
  generateSourceGuideHeader,
  assembleSourceGuide,
  extractNotesFromLegacyGuide,
} from "../../src/ai/source-guide.js";
import type { Source } from "../../src/db/schema.js";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "src_1",
    name: "Test Source",
    slug: "test-source",
    type: "scrape",
    url: "https://example.com/changelog",
    orgId: "org_1",
    productId: null,
    metadata: "{}",
    isHidden: false,
    isPrimary: false,
    fetchPriority: "normal",
    lastFetchedAt: null,
    lastContentHash: null,
    consecutiveNoChange: 0,
    consecutiveErrors: 0,
    nextFetchAfter: null,
    changeDetectedAt: null,
    lastPolledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Source;
}

describe("generateSourceGuideHeader", () => {
  it("generates a basic header with one source", () => {
    const header = generateSourceGuideHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource()],
    });

    expect(header).toContain("# Acme — Source Guide");
    expect(header).toContain("**1** active source");
    expect(header).toContain("Test Source (`test-source`)");
    expect(header).toContain("https://example.com/changelog");
    expect(header).not.toContain("Agent Notes");
  });

  it("includes domain when provided", () => {
    const header = generateSourceGuideHeader({
      orgName: "Acme",
      orgSlug: "acme",
      domain: "acme.com",
      sources: [makeSource()],
    });

    expect(header).toContain("Primary domain: acme.com");
  });

  it("groups sources by product", () => {
    const header = generateSourceGuideHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [
        makeSource({ name: "CLI Changelog", slug: "cli", productId: "prod_1" }),
        makeSource({ name: "API Changelog", slug: "api", productId: "prod_2" }),
        makeSource({ name: "Blog", slug: "blog", productId: null }),
      ],
      products: [
        { id: "prod_1", name: "CLI", slug: "cli" },
        { id: "prod_2", name: "API", slug: "api" },
      ],
    });

    expect(header).toContain("Sources by Product");
    expect(header).toContain("### CLI (`cli`)");
    expect(header).toContain("### API (`api`)");
    expect(header).toContain("Organization-Level Sources");
    expect(header).toContain("Blog");
  });

  it("separates disabled sources", () => {
    const header = generateSourceGuideHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [
        makeSource({ name: "Active", slug: "active", isHidden: false }),
        makeSource({ name: "Disabled", slug: "disabled", isHidden: true }),
      ],
    });

    expect(header).toContain("## Active Sources");
    expect(header).toContain("## Disabled Sources");
    expect(header).toContain("1 disabled");
  });

  it("shows parseInstructions reminder when sources have them", () => {
    const header = generateSourceGuideHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ metadata: JSON.stringify({ parseInstructions: "Only extract new features" }) })],
    });

    expect(header).toContain("parseInstructions");
    expect(header).toContain("edit_source");
  });

  it("shows priority badge for non-normal priorities", () => {
    const header = generateSourceGuideHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ fetchPriority: "low" })],
    });

    expect(header).toContain("priority: low");
  });
});

describe("assembleSourceGuide", () => {
  it("appends notes to header", () => {
    const result = assembleSourceGuide("# Header\n\nContent", "- Some agent observation");

    expect(result).toContain("# Header");
    expect(result).toContain("## Agent Notes");
    expect(result).toContain("- Some agent observation");
  });

  it("shows placeholder when notes are null", () => {
    const result = assembleSourceGuide("# Header", null);

    expect(result).toContain("## Agent Notes");
    expect(result).toContain("_No agent notes yet");
  });

  it("shows placeholder when notes are empty/whitespace", () => {
    const result = assembleSourceGuide("# Header", "   ");

    expect(result).toContain("_No agent notes yet");
  });
});

describe("extractNotesFromLegacyGuide", () => {
  it("extracts notes from old-format guide with ## Notes heading", () => {
    const content = `# Acme — Source Guide

## Active Sources

Some source info

## Notes

- [2026-04-10] Some observation`;

    const notes = extractNotesFromLegacyGuide(content);
    expect(notes).toBe("- [2026-04-10] Some observation");
  });

  it("extracts notes from ## Agent Notes heading", () => {
    const content = `# Header

## Agent Notes

- Important finding
`;

    const notes = extractNotesFromLegacyGuide(content);
    expect(notes).toBe("- Important finding");
  });

  it("returns null when no notes section exists", () => {
    const content = `# Header\n\n## Active Sources\n\nStuff`;
    expect(extractNotesFromLegacyGuide(content)).toBeNull();
  });

  it("returns null when notes section has placeholder text", () => {
    const content = `# Header

## Notes

_No agent notes yet. Agents can append observations here._
`;

    expect(extractNotesFromLegacyGuide(content)).toBeNull();
  });
});
