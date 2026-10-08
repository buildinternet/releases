import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * #237 — surface coverage: the create command exposes the metadata flags that
 * make feed filters atomic at create time. Behavioral coverage (the flags land
 * in the create POST body) lives in tests/unit/create-metadata.test.ts.
 */
describe("source create metadata flags (--help surface)", () => {
  it("exposes --keyword-allow and --metadata-set on source create --help", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--keyword-allow");
    expect(stdout).toContain("--metadata-set");
  });
});
