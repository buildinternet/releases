import { describe, it, expect } from "bun:test";
import { formatFeedbackEmail } from "../src/lib/feedback-email.js";
import type { Feedback } from "@buildinternet/releases-core/schema";

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
