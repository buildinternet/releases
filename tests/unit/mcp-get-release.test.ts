/**
 * `get_release` structured payload. The MCP App detail view lazy-fetches a
 * single release through this tool and renders the structured fields directly,
 * so `getRelease` must attach `structuredContent` alongside the existing text
 * blob (which non-app hosts and the model still read unchanged).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases, orgAccounts } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { getRelease } from "../../workers/mcp/src/tools.js";

let testDb: TestDatabase;
let orgId: string;
let srcId: string;

beforeEach(async () => {
  testDb = createTestDb();
  orgId = newOrgId();
  srcId = newSourceId();
  await testDb.db.insert(organizations).values({
    id: orgId,
    name: "Acme Inc",
    slug: "acme",
    discovery: "curated",
    avatarUrl: "https://media.releases.sh/orgs/acme.png",
  });
  await testDb.db
    .insert(orgAccounts)
    .values({ id: "oa_acme", orgId, platform: "github", handle: "acme" });
  await testDb.db.insert(sources).values({
    id: srcId,
    orgId,
    name: "Acme Releases",
    slug: "acme-releases",
    type: "github",
    url: "https://github.com/acme/releases",
    discovery: "curated",
  });
});

afterEach(() => testDb.cleanup());

describe("getRelease — structuredContent", () => {
  it("attaches the structured detail payload for the App UI", async () => {
    const id = newReleaseId();
    await testDb.db.insert(releases).values({
      id,
      sourceId: srcId,
      title: "Widget 2.0",
      version: "2.0.0",
      type: "feature",
      content: "## What's new\n\nBig changes.",
      summary: "Big changes.",
      publishedAt: "2026-05-01T00:00:00Z",
      url: "https://example.com/widget-2",
    });

    const out = await getRelease(asD1(testDb.db), { id });
    const sc = out.structuredContent as Record<string, unknown> | undefined;

    expect(sc).toBeDefined();
    expect(sc!.id).toBe(id);
    expect(sc!.title).toBe("Widget 2.0");
    expect(sc!.version).toBe("2.0.0");
    expect(sc!.type).toBe("feature");
    expect(sc!.content).toBe("## What's new\n\nBig changes.");
    expect(sc!.url).toBe("https://example.com/widget-2");
    expect(sc!.publishedAt).toBe("2026-05-01T00:00:00Z");
    expect(sc!.source).toEqual({
      name: "Acme Releases",
      coordinate: "acme/acme-releases",
      type: "github",
    });
    expect(sc!.org).toEqual({
      name: "Acme Inc",
      slug: "acme",
      avatarUrl: "https://media.releases.sh/orgs/acme.png",
      githubHandle: "acme",
    });
    expect(sc!.product).toBeNull();
  });

  it("falls back to summary when content is empty", async () => {
    const id = newReleaseId();
    await testDb.db.insert(releases).values({
      id,
      sourceId: srcId,
      title: "Summary-only release",
      type: "feature",
      content: "",
      summary: "Only a summary survived enrichment.",
    });

    const out = await getRelease(asD1(testDb.db), { id });
    const sc = out.structuredContent as Record<string, unknown> | undefined;
    expect(sc!.content).toBe("Only a summary survived enrichment.");
  });

  it("does not leak structured data for a suppressed release", async () => {
    const id = newReleaseId();
    await testDb.db.insert(releases).values({
      id,
      sourceId: srcId,
      title: "Hidden",
      type: "feature",
      content: "secret",
      suppressed: true,
    });

    const out = await getRelease(asD1(testDb.db), { id });
    expect(out.structuredContent).toBeUndefined();
    expect(out.content[0].text).toContain("No release found");
  });

  it("keeps the text fallback (id header + body) unchanged for the model", async () => {
    const id = newReleaseId();
    await testDb.db.insert(releases).values({
      id,
      sourceId: srcId,
      title: "Text fallback release",
      type: "feature",
      content: "The full body text.",
      publishedAt: "2026-05-02T00:00:00Z",
    });

    const out = await getRelease(asD1(testDb.db), { id });
    const text = out.content[0].text;
    expect(text).toContain(`ID: ${id}`);
    expect(text).toContain("Text fallback release");
    expect(text).toContain("The full body text.");
  });
});
