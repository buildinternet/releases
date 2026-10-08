import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";
import { selectOrgFetchSources } from "../../src/cli/commands/fetch.js";

/**
 * #307 — `source fetch <identifier> --org <org>` used to silently drop the
 * positional identifier and fan out a managed-agent session over every active
 * source in the org. The conflict must error out before any API call, in the
 * same style as `latest`'s "--product can't be combined with a [source]
 * argument or --org." rejection.
 */
describe("source fetch identifier/--org conflict (#307)", () => {
  it("rejects a positional identifier combined with --org", () => {
    const { exitCode, stderr } = runCli([
      "admin",
      "source",
      "fetch",
      "releases-cli",
      "--org",
      "releases-sh",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("can't be combined with --org");
  });

  it("rejects --source combined with --org", () => {
    const { exitCode, stderr } = runCli([
      "admin",
      "source",
      "fetch",
      "--source",
      "releases-cli",
      "--org",
      "releases-sh",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("can't be combined with --org");
  });

  it("rejects a positional identifier combined with --source", () => {
    const { exitCode, stderr } = runCli([
      "admin",
      "source",
      "fetch",
      "releases-cli",
      "--source",
      "other-source",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("not both");
  });

  it("keeps the --local-specific conflict message for --local + --org", () => {
    const { exitCode, stderr } = runCli([
      "admin",
      "source",
      "fetch",
      "my-source",
      "--local",
      "--org",
      "acme",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--local");
    expect(stderr).toContain("--org");
  });
});

/**
 * #307 bonus — the `--org` fan-out must skip push-only `agent` sources (no
 * fetch adapter; releases are POSTed to them, never pulled), alongside the
 * existing hidden/paused exclusions.
 */
const src = (over: Partial<Parameters<typeof selectOrgFetchSources>[0][number]>) => ({
  isHidden: false,
  fetchPriority: "normal",
  type: "scrape",
  ...over,
});

describe("selectOrgFetchSources", () => {
  it("excludes hidden and paused sources without counting them as agent skips", () => {
    const { fetchable, skippedAgents } = selectOrgFetchSources([
      src({}),
      src({ isHidden: true }),
      src({ fetchPriority: "paused" }),
    ]);
    expect(fetchable).toHaveLength(1);
    expect(skippedAgents).toBe(0);
  });

  it("skips push-only agent sources and reports the count", () => {
    const { fetchable, skippedAgents } = selectOrgFetchSources([
      src({ type: "github" }),
      src({ type: "agent" }),
      src({ type: "feed" }),
    ]);
    expect(fetchable.map((s) => s.type)).toEqual(["github", "feed"]);
    expect(skippedAgents).toBe(1);
  });

  it("does not count a hidden or paused agent source twice", () => {
    const { fetchable, skippedAgents } = selectOrgFetchSources([
      src({ type: "agent", isHidden: true }),
      src({ type: "agent", fetchPriority: "paused" }),
    ]);
    expect(fetchable).toHaveLength(0);
    expect(skippedAgents).toBe(0);
  });
});
