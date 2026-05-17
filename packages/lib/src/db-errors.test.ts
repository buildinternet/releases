import { describe, it, expect } from "bun:test";
import { classifyDbError } from "./db-errors.js";

describe("classifyDbError", () => {
  it("returns null for non-Error values", () => {
    expect(classifyDbError("nope")).toBeNull();
    expect(classifyDbError(undefined)).toBeNull();
    expect(classifyDbError({ message: "huh" })).toBeNull();
  });

  it("returns null for ordinary Errors with no D1 footprint", () => {
    expect(classifyDbError(new Error("ENOENT"))).toBeNull();
  });

  it("classifies the canonical 'DB is overloaded' message as DB_OVERLOADED + transient", () => {
    const result = classifyDbError(
      new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."),
    );
    expect(result).toEqual({
      code: "DB_OVERLOADED",
      message: "D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
      transient: true,
    });
  });

  it("classifies 'Network connection lost' as DB_NETWORK_LOST + transient", () => {
    const result = classifyDbError(new Error("D1_ERROR: Network connection lost."));
    expect(result?.code).toBe("DB_NETWORK_LOST");
    expect(result?.transient).toBe(true);
  });

  it("classifies storage-reset as DB_STORAGE_RESET + transient", () => {
    const result = classifyDbError(
      new Error("Internal error in D1 DB storage caused object to be reset."),
    );
    expect(result?.code).toBe("DB_STORAGE_RESET");
    expect(result?.transient).toBe(true);
  });

  it("classifies storage timeout as DB_TIMEOUT + transient", () => {
    const result = classifyDbError(
      new Error("D1 DB storage operation exceeded timeout which caused object to be reset."),
    );
    expect(result?.code).toBe("DB_TIMEOUT");
    expect(result?.transient).toBe(true);
  });

  it("classifies the CF internal reference id pattern as DB_INTERNAL + transient", () => {
    // Production messages arrive wrapped — the inner cause is the raw CF
    // string but the outer frame carries the D1_ERROR prefix. The classifier
    // gate requires a D1 footprint somewhere in the chain.
    const inner = new Error("internal error; reference = la49bgmb9rj1uvrqdjjj0ioe");
    const outer = new Error("D1_ERROR: internal error; reference = la49bgmb9rj1uvrqdjjj0ioe", {
      cause: inner,
    });
    const result = classifyDbError(outer);
    expect(result?.code).toBe("DB_INTERNAL");
    expect(result?.transient).toBe(true);
  });

  it("does not misclassify a bare 'Network connection lost' (no D1 footprint) — e.g. a Voyage fetch failure", () => {
    expect(classifyDbError(new Error("Network connection lost."))).toBeNull();
  });

  it("does not misclassify a bare 'internal error; reference =' (no D1 footprint)", () => {
    expect(classifyDbError(new Error("internal error; reference = abc123"))).toBeNull();
  });

  it("classifies 'too many SQL variables' as DB_TOO_MANY_VARIABLES + non-transient", () => {
    const result = classifyDbError(
      new Error("D1_ERROR: too many SQL variables at offset 799: SQLITE_ERROR"),
    );
    expect(result?.code).toBe("DB_TOO_MANY_VARIABLES");
    expect(result?.transient).toBe(false);
  });

  it("walks the cause chain — matches the inner D1 error inside a DrizzleQueryError-style wrapper", () => {
    const inner = new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
    const wrapper = new Error("Failed query: insert into ...", { cause: inner });
    const result = classifyDbError(wrapper);
    expect(result?.code).toBe("DB_OVERLOADED");
    expect(result?.transient).toBe(true);
  });

  it("walks two levels deep (Drizzle → D1_ERROR wrapper → raw cause)", () => {
    const deepest = new Error("Network connection lost.");
    const middle = new Error("D1_ERROR: Network connection lost.", { cause: deepest });
    const outer = new Error("Failed query: insert into ...", { cause: middle });
    const result = classifyDbError(outer);
    expect(result?.code).toBe("DB_NETWORK_LOST");
  });

  it("returns DB_UNKNOWN for a D1_ERROR with an unrecognized message", () => {
    const result = classifyDbError(new Error("D1_ERROR: something brand new"));
    expect(result?.code).toBe("DB_UNKNOWN");
    expect(result?.transient).toBe(false);
  });

  it("does not infinite-loop on circular cause chains", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(() => classifyDbError(a)).not.toThrow();
  });
});
