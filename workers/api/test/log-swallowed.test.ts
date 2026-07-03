import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { logSwallowed } from "../src/lib/log-swallowed.js";

describe("logSwallowed", () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  it("returns undefined and does not throw for an Error input", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = logSwallowed("test-comp", "test-event", { sourceSlug: "x" });

    let result: unknown;
    expect(() => {
      result = handler(new Error("boom"));
    }).not.toThrow();
    expect(result).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy!.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.component).toBe("test-comp");
    expect(parsed.event).toBe("test-event");
    expect(parsed.sourceSlug).toBe("x");
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toBe("boom");
  });

  it("returns undefined and does not throw for a string input", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = logSwallowed("test-comp", "test-event", { sourceSlug: "y" });

    let result: unknown;
    expect(() => {
      result = handler("transient failure");
    }).not.toThrow();
    expect(result).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy!.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.component).toBe("test-comp");
    expect(parsed.event).toBe("test-event");
    expect(parsed.sourceSlug).toBe("y");
    expect(parsed.error).toBe("transient failure");
  });

  it("works with no context provided", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = logSwallowed("test-comp", "test-event");

    const result = handler(new Error("no context"));
    expect(result).toBeUndefined();

    const line = warnSpy!.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.component).toBe("test-comp");
    expect(parsed.event).toBe("test-event");
    expect(parsed.error.message).toBe("no context");
  });
});
