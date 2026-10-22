import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger.js";

describe("logger runtime dispatch", () => {
  let logSpy: ReturnType<typeof mock>;
  let errorSpy: ReturnType<typeof mock>;
  let debugSpy: ReturnType<typeof mock>;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalDebug: typeof console.debug;
  let originalNavigator: PropertyDescriptor | undefined;
  let originalCaches: PropertyDescriptor | undefined;
  let logDir: string;

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
    originalDebug = console.debug;
    logSpy = mock(() => {});
    errorSpy = mock(() => {});
    debugSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    console.error = errorSpy as unknown as typeof console.error;
    console.debug = debugSpy as unknown as typeof console.debug;
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
    logDir = mkdtempSync(join(tmpdir(), "releases-logs-"));
    process.env.RELEASES_DATA_DIR = logDir;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.debug = originalDebug;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else delete (globalThis as { caches?: unknown }).caches;
    delete process.env.RELEASES_DATA_DIR;
    rmSync(logDir, { recursive: true, force: true });
  });

  function setNavigator(userAgent: string) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent },
      configurable: true,
    });
  }

  function clearCaches() {
    delete (globalThis as { caches?: unknown }).caches;
  }

  it("sends info to console.log when navigator reports Cloudflare-Workers", () => {
    clearCaches();
    setNavigator("Cloudflare-Workers");
    logger.info("feed detected");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect((logSpy.mock.calls[0] as unknown[])[0]).toBe("[releases]");
  });

  it("sends info to console.log when only caches.default is present (workflow isolate)", () => {
    setNavigator("Node.js/22.0.0");
    Object.defineProperty(globalThis, "caches", {
      value: { default: {} },
      configurable: true,
    });
    logger.info("feed detected");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("sends info to stderr outside a worker", () => {
    clearCaches();
    setNavigator("Node.js/22.0.0");
    logger.info("cli line");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("sends debug to console.debug in a worker and stays quiet outside one", () => {
    const prev = process.env.DEBUG;
    delete process.env.DEBUG;
    clearCaches();
    setNavigator("Node.js/22.0.0");
    logger.debug("hidden");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    setNavigator("Cloudflare-Workers");
    logger.debug("visible");
    expect(debugSpy).toHaveBeenCalledTimes(1);
    if (prev === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = prev;
  });
});
