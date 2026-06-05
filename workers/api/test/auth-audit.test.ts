import { describe, it, expect } from "bun:test";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import type { AuthEmailMessage } from "../src/auth/email.js";
import {
  redactIp,
  classifySignInFailure,
  auditDatabaseHooks,
  auditAfterEmailVerification,
  auditOnPasswordReset,
  type AuthAuditFields,
} from "../src/auth/audit.js";

// A capturing audit sink: records (level, fields) pairs for assertions.
function captureSink() {
  const events: Array<{ level: "info" | "warn"; fields: AuthAuditFields }> = [];
  const sink = (level: "info" | "warn", fields: AuthAuditFields) => {
    events.push({ level, fields });
  };
  return { events, sink };
}

// ── redactIp (pure) ──

describe("redactIp", () => {
  it("drops the last octet of an IPv4 address (keeps /24)", () => {
    expect(redactIp("203.0.113.7")).toBe("203.0.113.0/24");
    expect(redactIp("10.0.0.255")).toBe("10.0.0.0/24");
  });

  it("keeps the /48 prefix of an IPv6 address", () => {
    expect(redactIp("2001:db8:abcd:1::1")).toBe("2001:db8:abcd::/48");
    expect(redactIp("2001:db8:abcd:0:0:0:0:1")).toBe("2001:db8:abcd::/48");
  });

  it("returns undefined for missing / empty / unparseable input", () => {
    expect(redactIp()).toBeUndefined();
    expect(redactIp(null)).toBeUndefined();
    expect(redactIp("")).toBeUndefined();
    expect(redactIp("   ")).toBeUndefined();
    expect(redactIp("not-an-ip")).toBeUndefined();
    // Out-of-range octet → not a valid IPv4, don't emit a half-truncated value.
    expect(redactIp("999.1.1.1")).toBeUndefined();
    // Loopback IPv6 has no routable prefix to keep.
    expect(redactIp("::1")).toBeUndefined();
  });

  it("never returns a string containing the full host portion", () => {
    expect(redactIp("203.0.113.7")).not.toContain(".7");
    expect(redactIp("2001:db8:abcd:1::dead")).not.toContain("dead");
  });
});

// ── classifySignInFailure (pure) ──

describe("classifySignInFailure", () => {
  const base = { path: "/api/auth/sign-in/email", method: "POST" };

  it("maps 401 to invalid-credentials (covers bad password AND unknown user)", () => {
    expect(classifySignInFailure({ ...base, status: 401 })).toEqual({
      event: "sign-in-failure",
      reason: "invalid-credentials",
    });
  });

  it("maps 403 to unverified", () => {
    expect(classifySignInFailure({ ...base, status: 403 })).toEqual({
      event: "sign-in-failure",
      reason: "unverified",
    });
  });

  it("maps 429 to rate-limited", () => {
    expect(classifySignInFailure({ ...base, status: 429 })).toEqual({
      event: "sign-in-failure",
      reason: "rate-limited",
    });
  });

  it("returns null for a successful sign-in (200) or other status", () => {
    expect(classifySignInFailure({ ...base, status: 200 })).toBeNull();
    expect(classifySignInFailure({ ...base, status: 302 })).toBeNull();
    expect(classifySignInFailure({ ...base, status: 500 })).toBeNull();
  });

  it("ignores non-sign-in paths and non-POST methods", () => {
    expect(
      classifySignInFailure({ path: "/api/auth/get-session", method: "GET", status: 401 }),
    ).toBeNull();
    expect(
      classifySignInFailure({ path: "/api/auth/sign-up/email", method: "POST", status: 401 }),
    ).toBeNull();
    expect(classifySignInFailure({ ...base, method: "GET", status: 401 })).toBeNull();
  });
});

// ── Hook factories (unit; called directly with fake entities) ──

describe("auditDatabaseHooks", () => {
  it("user.create.after emits sign-up with the user id (info)", async () => {
    const { events, sink } = captureSink();
    await auditDatabaseHooks(sink).user.create.after({ id: "u_1" });
    expect(events).toEqual([{ level: "info", fields: { event: "sign-up", userId: "u_1" } }]);
  });

  it("session.create.after emits sign-in-success with user id + redacted ip (info)", async () => {
    const { events, sink } = captureSink();
    await auditDatabaseHooks(sink).session.create.after({
      userId: "u_2",
      ipAddress: "203.0.113.9",
    });
    expect(events).toEqual([
      { level: "info", fields: { event: "sign-in-success", userId: "u_2", ip: "203.0.113.0/24" } },
    ]);
  });

  it("session.create.after omits ip when the session has none", async () => {
    const { events, sink } = captureSink();
    await auditDatabaseHooks(sink).session.create.after({ userId: "u_3", ipAddress: null });
    expect(events[0]?.fields).toEqual({ event: "sign-in-success", userId: "u_3", ip: undefined });
  });

  it("session.delete.after emits sign-out (info) for a user-initiated /sign-out", async () => {
    const { events, sink } = captureSink();
    await auditDatabaseHooks(sink).session.delete.after({ userId: "u_4" }, { path: "/sign-out" });
    expect(events).toEqual([{ level: "info", fields: { event: "sign-out", userId: "u_4" } }]);
  });

  it("session.delete.after emits session-revoked (warn) for any non-/sign-out deletion", async () => {
    const { events, sink } = captureSink();
    // e.g. a session killed by revokeSessionsOnPasswordReset, or null context.
    await auditDatabaseHooks(sink).session.delete.after(
      { userId: "u_5" },
      { path: "/reset-password" },
    );
    await auditDatabaseHooks(sink).session.delete.after({ userId: "u_6" }, null);
    expect(events).toEqual([
      { level: "warn", fields: { event: "session-revoked", userId: "u_5" } },
      { level: "warn", fields: { event: "session-revoked", userId: "u_6" } },
    ]);
  });
});

