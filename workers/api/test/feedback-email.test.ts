import { describe, it, expect } from "bun:test";
import { formatFeedbackEmail, withinNotifyBudget } from "../src/lib/feedback-email.js";
import type { Feedback } from "@buildinternet/releases-core/schema";

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    store,
  };
}

const base: Feedback = {
  id: "fb_123",
  createdAt: 1_700_000_000_000,
  message: "search ranking feels off for scoped queries",
  contact: null,
  type: "general",
  status: "new",
  cliVersion: "0.43.0",
  clientKind: "external",
  anonId: null,
  os: "darwin",
  arch: "arm64",
  runtime: "bun-1.3.13",
  surface: "cli",
};

describe("formatFeedbackEmail", () => {
  it("prefixes the subject with [feedback] and the type", () => {
    const { subject } = formatFeedbackEmail(base);
    expect(subject.startsWith("[feedback] general:")).toBe(true);
    expect(subject).toContain("search ranking feels off");
  });

  it("truncates long messages in the subject", () => {
    const { subject } = formatFeedbackEmail({ ...base, message: "x".repeat(200) });
    expect(subject.length).toBeLessThan(120);
  });

  it("renders contact as (none) when absent and includes the id + message", () => {
    const { text } = formatFeedbackEmail(base);
    expect(text).toContain("Contact: (none)");
    expect(text).toContain("fb_123");
    expect(text).toContain(base.message);
  });

  it("includes the contact when present", () => {
    const { text } = formatFeedbackEmail({ ...base, contact: "zach@example.com" });
    expect(text).toContain("Contact: zach@example.com");
  });
});

describe("withinNotifyBudget", () => {
  it("allows and increments when under the hourly cap", async () => {
    const kv = fakeKv();
    expect(await withinNotifyBudget(kv, 2)).toBe(true);
    expect(await withinNotifyBudget(kv, 2)).toBe(true);
  });

  it("blocks once the cap is reached", async () => {
    const kv = fakeKv();
    expect(await withinNotifyBudget(kv, 2)).toBe(true);
    expect(await withinNotifyBudget(kv, 2)).toBe(true);
    expect(await withinNotifyBudget(kv, 2)).toBe(false);
  });

  it("fails open when no KV is available", async () => {
    expect(await withinNotifyBudget(undefined, 2)).toBe(true);
  });
});
