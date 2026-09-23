import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import {
  getDigestPrefs,
  setDigestCadence,
  unsubscribeByToken,
  listDigestRecipients,
  advanceDigestWatermark,
} from "../src/queries/digest-prefs.js";

let h: TestDatabase;

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values([
    {
      id: "u1",
      name: "T",
      email: "t@e.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "u2",
      name: "U",
      email: "u@e.com",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
});
afterEach(() => h.cleanup());

describe("digest prefs query layer", () => {
  it("returns null before any prefs exist", async () => {
    expect(await getDigestPrefs(h.db, "u1")).toBeNull();
  });

  it("enabling stamps a watermark and mints a manage token", async () => {
    const row = await setDigestCadence(h.db, "u1", "daily");
    expect(row.cadence).toBe("daily");
    expect(row.lastDigestAt).toBeInstanceOf(Date);
    expect(row.manageToken.startsWith("reld_")).toBe(true);
  });

  it("off→on stamps, daily→weekly keeps the watermark, on→off keeps the row+token", async () => {
    const first = await setDigestCadence(h.db, "u1", "daily");
    const wm = first.lastDigestAt!.getTime();
    const second = await setDigestCadence(h.db, "u1", "weekly");
    expect(second.lastDigestAt!.getTime()).toBe(wm); // unchanged
    const off = await setDigestCadence(h.db, "u1", "off");
    expect(off.cadence).toBe("off");
    expect(off.manageToken).toBe(first.manageToken); // token preserved
  });

  it("unsubscribeByToken sets cadence off; bad token → false", async () => {
    const row = await setDigestCadence(h.db, "u1", "daily");
    expect(await unsubscribeByToken(h.db, row.manageToken)).toBe(true);
    expect((await getDigestPrefs(h.db, "u1"))!.cadence).toBe("off");
    expect(await unsubscribeByToken(h.db, "reld_nope")).toBe(false);
    expect(await unsubscribeByToken(h.db, "garbage")).toBe(false);
  });

  it("listDigestRecipients returns only cadence-matching + verified users", async () => {
    await setDigestCadence(h.db, "u1", "daily"); // verified
    await setDigestCadence(h.db, "u2", "daily"); // UNverified
    const recips = await listDigestRecipients(h.db, "daily", 100);
    expect(recips.map((r) => r.userId)).toEqual(["u1"]);
    expect(recips[0].email).toBe("t@e.com");
  });

  it("advanceDigestWatermark moves the watermark to runStart", async () => {
    await setDigestCadence(h.db, "u1", "daily");
    const runStart = new Date("2026-06-09T13:00:00.000Z");
    await advanceDigestWatermark(h.db, "u1", runStart);
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime()).toBe(runStart.getTime());
  });
});
