import { describe, it, expect } from "bun:test";
import { resolveFetchUrlUpdate } from "../../src/cli/commands/edit.js";

describe("resolveFetchUrlUpdate", () => {
  it("is a no-op when --fetch-url is not passed", () => {
    expect(resolveFetchUrlUpdate({})).toEqual({ action: "none" });
  });

  it("removes the fetch URL when --no-fetch-url is passed (fetchUrl=false)", () => {
    expect(resolveFetchUrlUpdate({ fetchUrl: false })).toEqual({ action: "remove" });
  });

  it("sets the fetch URL when a string is provided", () => {
    expect(resolveFetchUrlUpdate({ fetchUrl: "https://example.com/data.json" })).toEqual({
      action: "set",
      fetchUrl: "https://example.com/data.json",
    });
  });

  it("treats undefined as no-op (commander default)", () => {
    expect(resolveFetchUrlUpdate({ fetchUrl: undefined })).toEqual({ action: "none" });
  });
});
