import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { webhookSubscriptions } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../tests/db-helper.js";
import { setWebhookSubscriptionEnabled, updateWebhookSubscriptionSummary } from "./queries.js";

async function seed() {
  const tdb = createTestDb();
  await tdb.db.insert(webhookSubscriptions).values({
    id: "whk_test",
    url: "https://example.com/hook",
  });
  return tdb;
}

describe("webhook delivery transitions", () => {
  it("counts each failure from the stored counter and keeps the original streak start", async () => {
    const tdb = await seed();
    const db = tdb.db as never;
    const firstAt = "2026-06-01T00:00:00.000Z";
    const secondAt = "2026-06-01T01:00:00.000Z";

    const first = await updateWebhookSubscriptionSummary(db, "whk_test", {
      kind: "error",
      at: firstAt,
      message: "down",
    });
    const second = await updateWebhookSubscriptionSummary(db, "whk_test", {
      kind: "error",
      at: secondAt,
      message: "still down",
    });

    expect(first?.consecutiveFailures).toBe(1);
    expect(first?.failureStreakStartedAt).toBe(firstAt);
    expect(second?.consecutiveFailures).toBe(2);
    expect(second?.failureStreakStartedAt).toBe(firstAt);
    expect(second?.lastErrorMsg).toBe("still down");
    tdb.cleanup();
  });

  it("a success clears the failure streak", async () => {
    const tdb = await seed();
    const db = tdb.db as never;
    await updateWebhookSubscriptionSummary(db, "whk_test", {
      kind: "error",
      at: "2026-06-01T00:00:00.000Z",
      message: "down",
    });
    const ok = await updateWebhookSubscriptionSummary(db, "whk_test", {
      kind: "success",
      at: "2026-06-01T02:00:00.000Z",
    });
    expect(ok?.consecutiveFailures).toBe(0);
    expect(ok?.failureStreakStartedAt).toBeNull();
    expect(ok?.lastSuccessAt).toBe("2026-06-01T02:00:00.000Z");
    tdb.cleanup();
  });

  it("does not disable when the failure snapshot is no longer current", async () => {
    const tdb = await seed();
    const db = tdb.db as never;
    const fresh = await updateWebhookSubscriptionSummary(db, "whk_test", {
      kind: "error",
      at: "2026-06-01T00:00:00.000Z",
      message: "down",
    });
    // A success (or a manual re-enable) landed after this consumer decided.
    await tdb.db
      .update(webhookSubscriptions)
      .set({ consecutiveFailures: 0, failureStreakStartedAt: null })
      .where(eq(webhookSubscriptions.id, "whk_test"));

    const flipped = await setWebhookSubscriptionEnabled(db, "whk_test", false, "auto-disabled", {
      consecutiveFailures: fresh!.consecutiveFailures,
      failureStreakStartedAt: fresh!.failureStreakStartedAt,
    });
    expect(flipped).toBe(false);
    const [row] = await tdb.db
      .select({ enabled: webhookSubscriptions.enabled })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, "whk_test"));
    expect(row?.enabled).toBe(true);
    tdb.cleanup();
  });

  it("disables once when the observed failure snapshot is still the row", async () => {
    const tdb = await seed();
    const db = tdb.db as never;
    const streak = "2026-06-01T00:00:00.000Z";
    await tdb.db
      .update(webhookSubscriptions)
      .set({ consecutiveFailures: 10, failureStreakStartedAt: streak, enabled: true })
      .where(eq(webhookSubscriptions.id, "whk_test"));

    const observed = { consecutiveFailures: 10, failureStreakStartedAt: streak };
    expect(
      await setWebhookSubscriptionEnabled(db, "whk_test", false, "auto-disabled", observed),
    ).toBe(true);
    expect(
      await setWebhookSubscriptionEnabled(db, "whk_test", false, "auto-disabled", observed),
    ).toBe(false);

    const [row] = await tdb.db
      .select({
        enabled: webhookSubscriptions.enabled,
        disabledReason: webhookSubscriptions.disabledReason,
      })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, "whk_test"));
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toBe("auto-disabled");
    tdb.cleanup();
  });
});
