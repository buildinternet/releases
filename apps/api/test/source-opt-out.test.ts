/**
 * `selectOptedOutReleaseIds` — the apply-time re-check for
 * `metadata.summarize=false`. The daily batch can be in flight when an
 * operator opts a source out; those ids must be dropped before the UPDATE.
 */
import { describe, expect, it } from "bun:test";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../tests/db-helper.js";
import { selectOptedOutReleaseIds } from "../src/lib/ai/source-opt-out.js";
import type { D1Db } from "../src/db.js";

describe("selectOptedOutReleaseIds", () => {
  it("returns only releases whose source set summarize=false", async () => {
    const testDb = createTestDb();
    await testDb.db.insert(organizations).values({
      id: "org_1",
      slug: "slack",
      name: "Slack",
    });
    await testDb.db.insert(sources).values([
      {
        id: "src_ios",
        orgId: "org_1",
        slug: "slack-ios",
        name: "Slack iOS",
        type: "appstore",
        url: "https://apps.apple.com/app/slack",
        metadata: JSON.stringify({ summarize: false }),
      },
      {
        id: "src_web",
        orgId: "org_1",
        slug: "slack-web",
        name: "Slack Web",
        type: "github",
        url: "https://github.com/slack/web",
      },
    ]);
    await testDb.db.insert(releases).values([
      {
        id: "rel_ios",
        sourceId: "src_ios",
        title: "4.40",
        content: "Bug fixes and performance improvements.",
        url: "https://apps.apple.com/app/slack#440",
      },
      {
        id: "rel_web",
        sourceId: "src_web",
        title: "Canvas",
        content: "Canvas now supports tables.",
        url: "https://slack.com/changelog/canvas",
      },
    ]);

    const optedOut = await selectOptedOutReleaseIds(testDb.db as unknown as D1Db, [
      "rel_ios",
      "rel_web",
      "rel_missing",
    ]);

    expect([...optedOut]).toEqual(["rel_ios"]);
    testDb.cleanup();
  });

  it("returns an empty set when nothing was submitted", async () => {
    const testDb = createTestDb();
    const optedOut = await selectOptedOutReleaseIds(testDb.db as unknown as D1Db, []);
    expect(optedOut.size).toBe(0);
    testDb.cleanup();
  });
});
