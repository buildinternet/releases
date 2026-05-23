import { describe, it, expect } from "bun:test";
import {
  formatDlqAlert,
  formatAutoDisableAlert,
  subscriptionHeadline,
  orgLabel,
  type SubscriptionLabel,
} from "./alert-format.js";

const acmeLabel: SubscriptionLabel = {
  id: "whk_1",
  url: "https://acme.example/hooks/releases",
  description: "Release feed → #eng-releases",
  orgName: "Acme Inc",
  orgSlug: "acme",
};

describe("orgLabel", () => {
  it("combines name and slug, dedupes when they coincide", () => {
    expect(orgLabel("Acme Inc", "acme")).toBe("Acme Inc (acme)");
    expect(orgLabel("acme", "acme")).toBe("acme");
    expect(orgLabel(null, "acme")).toBe("acme");
    expect(orgLabel(null, null)).toBe("");
  });
});

describe("subscriptionHeadline", () => {
  it("leads with org + description", () => {
    expect(subscriptionHeadline(acmeLabel, "whk_1")).toBe(
      "Acme Inc (acme) — Release feed → #eng-releases",
    );
  });
  it("degrades to url then bare id", () => {
    expect(
      subscriptionHeadline(
        {
          id: "whk_2",
          url: "https://x.example/h",
          description: null,
          orgName: null,
          orgSlug: null,
        },
        "whk_2",
      ),
    ).toBe("https://x.example/h");
    expect(subscriptionHeadline(null, "whk_3")).toBe("whk_3");
  });
});

describe("formatDlqAlert", () => {
  it("names the subscription and keeps the id as detail", () => {
    const { subject, body } = formatDlqAlert([
      { subId: "whk_1", count: 3, lastError: "max retries exceeded", label: acmeLabel },
    ]);
    expect(subject).toBe("[alert] webhook DLQ: 3 messages");
    expect(body).toContain("Acme Inc (acme) — Release feed → #eng-releases");
    expect(body).toContain("url:        https://acme.example/hooks/releases");
    expect(body).toContain("messages:   3");
    expect(body).toContain("last error: max retries exceeded");
    expect(body).toContain("sub id:     whk_1");
    // No bare "sub=<id>" leading line anymore.
    expect(body).not.toContain("sub=whk_1");
  });

  it("falls back to the bare id when the subscription is unresolved", () => {
    const { body } = formatDlqAlert([
      { subId: "whk_gone", count: 1, lastError: null, label: null },
    ]);
    expect(body).toContain("whk_gone");
    expect(body).toContain("last error: unknown");
  });

  it("sums the message count across subscriptions", () => {
    const { subject } = formatDlqAlert([
      { subId: "a", count: 2, lastError: null, label: null },
      { subId: "b", count: 5, lastError: null, label: null },
    ]);
    expect(subject).toBe("[alert] webhook DLQ: 7 messages");
  });
});

describe("formatAutoDisableAlert", () => {
  it("names the org and endpoint, keeps ids as detail", () => {
    const { subject, body } = formatAutoDisableAlert({
      subId: "whk_1",
      url: "https://acme.example/hooks/releases",
      description: "Release feed → #eng-releases",
      orgName: "Acme Inc",
      orgSlug: "acme",
      consecutiveFailures: 50,
      lastError: "503 Service Unavailable",
    });
    expect(subject).toBe("[alert] webhook subscription auto-disabled: Acme Inc (acme)");
    expect(body).toContain("auto-disabled after 50 consecutive failures");
    expect(body).toContain("url:        https://acme.example/hooks/releases");
    expect(body).toContain("org:        Acme Inc (acme)");
    expect(body).toContain("last error: 503 Service Unavailable");
    expect(body).toContain("sub id:     whk_1");
    // The old bare "Org ID:" line is gone.
    expect(body).not.toContain("Org ID:");
  });

  it("uses the url in the subject when the org is unresolved", () => {
    const { subject, body } = formatAutoDisableAlert({
      subId: "whk_9",
      url: "https://x.example/h",
      description: null,
      orgName: null,
      orgSlug: null,
      consecutiveFailures: 50,
      lastError: null,
    });
    expect(subject).toBe("[alert] webhook subscription auto-disabled: https://x.example/h");
    expect(body).toContain("last error: unknown");
  });
});
