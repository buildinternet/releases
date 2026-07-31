import { describe, expect, it } from "bun:test";
import {
  formatClaimVerifiedEmail,
  formatClaimVerifiedOperatorEmail,
  notifyClaimVerified,
  onClaimVerified,
  sendClaimVerifiedEmail,
} from "./claim-verified-email.js";

const base = {
  domain: "acme.com",
  orgName: "Acme",
  orgSlug: "acme",
  webOrigin: "https://releases.sh",
} as const;

const operatorBase = {
  domain: "acme.com",
  orgName: "Acme",
  orgSlug: "acme",
  method: "well-known" as const,
  ownerEmail: "owner@example.com",
  userId: "user_1",
  claimId: "clm_1",
  verifiedAt: "2026-07-31T12:00:00.000Z",
};

describe("formatClaimVerifiedEmail", () => {
  it("names the domain in the subject", () => {
    const { subject } = formatClaimVerifiedEmail({ ...base, method: "well-known" });
    expect(subject).toBe("Ownership verified — acme.com");
  });

  it("mentions domain and org in both bodies", () => {
    const { text, html } = formatClaimVerifiedEmail({ ...base, method: "well-known" });
    expect(text).toContain("acme.com");
    expect(text).toContain("Acme");
    expect(html).toContain("acme.com");
    expect(html).toContain("Acme");
  });

  it("labels well-known verification", () => {
    const { text, html } = formatClaimVerifiedEmail({ ...base, method: "well-known" });
    expect(text).toContain("well-known file");
    expect(html).toContain("well-known file");
  });

  it("labels DNS TXT verification", () => {
    const { text, html } = formatClaimVerifiedEmail({ ...base, method: "dns-txt" });
    expect(text).toContain("DNS TXT record");
    expect(html).toContain("DNS TXT record");
  });

  it("includes the org page URL in both html and text", () => {
    const { text, html } = formatClaimVerifiedEmail({ ...base, method: "well-known" });
    expect(text).toContain("https://releases.sh/acme");
    expect(html).toContain("https://releases.sh/acme");
  });

  it("includes a footer reason", () => {
    const { text } = formatClaimVerifiedEmail({ ...base, method: "well-known" });
    expect(text).toContain("You received this because you verified ownership of acme.com");
  });

  it("uses the Account · Ownership lane in HTML", () => {
    // Lane is masthead chrome — rendered in HTML, not the plain-text part.
    const { html } = formatClaimVerifiedEmail({ ...base, method: "well-known" });
    expect(html).toContain("Account · Ownership");
  });
});

describe("formatClaimVerifiedOperatorEmail", () => {
  it("uses the [ownership] subject filter prefix and names the domain", () => {
    const { subject } = formatClaimVerifiedOperatorEmail(operatorBase, base.webOrigin);
    expect(subject).toBe("[ownership] verified: acme.com");
  });

  it("includes owner contact and claim identifiers", () => {
    const { text, html } = formatClaimVerifiedOperatorEmail(operatorBase, base.webOrigin);
    expect(text).toContain("owner@example.com");
    expect(text).toContain("clm_1");
    expect(text).toContain("user_1");
    expect(html).toContain("owner@example.com");
  });

  it("includes the org page URL", () => {
    const { text } = formatClaimVerifiedOperatorEmail(operatorBase, base.webOrigin);
    expect(text).toContain("https://releases.sh/acme");
  });
});

describe("sendClaimVerifiedEmail", () => {
  it("never throws when AUTH_EMAIL is absent", async () => {
    await expect(
      sendClaimVerifiedEmail(
        {},
        {
          to: "owner@example.com",
          domain: "acme.com",
          orgName: "Acme",
          orgSlug: "acme",
          method: "well-known",
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("notifyClaimVerified", () => {
  it("never throws when SEND_EMAIL is absent", async () => {
    await expect(notifyClaimVerified({}, operatorBase)).resolves.toBeUndefined();
  });
});

describe("onClaimVerified", () => {
  it("never throws when both bindings are absent", async () => {
    await expect(onClaimVerified({}, operatorBase)).resolves.toBeUndefined();
  });
});
