import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { idempotencyRecords } from "@buildinternet/releases-core/schema";
import { ServiceUnavailableError, ValidationError } from "@releases/lib/releases-error";
import { createTestDb, type TestDb } from "../../../tests/db-helper";
import type { Env } from "../src/index";
import type { IdempotencyPrincipal } from "../src/lib/idempotency-principal";
import { respondError } from "../src/lib/error-response";
import { idempotentPost } from "../src/middleware/idempotency";

const RAW_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const VALID_IDEMPOTENCY_KEY = "request-key-0001";

type StoreDb = Parameters<typeof import("../src/lib/idempotency-store").claimIdempotency>[0];

interface HarnessOptions {
  body?: "json" | "empty";
  db?: StoreDb;
  secret?: string | null;
  principal?: (c: Context<Env>) => IdempotencyPrincipal | null;
  preclaim?: (c: Context<Env>) => Promise<string | Response>;
  execute?: (c: Context<Env>, call: number, input: string) => Promise<Response>;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeHarness(options: HarnessOptions = {}) {
  const database = options.db ? null : createTestDb();
  if (database) cleanups.push(database.cleanup);
  const db = options.db ?? (database?.db as unknown as StoreDb);
  const secret = options.secret === undefined ? RAW_KEY : options.secret;
  const env = {
    DB: db,
    ...(secret === null ? {} : { IDEMPOTENCY_ENCRYPTION_KEY: { get: async () => secret } }),
  } as unknown as Env["Bindings"];
  const app = new Hono<Env>();
  let executions = 0;
  let preclaims = 0;

  app.onError((error, c) => respondError(c, error));
  app.on(["POST", "PUT"], "*", async (c) =>
    idempotentPost(c, {
      principal: options.principal
        ? options.principal(c)
        : {
            namespace: "user",
            id: c.req.header("x-test-principal") ?? "user-one",
          },
      body: options.body ?? "json",
      preclaim: async () => {
        preclaims += 1;
        return options.preclaim ? options.preclaim(c) : "validated";
      },
      execute: async (input) => {
        executions += 1;
        return options.execute
          ? options.execute(c, executions, input)
          : new Response(JSON.stringify({ execution: executions }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
      },
    }),
  );

  return {
    app,
    db,
    fixtureDb: database?.db,
    env,
    executions: () => executions,
    preclaims: () => preclaims,
    request(path = "/effect", init: RequestInit = {}) {
      return app.request(`https://api.example.test${path}`, { method: "POST", ...init }, env);
    },
  };
}

function withKey(init: RequestInit = {}, key = VALID_IDEMPOTENCY_KEY): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Idempotency-Key", key);
  return { ...init, headers };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

async function rowCount(db: TestDb): Promise<number> {
  return (await db.select().from(idempotencyRecords)).length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("idempotentPost", () => {
  test("a request without the header bypasses encryption and storage", async () => {
    const harness = makeHarness({ secret: null });

    const first = await harness.request();
    const second = await harness.request();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(harness.preclaims()).toBe(2);
    expect(harness.executions()).toBe(2);
    expect(await rowCount(harness.fixtureDb!)).toBe(0);
  });

  test("malformed keys fail validation before preclaim, execution, or storage", async () => {
    const harness = makeHarness();
    const malformed = ["short", "request-key with-space", "x".repeat(256), "é".repeat(16)];

    for (const key of malformed) {
      const response = await harness.request("/effect", withKey({}, key));
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
    expect(harness.preclaims()).toBe(0);
    expect(harness.executions()).toBe(0);
    expect(await rowCount(harness.fixtureDb!)).toBe(0);
  });

  test("streamed opted-in request bodies over 64 KiB return the typed 413 before a claim", async () => {
    const harness = makeHarness();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(25 * 1024 + 1));
        controller.close();
      },
    });
    const request = new Request("https://api.example.test/effect", {
      method: "POST",
      headers: { "Idempotency-Key": VALID_IDEMPOTENCY_KEY },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const response = await harness.app.request(request, undefined, harness.env);

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("payload_too_large");
    expect(harness.preclaims()).toBe(0);
    expect(harness.executions()).toBe(0);
    expect(await rowCount(harness.fixtureDb!)).toBe(0);
  });

  test("bodyless opted-in routes reject a non-empty body before a claim", async () => {
    const harness = makeHarness({ body: "empty" });

    const response = await harness.request("/effect", withKey({ body: "x" }));

    expect(response.status).toBe(400);
    expect(harness.preclaims()).toBe(0);
    expect(harness.executions()).toBe(0);
    expect(await rowCount(harness.fixtureDb!)).toBe(0);
  });

  test("missing, malformed, and wrong-length encryption secrets fail before execution or claim", async () => {
    for (const secret of [null, "not-base64", "AA=="]) {
      const harness = makeHarness({ secret });

      const response = await harness.request("/effect", withKey());

      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe("idempotency_unavailable");
      expect(harness.preclaims()).toBe(0);
      expect(harness.executions()).toBe(0);
      expect(await rowCount(harness.fixtureDb!)).toBe(0);
    }
  });

  test("a missing stable principal fails closed before a claim", async () => {
    const harness = makeHarness({ principal: () => null });

    const response = await harness.request("/effect", withKey());

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("idempotency_unavailable");
    expect(harness.executions()).toBe(0);
    expect(await rowCount(harness.fixtureDb!)).toBe(0);
  });

  test("method, pathname, exact query, normalized content type, and exact bytes bind the key", async () => {
    const cases: Array<[string, RequestInit, string, RequestInit]> = [
      ["/one", { body: "{}" }, "/one", { method: "PUT", body: "{}" }],
      ["/one", { body: "{}" }, "/two", { body: "{}" }],
      ["/one?a=1&b=2", { body: "{}" }, "/one?b=2&a=1", { body: "{}" }],
      [
        "/one",
        { headers: { "Content-Type": "application/json" }, body: "{}" },
        "/one",
        { headers: { "Content-Type": "text/plain" }, body: "{}" },
      ],
      ["/one", { body: '{"a":1}' }, "/one", { body: '{ "a": 1 }' }],
    ];

    for (const [index, [firstPath, firstInit, secondPath, secondInit]] of cases.entries()) {
      const harness = makeHarness();
      const key = `fingerprint-key-${index}`;
      expect((await harness.request(firstPath, withKey(firstInit, key))).status).toBe(201);

      const conflict = await harness.request(secondPath, withKey(secondInit, key));

      expect(conflict.status).toBe(409);
      expect(await errorCode(conflict)).toBe("idempotency_conflict");
      expect(harness.executions()).toBe(1);
    }

    const normalized = makeHarness();
    const first = await normalized.request(
      "/one",
      withKey({ headers: { "Content-Type": "Application/JSON" }, body: "{}" }),
    );
    const replay = await normalized.request(
      "/one",
      withKey({ headers: { "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(first.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  });

  test("the same raw key remains isolated across principal namespaces", async () => {
    const harness = makeHarness();
    const first = await harness.request(
      "/effect",
      withKey({ headers: { "X-Test-Principal": "user-one" } }),
    );
    const second = await harness.request(
      "/effect",
      withKey({ headers: { "X-Test-Principal": "user-two" } }),
    );
    const replay = await harness.request(
      "/effect",
      withKey({ headers: { "X-Test-Principal": "user-one" } }),
    );

    expect(await first.text()).toBe('{"execution":1}');
    expect(await second.text()).toBe('{"execution":2}');
    expect(await replay.text()).toBe('{"execution":1}');
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(harness.executions()).toBe(2);
  });

  test("concurrent matching requests admit one execution and return Retry-After for the loser", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const harness = makeHarness({
      execute: async () => {
        started.resolve();
        await finish.promise;
        return new Response("created", {
          status: 201,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      },
    });

    const winnerPromise = harness.request("/effect", withKey());
    await started.promise;
    const loser = await harness.request("/effect", withKey());

    expect(loser.status).toBe(409);
    expect(await errorCode(loser)).toBe("idempotency_in_progress");
    expect(loser.headers.get("Retry-After")).toBe("1");
    expect(harness.executions()).toBe(1);

    finish.resolve();
    expect((await winnerPromise).status).toBe(201);
  });

  test("exhausted store contention returns unavailable without execution", async () => {
    const db = {
      insert() {
        return {
          values() {
            return { onConflictDoNothing: () => ({ returning: async () => [] }) };
          },
        };
      },
      select() {
        return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
      },
    } as unknown as StoreDb;
    const harness = makeHarness({ db });

    const response = await harness.request("/effect", withKey());

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("idempotency_unavailable");
    expect(harness.executions()).toBe(0);
  });

  test("completed replay restores exact status, bytes, and allowlisted headers only", async () => {
    const body = '{\n  "secret": "revealed-once"\n}\n';
    const harness = makeHarness({
      execute: async () =>
        new Response(body, {
          status: 201,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Location: "/created/resource",
            "X-Private-Trace": "must-not-persist",
            "Set-Cookie": "secret=value",
          },
        }),
    });

    const original = await harness.request("/effect", withKey());
    const replay = await harness.request("/effect", withKey());

    expect(original.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await original.text()).toBe(body);
    expect(await replay.text()).toBe(body);
    expect(replay.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(replay.headers.get("Location")).toBe("/created/resource");
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("X-Private-Trace")).toBeNull();
    expect(replay.headers.get("Set-Cookie")).toBeNull();
    expect(harness.executions()).toBe(1);
  });

  test("returned and typed thrown 4xx outcomes release the key", async () => {
    const returned = makeHarness({
      execute: async (c) => respondError(c, new ValidationError("returned bad request")),
    });
    expect((await returned.request("/effect", withKey())).status).toBe(400);
    expect((await returned.request("/effect", withKey())).status).toBe(400);
    expect(returned.executions()).toBe(2);
    expect(await rowCount(returned.fixtureDb!)).toBe(0);

    const thrown = makeHarness({
      execute: async () => {
        throw new ValidationError("thrown bad request");
      },
    });
    expect((await thrown.request("/effect", withKey())).status).toBe(400);
    expect((await thrown.request("/effect", withKey())).status).toBe(400);
    expect(thrown.executions()).toBe(2);
    expect(await rowCount(thrown.fixtureDb!)).toBe(0);
  });

  test("a release that affects zero rows or throws restores a retry barrier", async () => {
    const zero = makeHarness({
      execute: async (c) => {
        await zero.fixtureDb!.delete(idempotencyRecords);
        return respondError(c, new ValidationError("correctable"));
      },
    });
    const zeroResponse = await zero.request("/effect", withKey());
    expect(zeroResponse.status).toBe(503);
    expect(await errorCode(zeroResponse)).toBe("idempotency_unavailable");
    const zeroRetry = await zero.request("/effect", withKey());
    expect(zeroRetry.status).toBe(409);
    expect(await errorCode(zeroRetry)).toBe("idempotency_in_progress");
    expect(zero.executions()).toBe(1);
    expect(await rowCount(zero.fixtureDb!)).toBe(1);

    const throwing = makeHarness({
      execute: async (c) => {
        (throwing.db as unknown as { delete: () => never }).delete = () => {
          throw new Error("release unavailable");
        };
        return respondError(c, new ValidationError("correctable"));
      },
    });
    const throwResponse = await throwing.request("/effect", withKey());
    expect(throwResponse.status).toBe(503);
    expect(await errorCode(throwResponse)).toBe("idempotency_unavailable");
    const throwRetry = await throwing.request("/effect", withKey());
    expect(throwRetry.status).toBe(409);
    expect(await errorCode(throwRetry)).toBe("idempotency_in_progress");
    expect(throwing.executions()).toBe(1);
    expect(await rowCount(throwing.fixtureDb!)).toBe(1);
  });

  test("returned 5xx and unexpected throws retain processing and block another execution", async () => {
    const returned = makeHarness({
      execute: async (c) => respondError(c, new ServiceUnavailableError("downstream down")),
    });
    expect((await returned.request("/effect", withKey())).status).toBe(503);
    const returnedRetry = await returned.request("/effect", withKey());
    expect(returnedRetry.status).toBe(409);
    expect(await errorCode(returnedRetry)).toBe("idempotency_in_progress");
    expect(returned.executions()).toBe(1);

    const thrown = makeHarness({
      execute: async () => {
        throw new Error("effect outcome unknown");
      },
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    expect((await thrown.request("/effect", withKey())).status).toBe(500);
    errorLog.mockRestore();
    const thrownRetry = await thrown.request("/effect", withKey());
    expect(thrownRetry.status).toBe(409);
    expect(await errorCode(thrownRetry)).toBe("idempotency_in_progress");
    expect(thrown.executions()).toBe(1);
  });

  test("capture failures and oversized or unrecordable 2xx responses return 503 and retain processing", async () => {
    const cases = [
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("stream failed"));
            },
          }),
          { status: 200, headers: { "Content-Type": "text/plain" } },
        ),
      () =>
        new Response("x".repeat(64 * 1024 + 1), {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      () =>
        new Response(new Uint8Array([0xff]), {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    ];

    for (const [index, response] of cases.entries()) {
      const harness = makeHarness({ execute: async () => response() });
      const key = `capture-failure-${index}`;
      const first = await harness.request("/effect", withKey({}, key));
      const second = await harness.request("/effect", withKey({}, key));
      expect(first.status).toBe(503);
      expect(await errorCode(first)).toBe("idempotency_unavailable");
      expect(second.status).toBe(409);
      expect(harness.executions()).toBe(1);
    }
  });

  test("encryption and completion failures return 503 and retain a retry barrier", async () => {
    const subtle = crypto.subtle as unknown as {
      encrypt: typeof crypto.subtle.encrypt;
    };
    const originalEncrypt = subtle.encrypt;
    const encryption = makeHarness();
    subtle.encrypt = async () => {
      throw new Error("crypto unavailable");
    };
    try {
      const response = await encryption.request("/effect", withKey());
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe("idempotency_unavailable");
    } finally {
      subtle.encrypt = originalEncrypt;
    }

    const throwing = makeHarness({
      execute: async () => {
        (throwing.db as unknown as { update: () => never }).update = () => {
          throw new Error("completion unavailable");
        };
        return new Response("created", {
          status: 201,
          headers: { "Content-Type": "text/plain" },
        });
      },
    });
    const throwResponse = await throwing.request("/effect", withKey());
    expect(throwResponse.status).toBe(503);
    expect(await errorCode(throwResponse)).toBe("idempotency_unavailable");
    const throwRetry = await throwing.request("/effect", withKey());
    expect(throwRetry.status).toBe(409);
    expect(await errorCode(throwRetry)).toBe("idempotency_in_progress");
    expect(throwing.executions()).toBe(1);
    expect(await rowCount(throwing.fixtureDb!)).toBe(1);
  });

  test("a handler 2xx does not settle before its guarded completion succeeds", async () => {
    const completion = deferred<Array<{ attemptId: string }>>();
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ attemptId: "attempt-one" }] }),
        }),
      }),
      select: () => ({}),
      update: () => ({
        set: () => ({ where: () => ({ returning: () => completion.promise }) }),
      }),
    } as unknown as StoreDb;
    const harness = makeHarness({ db });
    let settled = false;

    const responsePromise = Promise.resolve(harness.request("/effect", withKey())).then(
      (response) => {
        settled = true;
        return response;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    completion.resolve([{ attemptId: "attempt-one" }]);
    expect((await responsePromise).status).toBe(201);
  });

  test("an expired processing record is reclaimed for one new execution", async () => {
    const harness = makeHarness({
      execute: async (c, call) =>
        call === 1
          ? respondError(c, new ServiceUnavailableError("unknown outcome"))
          : new Response("reclaimed", {
              status: 200,
              headers: { "Content-Type": "text/plain" },
            }),
    });
    expect((await harness.request("/effect", withKey())).status).toBe(503);
    await harness
      .fixtureDb!.update(idempotencyRecords)
      .set({ expiresAt: "2000-01-01T00:00:00.000Z" });

    const reclaimed = await harness.request("/effect", withKey());

    expect(reclaimed.status).toBe(200);
    expect(await reclaimed.text()).toBe("reclaimed");
    expect(harness.executions()).toBe(2);
  });

  test("decrypt or AAD failure returns 503 without repeating the effect", async () => {
    const harness = makeHarness({
      execute: async () =>
        new Response("created", {
          status: 201,
          headers: { "Content-Type": "text/plain" },
        }),
    });
    expect((await harness.request("/effect", withKey())).status).toBe(201);
    await harness
      .fixtureDb!.update(idempotencyRecords)
      .set({ responseStatus: 202 })
      .where(
        eq(
          idempotencyRecords.keyHash,
          (await harness.fixtureDb!.select().from(idempotencyRecords))[0].keyHash,
        ),
      );

    const replay = await harness.request("/effect", withKey());

    expect(replay.status).toBe(503);
    expect(await errorCode(replay)).toBe("idempotency_unavailable");
    expect(harness.executions()).toBe(1);
  });
});
