import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { siteNoticeRoutes } from "../../workers/api/src/routes/site-notice.js";
import { getStoredSiteNotice } from "../../workers/api/src/queries/site-settings.js";

let testDb: TestDatabase;

const ROOT = "root-secret";

function makeEnv(withKey = true) {
  return {
    DB: testDb.db as unknown as never,
    ...(withKey ? { RELEASES_API_KEY: { get: async () => ROOT } } : {}),
  };
}

const NOTICE = {
  active: true,
  message: "We shipped a new feed",
  linkText: "See it",
  href: "/updates",
  placement: "banner" as const,
  color: "#0081e7",
  dismissible: false,
};

async function get(env: ReturnType<typeof makeEnv>, auth?: string): Promise<Response> {
  return siteNoticeRoutes.request(
    "/site-notice",
    { method: "GET", headers: auth ? { authorization: `Bearer ${auth}` } : {} },
    env,
  );
}

async function put(
  env: ReturnType<typeof makeEnv>,
  body: unknown,
  auth?: string,
): Promise<Response> {
  return siteNoticeRoutes.request(
    "/site-notice",
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.cleanup();
});

describe("GET /v1/site-notice", () => {
  test("returns null when unset", async () => {
    const res = await get(makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notice: null });
  });

  test("returns the active notice to the public", async () => {
    await put(makeEnv(), NOTICE, ROOT);
    const res = await get(makeEnv());
    const body = (await res.json()) as { notice: { message: string; updatedAt: string } | null };
    expect(body.notice?.message).toBe("We shipped a new feed");
    expect(typeof body.notice?.updatedAt).toBe("string");
  });

  test("hides an inactive notice from the public but shows it to an admin", async () => {
    await put(makeEnv(), { ...NOTICE, active: false }, ROOT);
    expect(await (await get(makeEnv())).json()).toEqual({ notice: null });
    const adminRes = await get(makeEnv(), ROOT);
    const body = (await adminRes.json()) as { notice: { active: boolean } | null };
    expect(body.notice?.active).toBe(false);
  });
});

describe("PUT /v1/site-notice", () => {
  test("403 without an admin credential", async () => {
    const res = await put(makeEnv(), NOTICE);
    expect(res.status).toBe(403);
  });

  test("persists with a root credential", async () => {
    const res = await put(makeEnv(), NOTICE, ROOT);
    expect(res.status).toBe(200);
    const stored = await getStoredSiteNotice(testDb.db as never);
    expect(stored?.message).toBe("We shipped a new feed");
    expect(stored?.placement).toBe("banner");
  });

  test("400 on an invalid body (bad color)", async () => {
    const res = await put(makeEnv(), { ...NOTICE, color: "blue" }, ROOT);
    expect(res.status).toBe(400);
  });

  test("second PUT replaces the first (still one row)", async () => {
    await put(makeEnv(), NOTICE, ROOT);
    await put(makeEnv(), { ...NOTICE, message: "Second", placement: "home" }, ROOT);
    const stored = await getStoredSiteNotice(testDb.db as never);
    expect(stored?.message).toBe("Second");
    expect(stored?.placement).toBe("home");
  });
});
