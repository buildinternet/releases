import { describe, it, expect } from "bun:test";
import {
  sendAuthEmail,
  verifyEmailTemplate,
  resetPasswordTemplate,
  changeEmailTemplate,
  type AuthEmailBinding,
  type AuthEmailEnv,
  type AuthEmailMessage,
} from "../src/auth/email.js";

describe("auth email templates", () => {
  it("verifyEmailTemplate embeds the url in text + html and sets a subject", () => {
    const url = "https://api.releases.localhost/api/auth/verify-email?token=abc123";
    const t = verifyEmailTemplate({ url });
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text).toContain("token=abc123");
    expect(t.html).toContain("token=abc123");
    expect(t.html).toContain(`href="${url}"`);
    expect(t.text).toContain("You received this because someone signed up");
    expect(t.text).toContain("Account settings: https://releases.sh/account");
  });

  it("resetPasswordTemplate embeds the url in text + html and sets a subject", () => {
    const url = "https://api.releases.localhost/api/auth/reset-password/tok?callbackURL=x";
    const t = resetPasswordTemplate({ url });
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text).toContain("reset-password/tok");
    expect(t.html).toContain("reset-password/tok");
    expect(t.html).toContain(`href="${url}"`);
  });

  it("changeEmailTemplate embeds the url + new address and sets a subject", () => {
    const url = "https://api.releases.localhost/api/auth/verify-email?token=chg123";
    const t = changeEmailTemplate({ url, newEmail: "new@example.com" });
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text).toContain("token=chg123");
    expect(t.text).toContain("new@example.com");
    expect(t.html).toContain("token=chg123");
    expect(t.html).toContain("new@example.com");
    expect(t.html).toContain(`href="${url}"`);
  });
});

describe("sendAuthEmail", () => {
  const msg: AuthEmailMessage = {
    to: "u@example.com",
    subject: "Subject",
    text: "Click https://x/verify?token=t to continue",
    html: "<p>Click <a href='https://x/verify?token=t'>here</a></p>",
  };

  it("returns no_binding (and does not throw) when AUTH_EMAIL is absent", async () => {
    const res = await sendAuthEmail({}, msg);
    expect(res).toEqual({ sent: false, reason: "no_binding" });
  });

  it("calls the binding with the object-form shape when present", async () => {
    const calls: Array<Parameters<AuthEmailBinding["send"]>[0]> = [];
    const env = {
      AUTH_EMAIL: {
        send: async (m: Parameters<AuthEmailBinding["send"]>[0]) => {
          calls.push(m);
          return { messageId: "mid-1" };
        },
      },
      AUTH_EMAIL_FROM: "noreply@releases.sh",
    };
    const res = await sendAuthEmail(env as AuthEmailEnv, msg);
    expect(res).toEqual({ sent: true, messageId: "mid-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe("u@example.com");
    expect(calls[0]?.from).toContain("noreply@releases.sh");
    expect(calls[0]?.subject).toBe("Subject");
    expect(calls[0]?.text).toContain("token=t");
    expect(calls[0]?.html).toContain("token=t");
  });

  it("swallows a send failure (returns error, never throws)", async () => {
    const env = {
      AUTH_EMAIL: {
        send: async () => {
          throw new Error("email-sending beta unavailable");
        },
      },
    };
    const res = await sendAuthEmail(env as AuthEmailEnv, msg);
    expect(res).toEqual({ sent: false, reason: "error" });
  });
});

describe("sendAuthEmail token-in-logs safety", () => {
  // msg.text carries the single-use token URL; the logged line must include it ONLY
  // in a local env. logEvent JSON-stringifies the payload to console.warn (no_binding)
  // / console.error (send-failed) / console.log (sent), so capturing those reveals
  // exactly what reaches the shared log sink.
  const msg: AuthEmailMessage = {
    to: "u@example.com",
    subject: "Subject",
    text: "Click https://x/verify?token=SECRET to continue",
    html: "<p>x</p>",
  };
  const TOKEN = "token=SECRET";

  async function captureConsole(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    console.warn = (...a: unknown[]) => lines.push(a.join(" "));
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await fn();
    } finally {
      Object.assign(console, orig);
    }
    return lines.join("\n");
  }

  it("no_binding in a deployed prod env logs the event WITHOUT the token", async () => {
    const out = await captureConsole(async () => {
      const res = await sendAuthEmail({ ENVIRONMENT: "production" } as AuthEmailEnv, msg);
      expect(res).toEqual({ sent: false, reason: "no_binding" });
    });
    expect(out).toContain("email-no-binding");
    expect(out).toContain("Subject"); // still loudly observable
    expect(out).toContain("u@example.com");
    expect(out).not.toContain(TOKEN); // never leak the live credential
  });

  it("send-failed in a deployed prod env logs the error WITHOUT the token", async () => {
    const env = {
      ENVIRONMENT: "production",
      AUTH_EMAIL: {
        send: async () => {
          throw new Error("boom");
        },
      },
    };
    const out = await captureConsole(async () => {
      await sendAuthEmail(env as AuthEmailEnv, msg);
    });
    expect(out).toContain("email-send-failed");
    expect(out).not.toContain(TOKEN);
  });

  it("a successful send in deployed prod logs neither body nor token", async () => {
    const env = {
      ENVIRONMENT: "production",
      AUTH_EMAIL: { send: async () => ({ messageId: "m" }) },
    };
    const out = await captureConsole(async () => {
      await sendAuthEmail(env as AuthEmailEnv, msg);
    });
    expect(out).toContain("email-sent");
    expect(out).not.toContain(TOKEN);
  });

  it("DEV_MODE=true surfaces the link even when ENVIRONMENT reports production", async () => {
    // The local `wrangler dev` case: ENVIRONMENT is inherited as "production" but the
    // local-only DEV_MODE var flips link logging back on.
    const out = await captureConsole(async () => {
      await sendAuthEmail({ ENVIRONMENT: "production", DEV_MODE: "true" } as AuthEmailEnv, msg);
    });
    expect(out).toContain("email-no-binding");
    expect(out).toContain(TOKEN); // recoverable locally
  });

  it("a non-prod ENVIRONMENT also surfaces the link", async () => {
    const out = await captureConsole(async () => {
      await sendAuthEmail({ ENVIRONMENT: "development" } as AuthEmailEnv, msg);
    });
    expect(out).toContain(TOKEN);
  });
});