describe("auditAfterEmailVerification / auditOnPasswordReset", () => {
  it("emits email-verified with the user id", async () => {
    const { events, sink } = captureSink();
    await auditAfterEmailVerification(sink)({ id: "u_7" });
    expect(events).toEqual([{ level: "info", fields: { event: "email-verified", userId: "u_7" } }]);
  });

  it("emits password-reset-completed with the user id", async () => {
    const { events, sink } = captureSink();
    await auditOnPasswordReset(sink)({ user: { id: "u_8" } });
    expect(events).toEqual([
      { level: "info", fields: { event: "password-reset-completed", userId: "u_8" } },
    ]);
  });
});

// ── Integration: events fire through the REAL createAuth wiring ──
// Builds createAuth() over the migrated test DB with an injected capturing audit
// sink (and a capturing email sender so the verification token is reachable), then
// drives the actual Better Auth flows — proving the hooks are registered, not just
// that the factories work in isolation.

describe("audit events fire through createAuth", () => {
  const env = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  } as never;

  const PASSWORD = "correct-horse-battery";

  function setup() {
    const db = createTestDb();
    const emails: AuthEmailMessage[] = [];
    const { events, sink } = captureSink();
    return {
      db,
      emails,
      events,
      auth: createAuth(env, undefined, {
        db,
        sendEmail: (m) => {
          emails.push(m);
        },
        audit: sink,
      }),
    };
  }

  function eventNames(events: Array<{ fields: AuthAuditFields }>): string[] {
    return events.map((e) => e.fields.event);
  }

  it("sign-up emits exactly `sign-up` (no session → no sign-in-success)", async () => {
    const { events, auth } = setup();
    const a = await auth;
    await a.api.signUpEmail({
      body: { email: "ann@example.com", password: PASSWORD, name: "Ann" },
    });
    expect(eventNames(events)).toEqual(["sign-up"]);
    expect(events[0]?.fields.userId).toBeTruthy();
  });

  it("verifying the email token emits `email-verified` and `sign-in-success` (auto sign-in)", async () => {
    const { emails, events, auth } = setup();
    const a = await auth;
    await a.api.signUpEmail({
      body: { email: "bea@example.com", password: PASSWORD, name: "Bea" },
    });
    const token = /token=([^&\s]+)/.exec(emails[0]?.text ?? "")?.[1];
    expect(token).toBeTruthy();

    await a.api.verifyEmail({ query: { token: token as string } });

    const names = eventNames(events);
    expect(names).toContain("email-verified");
    expect(names).toContain("sign-in-success");
  });

  it("a verified user's sign-in emits `sign-in-success` with the user id", async () => {
    const { emails, events, auth } = setup();
    const a = await auth;
    await a.api.signUpEmail({
      body: { email: "cleo@example.com", password: PASSWORD, name: "Cleo" },
    });
    const token = /token=([^&\s]+)/.exec(emails[0]?.text ?? "")?.[1];
    await a.api.verifyEmail({ query: { token: token as string } });

    const before = events.length;
    const signIn = await a.api.signInEmail({
      body: { email: "cleo@example.com", password: PASSWORD },
    });
    const fresh = events.slice(before);
    expect(eventNames(fresh)).toContain("sign-in-success");
    const success = fresh.find((e) => e.fields.event === "sign-in-success");
    expect(success?.fields.userId).toBe(signIn.user.id);
  });

  it("never leaks the email address or password into any audit payload", async () => {
    const { emails, events, auth } = setup();
    const a = await auth;
    await a.api.signUpEmail({
      body: { email: "dan@example.com", password: PASSWORD, name: "Dan" },
    });
    const token = /token=([^&\s]+)/.exec(emails[0]?.text ?? "")?.[1];
    await a.api.verifyEmail({ query: { token: token as string } });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("dan@example.com");
    expect(serialized).not.toContain(PASSWORD);
  });
});
