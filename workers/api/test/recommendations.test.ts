import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { recommendations } from "@buildinternet/releases-core/schema";
import { createTestApp, createTestDb } from "./setup";

const IDEMPOTENCY_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const IDEMPOTENCY_KEY = "recommendation-idem-01";

async function makeApp(
  db = createTestDb(),
  env: Record<string, unknown> = {},
  executionCtx?: ExecutionContext,
) {
  const { recommendationRoutes } = await import("../src/routes/recommendations.js");
  return {
    db,
    fetch: createTestApp(db, recommendationRoutes, {
      env: {
        SEND_EMAIL: undefined,
        IDEMPOTENCY_ENCRYPTION_KEY: { get: async () => IDEMPOTENCY_SECRET },
        ...env,
      },
      executionCtx,
    }),
  };
}

function post(body: unknown) {
  return new Request("http://x/v1/recommendations", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "test-agent" },
    body: JSON.stringify(body),
  });
}

function idempotentPost(body: unknown, key = IDEMPOTENCY_KEY, userAgent = "test-agent") {
  return new Request("http://x/v1/recommendations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": userAgent,
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/recommendations", () => {
  it("stores a valid URL recommendation and returns 202 + id", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(
      post({
        url: "https://example.com/releases",
        note: "This is the public changelog.",
        contactEmail: "user@example.com",
      }),
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id.startsWith("rec_")).toBe(true);

    const rows = await db.select().from(recommendations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("source");
    expect(rows[0]!.url).toBe("https://example.com/releases");
    expect(rows[0]!.note).toBe("This is the public changelog.");
    expect(rows[0]!.contactEmail).toBe("user@example.com");
    expect(rows[0]!.status).toBe("new");
    expect(rows[0]!.archived).toBe(false);
    expect(rows[0]!.userAgent).toBe("test-agent");
  });

  it("accepts a bare URL by adding https", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ url: "example.com/changelog" }));
    expect(res.status).toBe(202);
    const rows = await db.select().from(recommendations);
    expect(rows[0]!.url).toBe("https://example.com/changelog");
  });

  it("defaults an omitted type to source and accepts explicit source", async () => {
    const { db, fetch } = await makeApp();
    await fetch(post({ url: "https://example.com/releases" }));
    await fetch(post({ type: "source", url: "https://example.com/changelog" }));
    const rows = await db.select().from(recommendations);
    expect(rows.map((row) => row.type)).toEqual(["source", "source"]);
  });

  it("rejects unsupported recommendation types", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ type: "product", url: "https://example.com/releases" }));
    expect(res.status).toBe(400);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("rejects non-http URLs", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ url: "mailto:zach@releases.sh" }));
    expect(res.status).toBe(400);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("rejects invalid contact emails", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ url: "https://example.com/releases", contactEmail: "nope" }));
    expect(res.status).toBe(400);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("strips control chars from the user-agent header and the surface field", async () => {
    const { db, fetch } = await makeApp();
    const ESC = String.fromCharCode(0x1b);
    const BELL = String.fromCharCode(0x07);
    const res = await fetch(
      new Request("http://x/v1/recommendations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `Mozilla${ESC}[2J${BELL}/5.0`,
        },
        body: JSON.stringify({
          url: "https://example.com/releases",
          surface: `cli${ESC}]0;pwned`,
        }),
      }),
    );
    expect(res.status).toBe(202);
    const [row] = await db.select().from(recommendations);
    expect(row!.userAgent).toBe("Mozilla[2J/5.0");
    expect(row!.surface).toBe("cli]0;pwned");
  });

  it("returns 429 when the shared public feedback limiter rejects", async () => {
    const { db, fetch } = await makeApp(undefined, {
      FEEDBACK_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    const res = await fetch(post({ url: "https://example.com/releases" }));
    expect(res.status).toBe(429);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("returns 503 when RECOMMENDATIONS_DISABLED=true", async () => {
    const { db, fetch } = await makeApp(undefined, { RECOMMENDATIONS_DISABLED: "true" });
    const res = await fetch(post({ url: "https://example.com/releases" }));
    expect(res.status).toBe(503);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("idempotency creates one recommendation and replays its original id", async () => {
    const { db, fetch } = await makeApp();
    const body = { url: "https://example.com/releases", note: "One request only" };

    const first = await fetch(idempotentPost(body));
    const replay = await fetch(idempotentPost(body));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(await db.select().from(recommendations)).toHaveLength(1);
  });

  it("idempotency schedules recommendation notification and ack once across replay", async () => {
    const scheduled: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        scheduled.push(promise);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const { fetch } = await makeApp(undefined, {}, executionCtx);
    const body = {
      url: "https://example.com/releases",
      contactEmail: "user@example.com",
    };

    await fetch(idempotentPost(body));
    await fetch(idempotentPost(body));
    await Promise.all(scheduled);

    expect(scheduled).toHaveLength(2);
  });

  it("idempotency validates again before claiming so an invalid request leaves its key reusable", async () => {
    const { db, fetch } = await makeApp();

    const invalid = await fetch(idempotentPost({ url: "ftp://example.com/releases" }));
    const valid = await fetch(idempotentPost({ url: "https://example.com/releases" }));

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(202);
    expect(await db.select().from(recommendations)).toHaveLength(1);
  });

  it("idempotency evaluates the anonymous limiter on replay but inserts once", async () => {
    let limits = 0;
    const { db, fetch } = await makeApp(undefined, {
      FEEDBACK_RATE_LIMITER: {
        limit: async () => {
          limits++;
          return { success: true };
        },
      },
    });
    const body = { url: "https://example.com/releases" };

    await fetch(idempotentPost(body));
    await fetch(idempotentPost(body));

    expect(limits).toBe(2);
    expect(await db.select().from(recommendations)).toHaveLength(1);
  });

  it("idempotency conflicts when an anonymous key is reused with changed bytes", async () => {
    const { db, fetch } = await makeApp();
    await fetch(idempotentPost({ url: "https://example.com/releases", note: "first" }));
    const conflict = await fetch(
      idempotentPost({ url: "https://example.com/releases", note: "second" }),
    );

    expect(conflict.status).toBe(409);
    expect(await db.select().from(recommendations)).toHaveLength(1);
  });

  it("idempotency conflicts when a feedback key was first used by recommendations", async () => {
    const { db, fetch } = await makeApp();
    await fetch(idempotentPost({ url: "https://example.com/releases" }));
    const { feedbackRoutes } = await import("../src/routes/feedback.js");
    const feedbackApp = new Hono();
    feedbackApp.route("/v1", feedbackRoutes);
    const conflict = await feedbackApp.fetch(
      new Request("http://x/v1/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ message: "A valid feedback message." }),
      }),
      {
        DB: db,
        SEND_EMAIL: undefined,
        IDEMPOTENCY_ENCRYPTION_KEY: { get: async () => IDEMPOTENCY_SECRET },
      },
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );

    expect(conflict.status).toBe(409);
  });

  it("idempotency ignores a retry User-Agent and preserves the winner User-Agent", async () => {
    const { db, fetch } = await makeApp();
    const body = { url: "https://example.com/releases" };
    const first = await fetch(idempotentPost(body, IDEMPOTENCY_KEY, "winner-agent"));
    const replay = await fetch(idempotentPost(body, IDEMPOTENCY_KEY, "retry-agent"));

    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect((await db.select().from(recommendations))[0]!.userAgent).toBe("winner-agent");
  });

  it("keeps identical headerless submissions independent", async () => {
    const { db, fetch } = await makeApp();
    const body = { url: "https://example.com/releases" };

    await fetch(post(body));
    await fetch(post(body));

    expect(await db.select().from(recommendations)).toHaveLength(2);
  });

  it("idempotency without its encryption secret does not insert", async () => {
    const { db, fetch } = await makeApp(undefined, { IDEMPOTENCY_ENCRYPTION_KEY: undefined });
    const res = await fetch(idempotentPost({ url: "https://example.com/releases" }));

    expect(res.status).toBe(503);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });
});

describe("PATCH /v1/recommendations/:id", () => {
  it("updates status and archived", async () => {
    const { db, fetch } = await makeApp();
    await db.insert(recommendations).values({
      id: "rec_seed",
      createdAt: 1000,
      type: "source",
      url: "https://example.com/releases",
      status: "new",
      archived: false,
      surface: "web",
    });

    const res = await fetch(
      new Request("http://x/v1/recommendations/rec_seed", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "triaged", archived: true }),
      }),
    );

    expect(res.status).toBe(200);
    const [row] = await db.select().from(recommendations);
    expect(row!.status).toBe("triaged");
    expect(row!.archived).toBe(true);
  });
});

describe("DELETE /v1/recommendations/:id", () => {
  it("deletes an existing recommendation", async () => {
    const { db, fetch } = await makeApp();
    await db.insert(recommendations).values({
      id: "rec_seed",
      createdAt: 1000,
      type: "source",
      url: "https://example.com/releases",
      status: "new",
      archived: false,
      surface: "web",
    });

    const res = await fetch(
      new Request("http://x/v1/recommendations/rec_seed", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("returns 404 for a missing recommendation", async () => {
    const { fetch } = await makeApp();
    const res = await fetch(
      new Request("http://x/v1/recommendations/rec_missing", { method: "DELETE" }),
    );

    expect(res.status).toBe(404);
  });
});
