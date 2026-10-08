import { describe, it, expect, spyOn } from "bun:test";
import {
  parsePositiveIntFlag,
  parseNonNegIntFlag,
  parseMaxContentCharsFlag,
  MAX_CONTENT_CHARS_DEFAULT,
  coerceMetadataValue,
  parseMetadataSetFlag,
  parseTimeWindowFlag,
  parseImportanceFlag,
} from "../../src/lib/flags.js";

// Intercept process.exit so invalid-input tests don't kill the runner.
function withExitTrap(fn: () => void): void {
  const spy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("parsePositiveIntFlag", () => {
  it("returns undefined when the flag is not supplied", () => {
    expect(parsePositiveIntFlag("limit", undefined)).toBeUndefined();
  });

  it("accepts a plain positive integer string", () => {
    expect(parsePositiveIntFlag("limit", "1")).toBe(1);
    expect(parsePositiveIntFlag("limit", "100")).toBe(100);
  });

  it("rejects a decimal string (1.5 must not silently become 1)", () => {
    withExitTrap(() => {
      expect(() => parsePositiveIntFlag("limit", "1.5")).toThrow("process.exit called");
    });
  });

  it("rejects a string with trailing non-digit chars (10abc must not become 10)", () => {
    withExitTrap(() => {
      expect(() => parsePositiveIntFlag("limit", "10abc")).toThrow("process.exit called");
    });
  });

  it("rejects zero", () => {
    withExitTrap(() => {
      expect(() => parsePositiveIntFlag("limit", "0")).toThrow("process.exit called");
    });
  });

  it("rejects a negative integer", () => {
    withExitTrap(() => {
      expect(() => parsePositiveIntFlag("limit", "-1")).toThrow("process.exit called");
    });
  });

  it("rejects a non-numeric string", () => {
    withExitTrap(() => {
      expect(() => parsePositiveIntFlag("limit", "abc")).toThrow("process.exit called");
    });
  });
});

describe("parseNonNegIntFlag", () => {
  it("returns undefined when the flag is not supplied", () => {
    expect(parseNonNegIntFlag("offset", undefined)).toBeUndefined();
  });

  it("accepts zero", () => {
    expect(parseNonNegIntFlag("offset", "0")).toBe(0);
  });

  it("accepts a plain positive integer string", () => {
    expect(parseNonNegIntFlag("offset", "42")).toBe(42);
  });

  it("rejects a decimal string (1.5 must not silently become 1)", () => {
    withExitTrap(() => {
      expect(() => parseNonNegIntFlag("offset", "1.5")).toThrow("process.exit called");
    });
  });

  it("rejects a string with trailing non-digit chars (10abc must not become 10)", () => {
    withExitTrap(() => {
      expect(() => parseNonNegIntFlag("offset", "10abc")).toThrow("process.exit called");
    });
  });

  it("rejects a negative integer", () => {
    withExitTrap(() => {
      expect(() => parseNonNegIntFlag("offset", "-1")).toThrow("process.exit called");
    });
  });
});

describe("parseMaxContentCharsFlag", () => {
  it("returns undefined when the flag is omitted", () => {
    expect(parseMaxContentCharsFlag(undefined)).toBeUndefined();
  });

  it("treats false (optional-value not present, no bare) as omitted", () => {
    expect(parseMaxContentCharsFlag(false)).toBeUndefined();
  });

  it("uses the bare default when passed without a value (true)", () => {
    expect(parseMaxContentCharsFlag(true)).toBe(MAX_CONTENT_CHARS_DEFAULT);
  });

  it("parses an explicit positive integer string", () => {
    expect(parseMaxContentCharsFlag("500")).toBe(500);
  });

  it("rejects zero", () => {
    withExitTrap(() => {
      expect(() => parseMaxContentCharsFlag("0")).toThrow("process.exit called");
    });
  });

  it("rejects a decimal string", () => {
    withExitTrap(() => {
      expect(() => parseMaxContentCharsFlag("1.5")).toThrow("process.exit called");
    });
  });
});

// ---------------------------------------------------------------------------
// coerceMetadataValue — value-type coercion for --metadata-set
// ---------------------------------------------------------------------------

describe("coerceMetadataValue", () => {
  it("coerces 'true' to boolean true", () => {
    expect(coerceMetadataValue("true")).toBe(true);
  });

  it("coerces 'false' to boolean false", () => {
    expect(coerceMetadataValue("false")).toBe(false);
  });

  it("false is not treated as falsy — it is the boolean value false, not undefined/null", () => {
    const result = coerceMetadataValue("false");
    expect(result).toBe(false);
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it("coerces 'null' to null", () => {
    expect(coerceMetadataValue("null")).toBeNull();
  });

  it("coerces a positive integer string to a number", () => {
    expect(coerceMetadataValue("42")).toBe(42);
  });

  it("coerces '0' to the number 0, not falsy-undefined", () => {
    const result = coerceMetadataValue("0");
    expect(result).toBe(0);
    expect(typeof result).toBe("number");
  });

  it("coerces a negative integer string to a number", () => {
    expect(coerceMetadataValue("-7")).toBe(-7);
  });

  it("coerces a decimal string to a number", () => {
    expect(coerceMetadataValue("3.14")).toBeCloseTo(3.14);
  });

  it("coerces a JSON object string to an object", () => {
    expect(coerceMetadataValue('{"foo":"bar"}')).toEqual({ foo: "bar" });
  });

  it("coerces a JSON array string to an array", () => {
    expect(coerceMetadataValue("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("treats a plain URL string as a string (not a number, not JSON)", () => {
    const url = "https://github.com/docker/compose";
    expect(coerceMetadataValue(url)).toBe(url);
  });

  it("treats a plain path string as a string", () => {
    const path = "/docs/latest/operate/rs/release-notes/";
    expect(coerceMetadataValue(path)).toBe(path);
  });

  it("treats an arbitrary string as a string", () => {
    expect(coerceMetadataValue("hello world")).toBe("hello world");
  });

  it("exits on invalid JSON starting with {", () => {
    withExitTrap(() => {
      expect(() => coerceMetadataValue("{not valid json}")).toThrow("process.exit called");
    });
  });

  it("exits on invalid JSON starting with [", () => {
    withExitTrap(() => {
      expect(() => coerceMetadataValue("[1,2,")).toThrow("process.exit called");
    });
  });
});

// ---------------------------------------------------------------------------
// parseMetadataSetFlag — full key=value parsing
// ---------------------------------------------------------------------------

describe("parseMetadataSetFlag", () => {
  it("parses a simple string value", () => {
    expect(parseMetadataSetFlag("myKey=hello")).toEqual(["myKey", "hello"]);
  });

  it("parses a boolean true value", () => {
    expect(parseMetadataSetFlag("crawlEnabled=true")).toEqual(["crawlEnabled", true]);
  });

  it("parses a boolean false value", () => {
    expect(parseMetadataSetFlag("renderRequired=false")).toEqual(["renderRequired", false]);
  });

  it("parses a numeric value", () => {
    expect(parseMetadataSetFlag("maxItems=20")).toEqual(["maxItems", 20]);
  });

  it("parses a URL value as a string", () => {
    const token = "githubUrl=https://github.com/docker/compose";
    const [key, value] = parseMetadataSetFlag(token);
    expect(key).toBe("githubUrl");
    expect(value).toBe("https://github.com/docker/compose");
  });

  it("splits only on the first '=' so values containing '=' are preserved", () => {
    const token = "redirectUrl=https://example.com?a=1&b=2";
    const [key, value] = parseMetadataSetFlag(token);
    expect(key).toBe("redirectUrl");
    expect(value).toBe("https://example.com?a=1&b=2");
  });

  it("parses a JSON object value", () => {
    const [key, value] = parseMetadataSetFlag('config={"timeout":30}');
    expect(key).toBe("config");
    expect(value).toEqual({ timeout: 30 });
  });

  it("exits when no '=' is present", () => {
    withExitTrap(() => {
      expect(() => parseMetadataSetFlag("noequals")).toThrow("process.exit called");
    });
  });

  it("exits when the key is empty (starts with '=')", () => {
    withExitTrap(() => {
      expect(() => parseMetadataSetFlag("=value")).toThrow("process.exit called");
    });
  });

  it("exits when the key contains '.'", () => {
    withExitTrap(() => {
      expect(() => parseMetadataSetFlag("foo.bar=value")).toThrow("process.exit called");
    });
  });

  it("exits when the key contains '['", () => {
    withExitTrap(() => {
      expect(() => parseMetadataSetFlag("foo[0]=value")).toThrow("process.exit called");
    });
  });
});

describe("parseTimeWindowFlag", () => {
  it("returns undefined when the flag is not supplied", () => {
    expect(parseTimeWindowFlag("since", undefined)).toBeUndefined();
  });

  it("forwards an ISO date verbatim (trimmed)", () => {
    expect(parseTimeWindowFlag("since", "2026-01-01")).toBe("2026-01-01");
    expect(parseTimeWindowFlag("since", "  2026-01-01T12:30:00Z ")).toBe("2026-01-01T12:30:00Z");
  });

  it("forwards relative shorthand verbatim (resolved server-side)", () => {
    expect(parseTimeWindowFlag("since", "90d")).toBe("90d");
    expect(parseTimeWindowFlag("since", "4w")).toBe("4w");
    expect(parseTimeWindowFlag("since", "6M")).toBe("6M");
    expect(parseTimeWindowFlag("until", "2y")).toBe("2y");
  });

  it("rejects a bare number (ambiguous — neither date nor shorthand)", () => {
    withExitTrap(() => {
      expect(() => parseTimeWindowFlag("since", "90")).toThrow("process.exit called");
    });
  });

  it("rejects an unknown unit", () => {
    withExitTrap(() => {
      expect(() => parseTimeWindowFlag("since", "90x")).toThrow("process.exit called");
    });
  });

  it("rejects unparseable garbage", () => {
    withExitTrap(() => {
      expect(() => parseTimeWindowFlag("until", "not-a-date")).toThrow("process.exit called");
    });
  });

  it("rejects a datetime without a timezone (server would parse it as local time)", () => {
    withExitTrap(() => {
      expect(() => parseTimeWindowFlag("since", "2026-01-01T12:30:00")).toThrow(
        "process.exit called",
      );
    });
  });

  it("rejects an impossible calendar date instead of rolling it over", () => {
    withExitTrap(() => {
      expect(() => parseTimeWindowFlag("until", "2026-02-30")).toThrow("process.exit called");
      expect(() => parseTimeWindowFlag("since", "2026-02-29")).toThrow("process.exit called");
    });
  });

  it("accepts a leap day in a leap year", () => {
    expect(parseTimeWindowFlag("since", "2028-02-29")).toBe("2028-02-29");
  });

  it("accepts a timezone offset", () => {
    expect(parseTimeWindowFlag("since", "2026-01-01T12:30:00+05:00")).toBe(
      "2026-01-01T12:30:00+05:00",
    );
  });
});

describe("parseImportanceFlag", () => {
  it("returns undefined when the flag is not supplied", () => {
    expect(parseImportanceFlag(undefined)).toBeUndefined();
  });

  it("accepts every integer in the 1–5 range", () => {
    expect(parseImportanceFlag("1")).toBe(1);
    expect(parseImportanceFlag("2")).toBe(2);
    expect(parseImportanceFlag("3")).toBe(3);
    expect(parseImportanceFlag("4")).toBe(4);
    expect(parseImportanceFlag("5")).toBe(5);
  });

  it("rejects 0 (below the range)", () => {
    withExitTrap(() => {
      expect(() => parseImportanceFlag("0")).toThrow("process.exit called");
    });
  });

  it("rejects 6 (above the range)", () => {
    withExitTrap(() => {
      expect(() => parseImportanceFlag("6")).toThrow("process.exit called");
    });
  });

  it("rejects a non-integer decimal", () => {
    withExitTrap(() => {
      expect(() => parseImportanceFlag("3.5")).toThrow("process.exit called");
    });
  });

  it("rejects a non-numeric string", () => {
    withExitTrap(() => {
      expect(() => parseImportanceFlag("abc")).toThrow("process.exit called");
    });
  });

  it("rejects a negative integer", () => {
    withExitTrap(() => {
      expect(() => parseImportanceFlag("-1")).toThrow("process.exit called");
    });
  });

  it("rejects a string with trailing non-digit chars (4abc must not become 4)", () => {
    withExitTrap(() => {
      expect(() => parseImportanceFlag("4abc")).toThrow("process.exit called");
    });
  });
});
