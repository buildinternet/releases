import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MARKETING_THRESHOLD,
  MARKETING_THRESHOLD_MAX,
  MARKETING_THRESHOLD_MIN,
  isValidMarketingThreshold,
  parseMarketingClassifierThreshold,
} from "./marketing-classifier-settings.js";

describe("parseMarketingClassifierThreshold", () => {
  it("falls back to the default when unset", () => {
    expect(parseMarketingClassifierThreshold(null)).toBe(DEFAULT_MARKETING_THRESHOLD);
    expect(parseMarketingClassifierThreshold(undefined)).toBe(DEFAULT_MARKETING_THRESHOLD);
    expect(parseMarketingClassifierThreshold("")).toBe(DEFAULT_MARKETING_THRESHOLD);
  });

  it("parses a valid stored value", () => {
    expect(parseMarketingClassifierThreshold(JSON.stringify({ threshold: 0.7 }))).toBe(0.7);
  });

  it("falls back on malformed JSON, never throws", () => {
    expect(parseMarketingClassifierThreshold("not json")).toBe(DEFAULT_MARKETING_THRESHOLD);
    expect(parseMarketingClassifierThreshold("{")).toBe(DEFAULT_MARKETING_THRESHOLD);
  });

  it("falls back when the value is not an object", () => {
    expect(parseMarketingClassifierThreshold("42")).toBe(DEFAULT_MARKETING_THRESHOLD);
    expect(parseMarketingClassifierThreshold("null")).toBe(DEFAULT_MARKETING_THRESHOLD);
    expect(parseMarketingClassifierThreshold("[0.7]")).toBe(DEFAULT_MARKETING_THRESHOLD);
  });

  it("falls back on an out-of-range or non-numeric threshold", () => {
    expect(parseMarketingClassifierThreshold(JSON.stringify({ threshold: 0.49 }))).toBe(
      DEFAULT_MARKETING_THRESHOLD,
    );
    expect(parseMarketingClassifierThreshold(JSON.stringify({ threshold: 1 }))).toBe(
      DEFAULT_MARKETING_THRESHOLD,
    );
    expect(parseMarketingClassifierThreshold(JSON.stringify({ threshold: "0.7" }))).toBe(
      DEFAULT_MARKETING_THRESHOLD,
    );
    expect(parseMarketingClassifierThreshold(JSON.stringify({ threshold: NaN }))).toBe(
      DEFAULT_MARKETING_THRESHOLD,
    );
  });

  it("accepts the boundary values", () => {
    expect(
      parseMarketingClassifierThreshold(JSON.stringify({ threshold: MARKETING_THRESHOLD_MIN })),
    ).toBe(MARKETING_THRESHOLD_MIN);
    expect(
      parseMarketingClassifierThreshold(JSON.stringify({ threshold: MARKETING_THRESHOLD_MAX })),
    ).toBe(MARKETING_THRESHOLD_MAX);
  });
});

describe("isValidMarketingThreshold", () => {
  it("accepts values in [0.5, 0.99]", () => {
    expect(isValidMarketingThreshold(0.5)).toBe(true);
    expect(isValidMarketingThreshold(0.99)).toBe(true);
    expect(isValidMarketingThreshold(0.75)).toBe(true);
  });

  it("rejects out-of-range or non-numeric values", () => {
    expect(isValidMarketingThreshold(0.49)).toBe(false);
    expect(isValidMarketingThreshold(1)).toBe(false);
    expect(isValidMarketingThreshold(NaN)).toBe(false);
    expect(isValidMarketingThreshold("0.7")).toBe(false);
  });
});
