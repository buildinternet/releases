import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { logEvent } from "./log-event.js";

describe("logEvent", () => {
  let logSpy: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof mock>;
  let errorSpy: ReturnType<typeof mock>;
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    logSpy = mock(() => {});
    warnSpy = mock(() => {});
    errorSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    console.warn = warnSpy as unknown as typeof console.warn;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it("routes info to console.log", () => {
    logEvent("info", { component: "x", event: "y" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("routes warn to console.warn", () => {
    logEvent("warn", { component: "x", event: "y" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("routes error to console.error", () => {
    logEvent("error", { component: "x", event: "y" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("emits a JSON-parseable line with component and event as top-level keys", () => {
    logEvent("info", {
      component: "poll-fetch-workflow",
      event: "no-change-detected",
      sourceSlug: "vercel/next.js",
    });
    const arg = (logSpy.mock.calls[0] as unknown[])[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed).toEqual({
      component: "poll-fetch-workflow",
      event: "no-change-detected",
      sourceSlug: "vercel/next.js",
    });
  });

  it("unwraps Error instances so name/message/stack survive JSON.stringify", () => {
    const err = new Error("boom");
    logEvent("error", { component: "search-log", event: "insert-failed", err });
    const arg = (errorSpy.mock.calls[0] as unknown[])[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.err.name).toBe("Error");
    expect(parsed.err.message).toBe("boom");
    expect(typeof parsed.err.stack).toBe("string");
  });

  it("preserves Error.cause when present", () => {
    const cause = new Error("root");
    const err = new Error("wrapper", { cause });
    logEvent("error", { component: "x", event: "y", err });
    const arg = (errorSpy.mock.calls[0] as unknown[])[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.err.cause).toBeDefined();
    expect((parsed.err.cause as { message: string }).message).toBe("root");
  });

  it("omits cause when not set on the Error", () => {
    const err = new Error("solo");
    logEvent("error", { component: "x", event: "y", err });
    const arg = (errorSpy.mock.calls[0] as unknown[])[0] as string;
    const parsed = JSON.parse(arg);
    expect("cause" in parsed.err).toBe(false);
  });

  it("fails open on circular references — emits a serialization-failed marker", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logEvent("error", {
      component: "search-log",
      event: "insert-failed",
      ctx: circular,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const arg = (errorSpy.mock.calls[0] as unknown[])[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.component).toBe("search-log");
    expect(parsed.event).toBe("log-serialization-failed");
    expect(parsed.originalEvent).toBe("insert-failed");
    expect(parsed.err).toBeDefined();
  });

  it("fails open on BigInt — emits a serialization-failed marker", () => {
    logEvent("info", {
      component: "x",
      event: "y",
      big: BigInt(1) as unknown,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = (logSpy.mock.calls[0] as unknown[])[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.event).toBe("log-serialization-failed");
    expect(parsed.originalEvent).toBe("y");
  });
});
