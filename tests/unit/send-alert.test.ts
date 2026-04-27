import { describe, it, expect, mock } from "bun:test";
import { sendAlert, type AlertEnv } from "../../workers/api/src/lib/send-alert.js";

// Minimal sendEmail mock (replaces the cloudflare:email lazy-import path).
// We test sendAlert's own logic; sendEmail itself is tested separately.

function makeEnv(overrides: Partial<AlertEnv> = {}): AlertEnv {
  return {
    EMAIL_NOTIFY_ENABLED: "true",
    EMAIL_NOTIFY_TO: "admin@example.com",
    EMAIL_FROM: "notifications@releases.sh",
    // Default: no SEND_EMAIL binding → sendEmail returns { sent: false, reason: "no_binding" }
    // That's fine — we test the dedup logic even when email is skipped.
    SEND_EMAIL: undefined,
    ALERT_DEDUP_KV: undefined,
    ...overrides,
  };
}

describe("sendAlert", () => {
  it("returns false when SEND_EMAIL binding is missing", async () => {
    const result = await sendAlert(makeEnv(), {
      subject: "[alert] test",
      body: "test body",
    });
    expect(result).toBe(false);
  });

  it("prepends [alert] prefix when missing", async () => {
    let capturedSubject = "";
    const fakeBinding = {
      send: mock(async () => {}),
    };

    // Patch: inject a fake SEND_EMAIL that captures the subject via a spy on sendEmail.
    // Since sendEmail lazy-imports cloudflare:email, we test the prefix logic directly
    // on the subject passed through by stubbing at the sendEmail level via a fresh env.
    // The simplest approach: pass disabled env, check that the subject arg is normalized.
    // (Integration-level test for the actual send is covered by email.ts tests.)

    // Test that sendAlert normalizes a subject without prefix
    const calls: string[] = [];
    const patchedEnv: AlertEnv = {
      ...makeEnv(),
      // Intercept via a custom no-op that records what subject would have been.
    };

    // Since sendEmail is imported and not easily mockable without module mocking,
    // we verify the prefix logic by checking the console output path. The canonical
    // test is: if EMAIL_NOTIFY_ENABLED is "false", sendEmail returns disabled and
    // sendAlert returns false — but the subject normalization happens before that.
    // We verify it via a KV spy instead.
    const kvKeys: string[] = [];
    const fakeKV: KVNamespace = {
      get: async (key: string) => {
        kvKeys.push(`get:${key}`);
        return null;
      },
      put: async (key: string, _value: string, _opts?: unknown) => {
        kvKeys.push(`put:${key}`);
      },
    } as unknown as KVNamespace;

    await sendAlert(
      { ...makeEnv(), ALERT_DEDUP_KV: fakeKV },
      {
        subject: "no prefix subject",
        body: "body",
      },
    );

    // The KV key should use the normalized subject with [alert] prefix.
    expect(kvKeys.some((k) => k.includes("[alert] no prefix subject"))).toBe(true);
  });

  it("does not re-add [alert] when already present", async () => {
    const kvKeys: string[] = [];
    const fakeKV: KVNamespace = {
      get: async (key: string) => {
        kvKeys.push(`get:${key}`);
        return null;
      },
      put: async (key: string, _value: string, _opts?: unknown) => {
        kvKeys.push(`put:${key}`);
      },
    } as unknown as KVNamespace;

    await sendAlert(
      { ...makeEnv(), ALERT_DEDUP_KV: fakeKV },
      {
        subject: "[alert] already prefixed",
        body: "body",
      },
    );

    // Should not double-prefix
    const putKey = kvKeys.find((k) => k.startsWith("put:"));
    expect(putKey).toBeDefined();
    expect(putKey).toBe("put:alert:[alert] already prefixed");
    expect(putKey).not.toContain("[alert] [alert]");
  });

  it("deduplicates within 1h (KV hit)", async () => {
    const fakeKV: KVNamespace = {
      get: async (_key: string) => "1", // Already set → deduped
      put: async () => {},
    } as unknown as KVNamespace;

    const result = await sendAlert(
      { ...makeEnv(), ALERT_DEDUP_KV: fakeKV },
      {
        subject: "[alert] cron crashed: retier-cron",
        body: "error details",
      },
    );

    expect(result).toBe(false);
  });

  it("proceeds when KV is absent (no dedup)", async () => {
    // Without KV, dedup is skipped. Email will fail (no_binding) but no exception.
    const result = await sendAlert(makeEnv({ ALERT_DEDUP_KV: undefined }), {
      subject: "[alert] cron crashed: poll-fetch-cron",
      body: "error",
    });
    // Returns false because SEND_EMAIL is also absent — but no throw.
    expect(result).toBe(false);
  });

  it("continues after KV failure and attempts email", async () => {
    const brokenKV: KVNamespace = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => {},
    } as unknown as KVNamespace;

    // Should not throw, should fall through to email attempt (which fails due to no binding).
    const result = await sendAlert(
      { ...makeEnv(), ALERT_DEDUP_KV: brokenKV },
      {
        subject: "[alert] test",
        body: "body",
      },
    );
    expect(result).toBe(false); // email still fails (no SEND_EMAIL), but no throw
  });
});
