import { describe, expect, test } from "bun:test";
import { breakingChipLabel } from "./breaking-chip";

// Level → label/visibility mapping for the breaking chip (#1710). The chip
// must render NOTHING for `none`/`unknown`/absent — `unknown` is the fail-open
// default on every unclassified/legacy row, so a chip there would be noise.
describe("breakingChipLabel", () => {
  test("major renders 'Breaking'", () => {
    expect(breakingChipLabel("major")).toBe("Breaking");
  });

  test("minor renders 'Breaking (minor)'", () => {
    expect(breakingChipLabel("minor")).toBe("Breaking (minor)");
  });

  test("none / unknown / absent render nothing", () => {
    expect(breakingChipLabel("none")).toBeNull();
    expect(breakingChipLabel("unknown")).toBeNull();
    expect(breakingChipLabel(null)).toBeNull();
    expect(breakingChipLabel(undefined)).toBeNull();
  });

  test("an unrecognized level renders nothing (never invents a chip)", () => {
    expect(breakingChipLabel("catastrophic")).toBeNull();
    expect(breakingChipLabel("")).toBeNull();
  });
});
