import { describe, it, expect, mock } from "bun:test";
import { writeJson, writeJsonLine } from "../../src/lib/output";

type WriteFn = typeof process.stdout.write;
type OnceFn = typeof process.stdout.once;

/**
 * Mock `process.stdout.write` to simulate pipe backpressure:
 * first call returns false to signal buffer is full, then emit 'drain'
 * when `once('drain', cb)` is registered.
 */
function mockBackpressure() {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalOnce = process.stdout.once.bind(process.stdout);

  let drainHandler: (() => void) | null = null;
  let drained = false;

  process.stdout.write = mock((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return false;
  }) as unknown as WriteFn;

  process.stdout.once = mock((event: string, cb: () => void) => {
    if (event === "drain") {
      drainHandler = cb;
      setImmediate(() => {
        drained = true;
        drainHandler?.();
      });
    }
    return process.stdout;
  }) as unknown as OnceFn;

  return {
    chunks,
    get drained() {
      return drained;
    },
    restore: () => {
      process.stdout.write = originalWrite;
      process.stdout.once = originalOnce;
    },
  };
}

describe("writeJson", () => {
  it("writes pretty-printed JSON with a trailing newline", async () => {
    const bp = mockBackpressure();
    try {
      await writeJson({ a: 1, b: [2, 3] });
      expect(bp.chunks.join("")).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
    } finally {
      bp.restore();
    }
  });

  it("awaits drain when stdout signals backpressure", async () => {
    const bp = mockBackpressure();
    try {
      await writeJson({ big: "x".repeat(100) });
      expect(bp.drained).toBe(true);
    } finally {
      bp.restore();
    }
  });
});

describe("writeJsonLine", () => {
  it("writes compact JSON with a trailing newline", async () => {
    const bp = mockBackpressure();
    try {
      await writeJsonLine({ a: 1, b: 2 });
      expect(bp.chunks.join("")).toBe('{"a":1,"b":2}\n');
    } finally {
      bp.restore();
    }
  });

  it("awaits drain when stdout signals backpressure", async () => {
    const bp = mockBackpressure();
    try {
      await writeJsonLine({ big: "x".repeat(100) });
      expect(bp.drained).toBe(true);
    } finally {
      bp.restore();
    }
  });
});

describe("integration: large payloads write completely", () => {
  it("emits ~300 KB of JSON without truncation when stdout applies backpressure", async () => {
    const bp = mockBackpressure();
    try {
      // Build a ~200 KB fixture — larger than the 96 KB pipe buffer that causes
      // the real-world truncation, ensuring the drain path is exercised.
      const payload = Array.from({ length: 800 }, (_, i) => ({
        id: `rel_${i.toString().padStart(6, "0")}`,
        title: `Release ${i}`,
        body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4),
      }));
      const expected = JSON.stringify(payload, null, 2) + "\n";
      expect(expected.length).toBeGreaterThan(150_000);

      await writeJson(payload);
      const written = bp.chunks.join("");
      expect(written.length).toBe(expected.length);
      expect(written).toBe(expected);
    } finally {
      bp.restore();
    }
  });
});
