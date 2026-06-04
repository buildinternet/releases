import { describe, it, expect } from "bun:test";
import {
  sendAuthEmail,
  verifyEmailTemplate,
  resetPasswordTemplate,
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
  });

  it("resetPasswordTemplate embeds the url in text + html and sets a subject", () => {
    const url = "https://api.releases.localhost/api/auth/reset-password/tok?callbackURL=x";
    const t = resetPasswordTemplate({ url });
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text).toContain("reset-password/tok");
    expect(t.html).toContain("reset-password/tok");
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
