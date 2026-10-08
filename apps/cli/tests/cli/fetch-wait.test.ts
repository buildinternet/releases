import { describe, it, expect } from "bun:test";
import { classifySessionTerminalState } from "../../src/cli/commands/fetch-wait.js";
import { parseWaitSeconds } from "../../src/cli/commands/fetch.js";
import type { Session } from "@buildinternet/releases-api-types";

const baseSession: Session = {
  sessionId: "sess_abc",
  company: "acme",
  type: "update",
  status: "running",
  startedAt: 0,
  lastUpdatedAt: 0,
};

describe("classifySessionTerminalState", () => {
  it("returns null while the session is still running", () => {
    expect(classifySessionTerminalState(baseSession)).toBeNull();
  });

  it("returns exitCode 0 when complete", () => {
    expect(classifySessionTerminalState({ ...baseSession, status: "complete" })).toEqual({
      exitCode: 0,
      status: "complete",
      message: "Session complete",
    });
  });

  it("returns exitCode 130 when cancelled", () => {
    expect(classifySessionTerminalState({ ...baseSession, status: "cancelled" })).toEqual({
      exitCode: 130,
      status: "cancelled",
      message: "Session cancelled",
    });
  });

  it("returns exitCode 1 for our-side errors (no errorSource)", () => {
    const summary = classifySessionTerminalState({
      ...baseSession,
      status: "error",
      error: "Agent completed without calling any tools",
    });
    expect(summary).toEqual({
      exitCode: 1,
      status: "error",
      message: "Agent completed without calling any tools",
    });
  });

  it("returns exitCode 1 when errorSource is explicitly 'us'", () => {
    expect(
      classifySessionTerminalState({
        ...baseSession,
        status: "error",
        error: "Session timed out (no updates received)",
        errorSource: "us",
      })?.exitCode,
    ).toBe(1);
  });

  it("returns exitCode 2 for provider errors and tags errorType", () => {
    const summary = classifySessionTerminalState({
      ...baseSession,
      status: "error",
      error: "An internal service error occurred.",
      errorSource: "provider",
      errorType: "unknown_error",
    });
    expect(summary).toEqual({
      exitCode: 2,
      status: "error",
      message:
        "Provider error (managed-agents · unknown_error): An internal service error occurred.",
    });
  });

  it("includes retry count when the provider stop reason is retries_exhausted", () => {
    const summary = classifySessionTerminalState({
      ...baseSession,
      status: "error",
      error: "An internal service error occurred.",
      errorSource: "provider",
      errorType: "unknown_error",
      stopReason: "retries_exhausted",
      retryCount: 6,
    });
    expect(summary?.message).toBe(
      "Provider error (managed-agents · unknown_error) (after 6 retries): An internal service error occurred.",
    );
  });

  it("falls back gracefully when error metadata is sparse", () => {
    const summary = classifySessionTerminalState({
      ...baseSession,
      status: "error",
      errorSource: "provider",
    });
    expect(summary?.exitCode).toBe(2);
    expect(summary?.message).toBe("Provider error (managed-agents): Session error");
  });
});

describe("parseWaitSeconds", () => {
  it("accepts plain positive integers", () => {
    expect(parseWaitSeconds("60")).toBe(60);
    expect(parseWaitSeconds("1")).toBe(1);
    expect(parseWaitSeconds("900")).toBe(900);
  });

  it("rejects strings with trailing non-digits", () => {
    // parseInt("60s") would return 60 — silent acceptance of malformed input.
    expect(parseWaitSeconds("60s")).toBeNull();
    expect(parseWaitSeconds("1m")).toBeNull();
    expect(parseWaitSeconds("60.5")).toBeNull();
  });

  it("rejects zero, negative numbers, and non-numeric strings", () => {
    expect(parseWaitSeconds("0")).toBeNull();
    expect(parseWaitSeconds("-5")).toBeNull();
    expect(parseWaitSeconds("forever")).toBeNull();
    expect(parseWaitSeconds("")).toBeNull();
  });
});
