import { describe, expect, it } from "bun:test";
import {
  isHexColor,
  readableTextColor,
  SITE_NOTICE_KEY,
  DEFAULT_SITE_NOTICE_COLOR,
} from "./site-notice";

describe("isHexColor", () => {
  it("accepts 6-digit hex with hash", () => {
    expect(isHexColor("#0081e7")).toBe(true);
    expect(isHexColor("#FFFFFF")).toBe(true);
  });
  it("rejects shorthand, missing hash, and junk", () => {
    expect(isHexColor("#fff")).toBe(false);
    expect(isHexColor("0081e7")).toBe(false);
    expect(isHexColor("blue")).toBe(false);
    expect(isHexColor("#0081e7 ")).toBe(false);
  });
});

describe("readableTextColor", () => {
  it("returns dark text on light backgrounds", () => {
    expect(readableTextColor("#ffffff")).toBe("#0c0a09");
    expect(readableTextColor("#fde047")).toBe("#0c0a09"); // amber-300
  });
  it("returns light text on dark backgrounds", () => {
    expect(readableTextColor("#0c0a09")).toBe("#ffffff");
    expect(readableTextColor("#0081e7")).toBe("#ffffff"); // brand blue
  });
  it("falls back to light text on an invalid color", () => {
    expect(readableTextColor("not-a-color")).toBe("#ffffff");
  });
});

describe("constants", () => {
  it("exposes the storage key and default color", () => {
    expect(SITE_NOTICE_KEY).toBe("site_notice");
    expect(DEFAULT_SITE_NOTICE_COLOR).toBe("#0081e7");
  });
});
