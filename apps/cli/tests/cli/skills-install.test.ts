import { describe, it, expect } from "bun:test";
import { buildSkillsArgs, SKILLS_SOURCE } from "../../src/cli/skills/build-args.js";

describe("buildSkillsArgs", () => {
  it("defaults to installing all skills from the GitHub coordinate", () => {
    expect(buildSkillsArgs({})).toEqual(["--yes", "skills", "add", SKILLS_SOURCE, "--yes"]);
  });

  it("uses the buildinternet/releases coordinate", () => {
    expect(SKILLS_SOURCE).toBe("buildinternet/releases");
  });

  it("emits --skill <name> for each positional", () => {
    const args = buildSkillsArgs({ skills: ["releases-mcp", "releases-cli"] });
    expect(args).toContain("--skill");
    expect(args.filter((a) => a === "--skill")).toHaveLength(2);
    const i1 = args.indexOf("--skill");
    expect(args[i1 + 1]).toBe("releases-mcp");
    const i2 = args.indexOf("--skill", i1 + 1);
    expect(args[i2 + 1]).toBe("releases-cli");
  });

  it("includes --yes by default and drops it when yes is explicitly false", () => {
    expect(buildSkillsArgs({}).filter((a) => a === "--yes")).toHaveLength(2); // npx --yes + skills --yes
    expect(buildSkillsArgs({ yes: false }).filter((a) => a === "--yes")).toHaveLength(1); // only npx --yes
  });

  it("forwards --global", () => {
    expect(buildSkillsArgs({ global: true })).toContain("--global");
    expect(buildSkillsArgs({ global: false })).not.toContain("--global");
  });

  it("forwards --agent <name>", () => {
    const args = buildSkillsArgs({ agent: "cursor" });
    const i = args.indexOf("--agent");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("cursor");
  });

  it("forwards --copy and --list", () => {
    expect(buildSkillsArgs({ copy: true })).toContain("--copy");
    expect(buildSkillsArgs({ list: true })).toContain("--list");
  });

  it("appends passthrough args last", () => {
    const args = buildSkillsArgs({ passthrough: ["--something-new", "value"] });
    expect(args.slice(-2)).toEqual(["--something-new", "value"]);
  });

  it("composes flags in a predictable order", () => {
    const args = buildSkillsArgs({
      skills: ["releases-mcp"],
      global: true,
      agent: "cursor",
      copy: true,
    });
    expect(args).toEqual([
      "--yes",
      "skills",
      "add",
      SKILLS_SOURCE,
      "--skill",
      "releases-mcp",
      "--yes",
      "--global",
      "--agent",
      "cursor",
      "--copy",
    ]);
  });
});
