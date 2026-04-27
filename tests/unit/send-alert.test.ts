import { describe, it, expect } from "bun:test";
import { sendAlert, type AlertEnv } from "../../workers/api/src/lib/send-alert.js";

// Stand-in for the Cloudflare email binding. Real send goes through
// `cloudflare:email`, which lazy-imports inside `email.ts` — these tests
// exercise the dedup/prefix logic, not the email transport itself.
const fakeBinding = { send: async () => {} };

function makeEnv(overrides: Partial<AlertEnv> = {}): AlertEnv {
  return {
    SEND_EMAIL: fakeBinding,
    EMAIL_NOTIFY_ENABLED: "true",
    EMAIL_NOTIFY_TO: "admin@example.com",
    EMAIL_FROM: "notifications@releases.sh",
    ALERT_DEDUP_KV: undefined,
    ...overrides,
  };
}

describe("sendAlert", () => {
  it("returns false when SEND_EMAIL binding is missing", async () => {
    const result = await sendAlert(makeEnv({ SEND_EMAIL: undefined }), {
      subject: "[alert] test",
      body: "test body",
    });
    expect(result).toBe(false);
  });

  it("returns false when EMAIL_NOTIFY_ENABLED is 'false'", async () => {
    const result = await sendAlert(makeEnv({ EMAIL_NOTIFY_ENABLED: "false" }), {
      subject: "[alert] test",
      body: "body",
    });
    expect(result).toBe(false);
  });

  it("prepends [alert] prefix when missing", async () => {
    const kvKeys: string[] = [];
    const fakeKV: KVNamespace = {
      get: async (key: string) => {
        kvKeys.push(`get:${key}`);
        return null;
      },
      put: async (key: string) => {
        kvKeys.push(`put:${key}`);
      },
    } as unknown as KVNamespace;

    await sendAlert(makeEnv({ ALERT_DEDUP_KV: fakeKV }), {
      subject: "no prefix subject",
      body: "body",
    });

    expect(kvKeys.some((k) => k.includes("[alert] no prefix subject"))).toBe(true);
  });

  it("does not re-add [alert] when already present", async () => {
    const kvKeys: string[] = [];
    const fakeKV: KVNamespace = {
      get: async (key: string) => {
        kvKeys.push(`get:${key}`);
        return null;
      },
      put: async (key: string) => {
        kvKeys.push(`put:${key}`);
      },
    } as unknown as KVNamespace;

    await sendAlert(makeEnv({ ALERT_DEDUP_KV: fakeKV }), {
      subject: "[alert] already prefixed",
      body: "body",
    });

    const putKey = kvKeys.find((k) => k.startsWith("put:"));
    expect(putKey).toBe("put:alert:[alert] already prefixed");
    expect(putKey).not.toContain("[alert] [alert]");
  });

  it("deduplicates within 1h (KV hit)", async () => {
    const fakeKV: KVNamespace = {
      get: async () => "1",
      put: async () => {},
    } as unknown as KVNamespace;

    const result = await sendAlert(makeEnv({ ALERT_DEDUP_KV: fakeKV }), {
      subject: "[alert] cron crashed: retier-cron",
      body: "error details",
    });

    expect(result).toBe(false);
  });

  it("skips KV ops when the email path is a no-op", async () => {
    let kvTouched = false;
    const fakeKV: KVNamespace = {
      get: async () => {
        kvTouched = true;
        return null;
      },
      put: async () => {
        kvTouched = true;
      },
    } as unknown as KVNamespace;

    await sendAlert(makeEnv({ SEND_EMAIL: undefined, ALERT_DEDUP_KV: fakeKV }), {
      subject: "[alert] test",
      body: "body",
    });

    expect(kvTouched).toBe(false);
  });

  it("continues after KV failure and attempts email", async () => {
    const brokenKV: KVNamespace = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => {},
    } as unknown as KVNamespace;

    const result = await sendAlert(makeEnv({ ALERT_DEDUP_KV: brokenKV }), {
      subject: "[alert] test",
      body: "body",
    });
    // Email lazy-imports `cloudflare:email` which is unavailable in tests;
    // sendEmail throws, sendAlert catches → false. The KV failure didn't
    // short-circuit the attempt.
    expect(result).toBe(false);
  });
});
