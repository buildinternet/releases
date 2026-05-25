/**
 * Self-describing feed text. The model only reads `content[0].text`, so each
 * release block in `get_latest_releases` / `get_collection_releases` must carry
 * the release `id` (the handle for `get_release`), a content-size signal, and a
 * `get_release` hint — but the hint only when the preview is shorter than the
 * full body, so short, fully-shown releases don't get a wasted "fetch more"
 * nudge.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  organizations,
  sources,
  releases,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { getLatestReleases, getCollectionReleases } from "../../workers/mcp/src/tools.js";

let testDb: TestDatabase;
const LONG_ID = "rel_selfdesclong00000";
const SHORT_ID = "rel_selfdescshort0000";

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db
    .insert(organizations)
    .values({ id: "org_sd", name: "SelfDesc", slug: "selfdesc", discovery: "curated" });
  await testDb.db.insert(sources).values({
    id: "src_sd",
    orgId: "org_sd",
    name: "SD Releases",
    slug: "sd-releases",
    type: "github",
    url: "https://github.com/selfdesc/releases",
    discovery: "curated",
  });
  await testDb.db.insert(releases).values([
    {
      id: LONG_ID,
      sourceId: "src_sd",
      title: "Long release",
      type: "feature",
      content: "x".repeat(900),
      publishedAt: "2026-05-02T00:00:00Z",
      contentChars: 900,
      contentTokens: 225,
    },
    {
      id: SHORT_ID,
      sourceId: "src_sd",
      title: "Short release",
      type: "feature",
      content: "Short release body.",
      publishedAt: "2026-05-01T00:00:00Z",
      contentChars: 19,
      contentTokens: 5,
    },
  ]);
});

afterEach(() => testDb.cleanup());

describe("get_latest_releases — self-describing text", () => {
  it("emits an ID line for every release so get_release is callable", async () => {
    const out = await getLatestReleases(asD1(testDb.db), {});
    const text = out.content[0].text;
    expect(text).toContain(`ID: ${LONG_ID}`);
    expect(text).toContain(`ID: ${SHORT_ID}`);
  });

  it("surfaces a content-size signal", async () => {
    const out = await getLatestReleases(asD1(testDb.db), {});
    const text = out.content[0].text;
    expect(text).toContain("225 tokens");
  });

  it("appends a get_release hint for a truncated release", async () => {
    const out = await getLatestReleases(asD1(testDb.db), {});
    const text = out.content[0].text;
    expect(text).toContain(`get_release(id: "${LONG_ID}")`);
  });

  it("does not nudge get_release for a fully-shown short release", async () => {
    const out = await getLatestReleases(asD1(testDb.db), {});
    const text = out.content[0].text;
    expect(text).not.toContain(`get_release(id: "${SHORT_ID}")`);
  });
});

describe("get_collection_releases — self-describing text", () => {
  beforeEach(async () => {
    await testDb.db.insert(collections).values({
      id: "col_sd",
      slug: "sd-collection",
      name: "SD Collection",
    });
    await testDb.db.insert(collectionMembers).values({
      collectionId: "col_sd",
      orgId: "org_sd",
      position: 0,
    });
  });

  it("emits ID lines and a get_release hint for a truncated release", async () => {
    const out = await getCollectionReleases(asD1(testDb.db), { slug: "sd-collection" });
    const text = out.content[0].text;
    expect(text).toContain(`ID: ${LONG_ID}`);
    expect(text).toContain(`get_release(id: "${LONG_ID}")`);
    expect(text).toContain("225 tokens");
  });
});
