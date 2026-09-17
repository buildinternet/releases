/**
 * queryUnmanagedActiveSources (#2286): active sources that should still be
 * polling but whose SourceActor mirror is missing, unmanaged, or stale.
 */

import { describe, it, expect } from "bun:test";
import { createTestDb, type TestDb } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import {
  queryUnmanagedActiveSources,
  countUnmanagedActiveSources,
} from "../src/queries/unmanaged-source-actors.js";
import type { D1Db } from "../src/db.js";

async function addOrg(db: TestDb, id: string, opts: { fetchPaused?: boolean } = {}): Promise<void> {
  await db.insert(organizations).values({
    id,
    slug: id,
    name: id,
    category: "developer-tools",
    fetchPaused: opts.fetchPaused ?? false,
  });
}

async function addSource(
  db: TestDb,
  id: string,
  opts: {
    orgId?: string;
    fetchPriority?: "normal" | "low" | "paused";
    firecrawl?: boolean;
    managed?: boolean | null;
    nextAlarmAt?: string | null;
  } = {},
): Promise<void> {
  const sourceActor =
    opts.managed === undefined
      ? undefined
      : {
          managed: opts.managed,
          nextAlarmAt: opts.nextAlarmAt ?? null,
          lastAlarmAt: new Date().toISOString(),
        };
  await db.insert(sources).values({
    id,
    orgId: opts.orgId ?? "org_a",
    slug: id,
    name: id,
    url: `https://${id}.test/changelog`,
    type: "scrape",
    fetchPriority: opts.fetchPriority ?? "normal",
    metadata: JSON.stringify({
      ...(opts.firecrawl ? { firecrawl: { enabled: true } } : {}),
      ...(sourceActor ? { sourceActor } : {}),
    }),
  });
}

describe("queryUnmanagedActiveSources", () => {
  it("includes sources with no sourceActor mirror and managed:false", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a");
    await addSource(db, "src_none");
    await addSource(db, "src_dead", { managed: false, nextAlarmAt: null });
    await addSource(db, "src_ok", {
      managed: true,
      nextAlarmAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const rows = await queryUnmanagedActiveSources(db as unknown as D1Db);
    expect(rows.map((r) => r.id).toSorted()).toEqual(["src_dead", "src_none"]);
    expect(await countUnmanagedActiveSources(db as unknown as D1Db)).toBe(2);
  });

  it("excludes paused, firecrawl-owned, and org-paused sources", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a");
    await addOrg(db, "org_paused", { fetchPaused: true });
    await addSource(db, "src_paused", { fetchPriority: "paused", managed: false });
    await addSource(db, "src_fc", { firecrawl: true, managed: false });
    await addSource(db, "src_org", { orgId: "org_paused", managed: false });

    const rows = await queryUnmanagedActiveSources(db as unknown as D1Db);
    expect(rows).toEqual([]);
  });

  it("treats a past nextAlarmAt as unmanaged even when managed:true", async () => {
    const { db } = createTestDb();
    await addOrg(db, "org_a");
    await addSource(db, "src_stale", {
      managed: true,
      nextAlarmAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    const rows = await queryUnmanagedActiveSources(db as unknown as D1Db);
    expect(rows.map((r) => r.id)).toEqual(["src_stale"]);
  });
});
