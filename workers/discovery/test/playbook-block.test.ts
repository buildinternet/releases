import { describe, expect, it } from "bun:test";

import { buildPlaybookMarkdown } from "../src/playbook-block.js";

describe("buildPlaybookMarkdown", () => {
  it("tiers header (ground truth) above demoted notes with an age cue", () => {
    const md = buildPlaybookMarkdown({
      content: "# Acme\n\n## Sources\n\n- feed: https://acme.dev/changelog.xml",
      notes: "### Traps\n\nThe RSS feed drops entries older than 30 days.",
      updatedAt: "2026-04-11T12:00:00Z",
    });
    expect(md).toContain("# Acme");
    expect(md).toContain("## Prior observations (unverified — last written Apr 11)");
    expect(md).toContain("hypotheses");
    // Header comes first, demoted notes after.
    expect(md!.indexOf("# Acme")).toBeLessThan(md!.indexOf("Prior observations"));
  });

  it("omits the age cue when updatedAt is absent", () => {
    const md = buildPlaybookMarkdown({ content: "# Acme", notes: "note", updatedAt: null });
    expect(md).toContain("## Prior observations (unverified)");
  });

  it("returns the header alone when there are no notes", () => {
    const md = buildPlaybookMarkdown({ content: "# Acme", notes: null });
    expect(md).toBe("# Acme");
    expect(md).not.toContain("Prior observations");
  });

  it("still demotes notes when there is no header", () => {
    const md = buildPlaybookMarkdown({ content: "", notes: "orphan note" });
    expect(md).toContain("## Prior observations (unverified)");
    expect(md).toContain("orphan note");
  });

  it("returns null when the page has neither header nor notes", () => {
    expect(buildPlaybookMarkdown({ content: "  ", notes: "" })).toBeNull();
    expect(buildPlaybookMarkdown(null)).toBeNull();
  });
});
