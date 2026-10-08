import { describe, it, expect } from "bun:test";
import {
  validateMessage,
  buildFeedbackPayload,
  resolveTelemetry,
} from "../../src/cli/commands/feedback.js";

describe("validateMessage", () => {
  it("rejects messages shorter than 5 chars", () => {
    const r = validateMessage("hi");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("short");
  });

  it("rejects messages longer than 4000 chars", () => {
    const r = validateMessage("x".repeat(4001));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("long");
  });

  it("trims and accepts a valid message", () => {
    expect(validateMessage("  good feedback here  ")).toEqual({
      ok: true,
      message: "good feedback here",
    });
  });
});

describe("buildFeedbackPayload", () => {
  it("includes enrichment and the message + type + contact", () => {
    const p = buildFeedbackPayload(
      "hello world",
      { type: "bug", contact: "me@x.com" },
      { telemetryEnabled: true, anonId: "anon-1" },
    );
    expect(p.message).toBe("hello world");
    expect(p.type).toBe("bug");
    expect(p.contact).toBe("me@x.com");
    expect(p.surface).toBe("cli");
    expect(p.anonId).toBe("anon-1");
    expect(typeof p.cliVersion).toBe("string");
    expect(typeof p.os).toBe("string");
  });

  it("omits anonId when telemetry is disabled and defaults type to general", () => {
    const p = buildFeedbackPayload(
      "hello world",
      {},
      { telemetryEnabled: false, anonId: "anon-1" },
    );
    expect(p.anonId).toBeUndefined();
    expect(p.type).toBe("general");
  });

  it("coerces an unknown type to general", () => {
    const p = buildFeedbackPayload(
      "hello world",
      { type: "nonsense" },
      { telemetryEnabled: true, anonId: "anon-1" },
    );
    expect(p.type).toBe("general");
  });
});

describe("resolveTelemetry", () => {
  it("does not touch the anon id when telemetry is disabled", () => {
    let called = false;
    const r = resolveTelemetry({
      isEnabled: () => false,
      getAnonId: () => {
        called = true;
        return "anon-1";
      },
    });
    expect(called).toBe(false);
    expect(r.telemetryEnabled).toBe(false);
    expect(r.anonId).toBe("");
  });

  it("resolves the anon id when telemetry is enabled", () => {
    let called = false;
    const r = resolveTelemetry({
      isEnabled: () => true,
      getAnonId: () => {
        called = true;
        return "anon-1";
      },
    });
    expect(called).toBe(true);
    expect(r.telemetryEnabled).toBe(true);
    expect(r.anonId).toBe("anon-1");
  });
});
