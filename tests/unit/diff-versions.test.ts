import { describe, expect, it } from "bun:test";
import { diffVersions } from "../../web/src/lib/cadence";

describe("diffVersions", () => {
  it("splits at the dot boundary on a patch bump", () => {
    expect(diffVersions("v2.1.38", "v2.1.141")).toEqual({
      commonPrefix: "v2.1.",
      fromSuffix: "38",
      toSuffix: "141",
    });
  });

  it("keeps the entire numeric segment together (no mid-number split)", () => {
    expect(diffVersions("v1.2.10", "v1.2.18")).toEqual({
      commonPrefix: "v1.2.",
      fromSuffix: "10",
      toSuffix: "18",
    });
  });

  it("treats a minor bump as the first differing segment", () => {
    expect(diffVersions("v1.2.0", "v1.3.0")).toEqual({
      commonPrefix: "v1.",
      fromSuffix: "2.0",
      toSuffix: "3.0",
    });
  });

  it("handles pre-release tags by splitting on the hyphen", () => {
    expect(diffVersions("v1.0.0-beta.1", "v1.0.0-beta.2")).toEqual({
      commonPrefix: "v1.0.0-beta.",
      fromSuffix: "1",
      toSuffix: "2",
    });
  });

  it("collapses when from and to are equal", () => {
    expect(diffVersions("v2.1.141", "v2.1.141")).toEqual({
      commonPrefix: "v2.1.141",
      fromSuffix: "",
      toSuffix: "",
    });
  });

  it("returns full strings as suffixes when nothing shares a prefix", () => {
    expect(diffVersions("alpha", "beta")).toEqual({
      commonPrefix: "",
      fromSuffix: "alpha",
      toSuffix: "beta",
    });
  });
});
