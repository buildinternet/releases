import { describe, it, expect } from "bun:test";
import {
  generatePlaybookHeader,
  assemblePlaybook,
  extractNotesFromLegacyPlaybook,
} from "../../src/ai/playbook.js";
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

describe("generatePlaybookHeader", () => {
  it("generates a basic header with one source as a table", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource()],
    });

    expect(header).toContain("# Acme — Playbook");
    expect(header).toContain("**1** active source");
    // Table format: name, ID, type, URL columns
    expect(header).toContain("Test Source");
    expect(header).toContain("`src_1`");
    expect(header).toContain("https://example.com/changelog");
    expect(header).toContain("| Name |");
    expect(header).not.toContain("Agent Notes");
  });

  it("includes domain in summary line", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      domain: "acme.com",
      sources: [makeSource()],
    });

    expect(header).toContain("domain: acme.com");
  });

  it("shows product column when products exist", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [
        makeSource({ id: "src_1", name: "CLI Changelog", slug: "cli", productId: "prod_1" }),
        makeSource({ id: "src_2", name: "API Changelog", slug: "api", productId: "prod_2" }),
        makeSource({ id: "src_3", name: "Blog", slug: "blog", productId: null }),
      ],
      products: [
        { id: "prod_1", name: "CLI", slug: "cli" },
        { id: "prod_2", name: "API", slug: "api" },
      ],
    });

    expect(header).toContain("| Product |");
    expect(header).toContain("| CLI |");
    expect(header).toContain("| API |");
    // Unassigned source shows dash
    expect(header).toContain("| — |");
  });

  it("separates disabled sources with strikethrough and ID", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [
        makeSource({ id: "src_1", name: "Active", slug: "active", isHidden: false }),
        makeSource({ id: "src_2", name: "Disabled", slug: "disabled", isHidden: true }),
      ],
    });

    expect(header).toContain("## Sources");
    expect(header).toContain("## Disabled");
    expect(header).toContain("~~Disabled~~");
    expect(header).toContain("`src_2`");
    expect(header).toContain("1 disabled");
  });

  it("shows parseInstructions in a separate section", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ metadata: JSON.stringify({ parseInstructions: "Only extract new features" }) })],
    });

    expect(header).toContain("## Parse Instructions");
    expect(header).toContain("Only extract new features");
    expect(header).toContain("edit_source");
  });

  it("shows priority in type column for non-normal priorities", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ fetchPriority: "low" })],
    });

    expect(header).toContain("scrape · low");
  });

  it("includes source ID in table", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ id: "src_abc123" })],
    });

    expect(header).toContain("`src_abc123`");
  });

  it("includes URL as plain text in table", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ url: "https://example.com/changelog" })],
    });

    // URL should appear as plain text, not as a markdown link
    expect(header).toContain("https://example.com/changelog");
    expect(header).not.toContain("[test-source](");
  });

  it("formats last fetched as short date", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ lastFetchedAt: "2026-04-11T17:00:00.000Z" })],
    });

    expect(header).toContain("Apr 11");
  });

  it("shows 'never' when not fetched", () => {
    const header = generatePlaybookHeader({
      orgName: "Acme",
      orgSlug: "acme",
      sources: [makeSource({ lastFetchedAt: null })],
    });

    expect(header).toContain("never");
  });
});

describe("assemblePlaybook", () => {
  it("appends notes to header", () => {
    const result = assemblePlaybook("# Header\n\nContent", "- Some agent observation");

    expect(result).toContain("# Header");
    expect(result).toContain("## Agent Notes");
    expect(result).toContain("- Some agent observation");
  });

  it("shows placeholder when notes are null", () => {
    const result = assemblePlaybook("# Header", null);

    expect(result).toContain("## Agent Notes");
    expect(result).toContain("_No agent notes yet");
  });

  it("shows placeholder when notes are empty/whitespace", () => {
    const result = assemblePlaybook("# Header", "   ");

    expect(result).toContain("_No agent notes yet");
  });
});

describe("extractNotesFromLegacyPlaybook", () => {
  it("extracts notes from old-format playbook with ## Notes heading", () => {
    const content = `# Acme — Source Guide

## Active Sources

Some source info

## Notes

- [2026-04-10] Some observation`;

    const notes = extractNotesFromLegacyPlaybook(content);
    expect(notes).toBe("- [2026-04-10] Some observation");
  });

  it("extracts notes from ## Agent Notes heading", () => {
    const content = `# Header

## Agent Notes

- Important finding
`;

    const notes = extractNotesFromLegacyPlaybook(content);
    expect(notes).toBe("- Important finding");
  });

  it("returns null when no notes section exists", () => {
    const content = `# Header\n\n## Active Sources\n\nStuff`;
    expect(extractNotesFromLegacyPlaybook(content)).toBeNull();
  });

  it("returns null when notes section has placeholder text", () => {
    const content = `# Header

## Notes

_No agent notes yet. Agents can append observations here._
`;

    expect(extractNotesFromLegacyPlaybook(content)).toBeNull();
  });
});
