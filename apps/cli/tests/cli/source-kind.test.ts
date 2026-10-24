import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Coverage for the `--kind` flag added in Phase B of the source-kind enum
 * (issue #1080). Writes (`admin source update`, `admin product update`,
 * `admin product create`) and reads (`list`, `admin product list`, `search`)
 * each accept `--kind <value>`. The behavior the CLI is responsible for is
 * local validation against KIND_VALUES — wire-level filter behavior is
 * covered in the API + MCP test suites.
 *
 * Flag registration on every command is covered by
 * tests/unit/command-surface.test.ts; behavioral rejection is verified here
 * on the two read commands that validate `--kind` before any API call.
 */

describe("--kind validation", () => {
  it("list rejects unknown kind before any API call", () => {
    const { stderr, exitCode } = runCli(["list", "--kind", "nope"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid kind "nope"');
    expect(stderr).toContain("platform, sdk, mobile, desktop, docs, integration, tool");
  });

  it("search rejects unknown kind before any API call", () => {
    const { stderr, exitCode } = runCli(["search", "anything", "--kind", "nope"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid --kind value: "nope"');
    expect(stderr).toContain("platform, sdk, mobile, desktop, docs, integration, tool");
  });

  it("list accepts a valid kind through flag parsing (network call may fail; flag parse must not)", () => {
    // We can't assert on API response (tests run against a fake URL) but we
    // can confirm `--kind sdk` doesn't trip the local validator the way
    // `--kind nope` does. Failure here would surface as "Invalid kind …" on
    // stderr, which the negative test above guards.
    const { stderr } = runCli(["list", "--kind", "sdk"]);
    expect(stderr).not.toContain('Invalid kind "sdk"');
  });
});
