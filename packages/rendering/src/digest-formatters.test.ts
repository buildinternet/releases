import { describe, expect, it } from "bun:test";
import { collectionDigestIndexToMarkdown, collectionDigestToMarkdown } from "./formatters.js";
import { collectionDigestsToAtom } from "./atom.js";
import type {
  CollectionWeeklyDigestDetail,
  CollectionWeeklyDigestListItem,
} from "@buildinternet/releases-api-types";

const BASE = "https://releases.sh";
const COLLECTION = { slug: "frontier-ai-labs", name: "Frontier AI Labs" };

function listItem(
  over: Partial<CollectionWeeklyDigestListItem> = {},
): CollectionWeeklyDigestListItem {
  return {
    id: "dig_1",
    weekStart: "2026-07-06",
    title: "Agents take the stage",
    intro: "A week of agent runtimes and tooling.",
    releaseCount: 12,
    generatedAt: "2026-07-13T14:00:00.000Z",
    ...over,
  };
}

function detail(over: Partial<CollectionWeeklyDigestDetail> = {}): CollectionWeeklyDigestDetail {
  return {
    id: "dig_1",
    weekStart: "2026-07-06",
    title: "Agents take the stage",
    intro: "A week of agent runtimes and tooling.",
    body: "### OpenAI\n\nShipped the Responses API.",
    releaseIds: ["rel_a", "rel_b"],
    releaseCount: 2,
    generatedAt: "2026-07-13T14:00:00.000Z",
    releases: [
      {
        id: "rel_a",
        title: "Responses API",
        path: "/release/rel_a-responses-api",
        org: { slug: "openai", name: "OpenAI" },
      },
      {
        id: "rel_b",
        title: "Claude Code update",
        path: "/release/rel_b-claude-code",
        org: { slug: "anthropic", name: "Anthropic" },
      },
    ],
    ...over,
  };
}

describe("collectionDigestIndexToMarkdown", () => {
  it("renders yaml frontmatter and a newest-first list", () => {
    const md = collectionDigestIndexToMarkdown(
      COLLECTION,
      [listItem(), listItem({ id: "dig_0", weekStart: "2026-06-29", title: "Earlier week" })],
      { baseUrl: BASE },
    );
    expect(md).toInclude("collection: frontier-ai-labs");
    expect(md).toInclude("digest_count: 2");
    expect(md).toInclude("# Frontier AI Labs weekly digests");
    expect(md).toInclude(
      `[Agents take the stage](${BASE}/collections/frontier-ai-labs/digest/2026-07-06)`,
    );
    expect(md).toInclude(
      `- Digest Atom feed: \`${BASE}/collections/frontier-ai-labs/digest.atom\``,
    );
  });

  it("handles an empty list", () => {
    const md = collectionDigestIndexToMarkdown(COLLECTION, [], { baseUrl: BASE });
    expect(md).toInclude("_No digests yet._");
  });
});

describe("collectionDigestToMarkdown", () => {
  it("emits body, intro, and releases grouped by org", () => {
    const md = collectionDigestToMarkdown(COLLECTION, detail(), { baseUrl: BASE });
    expect(md).toInclude("week_start: 2026-07-06");
    expect(md).toInclude("# Agents take the stage");
    expect(md).toInclude("A week of agent runtimes and tooling.");
    expect(md).toInclude("### OpenAI");
    expect(md).toInclude("### Anthropic");
    expect(md).toInclude(`[Responses API](${BASE}/release/rel_a-responses-api)`);
    expect(md).toInclude(`canonical: ${BASE}/collections/frontier-ai-labs/digest/2026-07-06`);
  });
});

describe("collectionDigestsToAtom", () => {
  it("builds a weekly digests feed with stable entry ids", () => {
    const xml = collectionDigestsToAtom(
      {
        collectionSlug: COLLECTION.slug,
        collectionName: COLLECTION.name,
        digests: [listItem()],
      },
      { baseUrl: BASE },
    );
    expect(xml).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toInclude("<title>Frontier AI Labs — weekly digests</title>");
    expect(xml).toInclude(`href="${BASE}/collections/frontier-ai-labs/digest.atom"`);
    expect(xml).toInclude(`<id>${BASE}/collections/frontier-ai-labs/digest/2026-07-06</id>`);
    expect(xml).toInclude("Agents take the stage");
    expect(xml).toInclude('type="text/markdown"');
    expect(xml).toInclude("<sy:updatePeriod>weekly</sy:updatePeriod>");
  });
});
