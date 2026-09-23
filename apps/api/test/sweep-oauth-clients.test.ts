import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { eq } from "drizzle-orm";
import {
  oauthClient,
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
} from "../src/db/schema-auth";
import { cronRuns } from "../src/db/schema-cron";
import { sweepOauthClients, CRON_NAME } from "../src/cron/sweep-oauth-clients";

/**
 * Stale OAuth-client reaper (DCR follow-up to #1510).
 *   - Observe-only by default (flag off): logs candidates, deletes nothing.
 *   - Delete mode (flag on): purges abandoned dynamic-registration clients.
 *   - Protects trusted, consented, token-holding, and too-recent clients.
 */

const NOW = new Date("2026-06-08T07:00:00.000Z");
const OLD = new Date(NOW.getTime() - 40 * 24 * 3600_000); // 40d old (> 30d window)
const RECENT = new Date(NOW.getTime() - 2 * 24 * 3600_000); // 2d old

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

type Db = ReturnType<typeof mkDb>;

function seedClient(db: Db, opts: { id: string; createdAt: Date; trusted?: boolean }) {
  db.insert(oauthClient)
    .values({
      id: opts.id,
      clientId: `cid_${opts.id}`,
      redirectUris: ["https://app.example.com/cb"],
      scopes: ["read"],
      skipConsent: opts.trusted ?? false,
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    } as never)
    .run();
}

function seedConsent(db: Db, clientId: string) {
  db.insert(oauthConsent)
    .values({
      id: `cons_${clientId}`,
      userId: "user_1",
      clientId,
      scopes: ["read"],
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    .run();
}

function seedAccessToken(db: Db, clientId: string) {
  db.insert(oauthAccessToken)
    .values({
      id: `tok_${clientId}`,
      token: `t_${clientId}`,
      clientId,
      scopes: ["read"],
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 3600_000),
    } as never)
    .run();
}

function liveClientIds(db: Db): string[] {
  return db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .all()
    .map((r) => r.clientId);
}

function lastRunNotes(db: Db): string {
  const rows = db.select().from(cronRuns).where(eq(cronRuns.cronName, CRON_NAME)).all();
  return (rows.at(-1)?.notes as string) ?? "";
}

describe("sweepOauthClients", () => {
  it("CRON_ENABLED=false short-circuits (no run row, no delete)", async () => {
    const db = mkDb();
    seedClient(db, { id: "abandoned", createdAt: OLD });
    await sweepOauthClients({
      DB: {} as never,
      _now: NOW,
      CRON_ENABLED: "false",
      _drizzleOverride: db,
    });
    expect(liveClientIds(db)).toEqual(["cid_abandoned"]);
    expect(db.select().from(cronRuns).all()).toHaveLength(0);
  });

  it("observe mode (flag off) finds candidates but deletes nothing", async () => {
    const db = mkDb();
    seedClient(db, { id: "abandoned", createdAt: OLD });
    await sweepOauthClients({ DB: {} as never, _drizzleOverride: db });
    // Not deleted.
    expect(liveClientIds(db)).toEqual(["cid_abandoned"]);
    // Logged as a reapable candidate in observe mode.
    expect(lastRunNotes(db)).toContain("mode=observe");
    expect(lastRunNotes(db)).toContain("reapable=1");
    expect(lastRunNotes(db)).toContain("deleted=0");
  });

  it("delete mode (flag on) reaps an abandoned client", async () => {
    const db = mkDb();
    seedClient(db, { id: "abandoned", createdAt: OLD });
    await sweepOauthClients({
      DB: {} as never,
      _now: NOW,
      OAUTH_CLIENT_REAPER_ENABLED: "true",
      _drizzleOverride: db,
    });
    expect(liveClientIds(db)).toEqual([]);
    expect(lastRunNotes(db)).toContain("mode=delete");
    expect(lastRunNotes(db)).toContain("deleted=1");
  });

  it("delete mode protects trusted, consented, token-holding, and recent clients", async () => {
    const db = mkDb();
    seedClient(db, { id: "abandoned", createdAt: OLD }); // → reaped
    seedClient(db, { id: "trusted", createdAt: OLD, trusted: true }); // skip_consent
    seedClient(db, { id: "consented", createdAt: OLD }); // has a consent row
    seedConsent(db, "cid_consented");
    seedClient(db, { id: "tokened", createdAt: OLD }); // holds a token
    seedAccessToken(db, "cid_tokened");
    seedClient(db, { id: "recent", createdAt: RECENT }); // too new

    await sweepOauthClients({
      DB: {} as never,
      _now: NOW,
      OAUTH_CLIENT_REAPER_ENABLED: "true",
      _drizzleOverride: db,
    });

    expect(liveClientIds(db).toSorted()).toEqual(
      ["cid_consented", "cid_recent", "cid_tokened", "cid_trusted"].toSorted(),
    );
    expect(lastRunNotes(db)).toContain("deleted=1");
  });

  it("a refresh-token row also protects a client", async () => {
    const db = mkDb();
    seedClient(db, { id: "refreshed", createdAt: OLD });
    db.insert(oauthRefreshToken)
      .values({
        id: "rt_1",
        token: "rt_token",
        clientId: "cid_refreshed",
        userId: "user_1",
        scopes: ["read"],
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 3600_000),
      } as never)
      .run();
    await sweepOauthClients({
      DB: {} as never,
      _now: NOW,
      OAUTH_CLIENT_REAPER_ENABLED: "true",
      _drizzleOverride: db,
    });
    expect(liveClientIds(db)).toEqual(["cid_refreshed"]);
  });
});
