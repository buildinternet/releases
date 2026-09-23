import { describe, expect, it } from "bun:test";
import { buildAgentPrompt, SKILL_INSTALL_CMD } from "./agent-prompt";

describe("buildAgentPrompt", () => {
  it("points agents at the creating-releases-json skill", () => {
    const prompt = buildAgentPrompt("acme.com");
    expect(prompt).toContain("creating-releases-json");
    expect(prompt).toContain(SKILL_INSTALL_CMD);
    expect(prompt).toContain("Our website is: acme.com");
    expect(prompt).toContain("never invent");
  });

  it("uses a placeholder when no domain is typed yet", () => {
    expect(buildAgentPrompt()).toContain("Our website is: <your website or domain>");
    expect(buildAgentPrompt("   ")).toContain("Our website is: <your website or domain>");
  });
});
