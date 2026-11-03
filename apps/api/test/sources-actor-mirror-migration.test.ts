/**
 * 20261103200000_sources_actor_mirror_columns: the SourceActor mirror moves
 * from `metadata.sourceActor` to `sources.actor_*`. Applies every earlier
 * migration, seeds rows in the old shape, then applies this one.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const TARGET = "20261103200000_sources_actor_mirror_columns.sql";

function hasSql(text: string): boolean {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .trim().length > 0
  );
}

function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .toSorted();
  for (const f of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    if (hasSql(text)) db.run(text);
  }
  return db;
}

function insertSource(db: Database, id: string, metadata: string | null): void {
  db.run(
    `INSERT INTO sources (id, name, slug, type, url, org_id, metadata, created_at, discovery)
     VALUES (?, ?, ?, 'scrape', 'https://example.com', 'org_a', ?, '2026-01-01T00:00:00.000Z', 'curated')`,
    [id, id, id, metadata],
  );
}

describe("sources actor mirror migration", () => {
  it("backfills the columns from metadata and drops the JSON key", () => {
    const db = dbBeforeTarget();
    db.run(
      `INSERT INTO organizations (id, name, slug, category, created_at, updated_at)
       VALUES ('org_a', 'A', 'a', 'developer-tools', '2026-01-01', '2026-01-01')`,
    );
    insertSource(
      db,
      "src_managed",
      JSON.stringify({
        feedUrl: "https://example.com/feed.xml",
        sourceActor: {
          managed: true,
          nextAlarmAt: "2026-11-03T22:00:00.000Z",
          lastAlarmAt: "2026-11-03T18:00:00.000Z",
        },
      }),
    );
    insertSource(
      db,
      "src_unmanaged",
      JSON.stringify({
        sourceActor: { managed: false, nextAlarmAt: null, lastAlarmAt: "2026-07-01T00:00:00.000Z" },
      }),
    );
    insertSource(db, "src_none", JSON.stringify({ feedUrl: "https://example.com/rss" }));
    insertSource(db, "src_null", null);
    insertSource(db, "src_bad", "not json");

    db.run(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf8"));

    const rows = db
      .query(
        `SELECT id, metadata, actor_managed, actor_next_alarm_at, actor_last_alarm_at
         FROM sources_active ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      metadata: string | null;
      actor_managed: number | null;
      actor_next_alarm_at: string | null;
      actor_last_alarm_at: string | null;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId.src_managed).toMatchObject({
      actor_managed: 1,
      actor_next_alarm_at: "2026-11-03T22:00:00.000Z",
      actor_last_alarm_at: "2026-11-03T18:00:00.000Z",
    });
    expect(JSON.parse(byId.src_managed!.metadata!)).toEqual({
      feedUrl: "https://example.com/feed.xml",
    });

    expect(byId.src_unmanaged).toMatchObject({
      actor_managed: 0,
      actor_next_alarm_at: null,
      actor_last_alarm_at: "2026-07-01T00:00:00.000Z",
    });
    expect(JSON.parse(byId.src_unmanaged!.metadata!)).toEqual({});

    for (const id of ["src_none", "src_null", "src_bad"]) {
      expect(byId[id]).toMatchObject({
        actor_managed: null,
        actor_next_alarm_at: null,
        actor_last_alarm_at: null,
      });
    }
    expect(byId.src_none!.metadata).toBe(JSON.stringify({ feedUrl: "https://example.com/rss" }));
    expect(byId.src_null!.metadata).toBeNull();
    expect(byId.src_bad!.metadata).toBe("not json");

    db.close();
  });
});
