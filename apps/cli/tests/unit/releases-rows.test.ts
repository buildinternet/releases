import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { renderReleaseRows } from "../../src/cli/render/releases-table.js";
import { stripAnsi } from "../../src/lib/sanitize.js";
import type { ReleaseRow } from "../../src/lib/release-display.js";

const rows: ReleaseRow[] = [
  {
    id: "rel_1",
    title: "Bump cli",
    version: "@posthog/nuxt@1.7.42",
    summary: "Bump @posthog/cli to 0.7.13",
    publishedAt: null,
    sourceName: "PostHog JS",
    sourceSlug: "posthog-js",
  },
  {
    id: "rel_2",
    title: "Agent skills v0.107.0",
    version: "agent-skills-v0.107.0",
    summary: null,
    publishedAt: null,
    sourceName: "PostHog",
    sourceSlug: "posthog",
  },
];

describe("renderReleaseRows (feed)", () => {
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = 0;
  });

  it("TTY: one aligned row per release, identity from version-or-source, no header", () => {
    const out = stripAnsi(renderReleaseRows(rows, { mode: "feed", isTTY: true, maxWidth: 100 }));
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("@posthog/nuxt@1.7.42")).toBe(true);
    expect(lines[0]).toContain("Bump cli"); // title wins over summary (title-first)
    expect(lines[0]).toContain("rel_1");
    expect(lines[1].startsWith("PostHog ")).toBe(true); // plain version → source name
    expect(lines[1]).toContain("Agent skills v0.107.0"); // title
  });

  it("non-TTY: clean TSV, one row per release, no injected newline", () => {
    const out = renderReleaseRows(rows, { mode: "feed", isTTY: false });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].split("\t")[0]).toBe("rel_1");
  });

  const productRows: ReleaseRow[] = [
    {
      id: "rel_p1",
      title: "Turbopack is now stable",
      version: null,
      summary: null,
      publishedAt: null,
      sourceName: "Vercel CLI", // deliberately distinct from the product name
      sourceSlug: "vercel-cli",
      product: { slug: "next-js", name: "Next.js" },
    },
    {
      id: "rel_p2",
      title: "Standalone note",
      version: null,
      summary: null,
      publishedAt: null,
      sourceName: "Orphan Source",
      sourceSlug: "orphan",
      product: null,
    },
  ];

  it("TTY: identity:'product' leads with the owning product name, falling back to the source", () => {
    const out = stripAnsi(
      renderReleaseRows(productRows, {
        mode: "feed",
        isTTY: true,
        maxWidth: 100,
        identity: "product",
      }),
    );
    const lines = out.split("\n");
    expect(lines[0].startsWith("Next.js")).toBe(true); // product name, not the source
    expect(lines[1].startsWith("Orphan Source")).toBe(true); // no product → source name
  });

  it("non-TTY: identity:'product' keeps source identity in the TSV (pipeline stability)", () => {
    const tsv = renderReleaseRows(productRows, { mode: "feed", isTTY: false, identity: "product" });
    // The machine TSV always uses source identity so pipelines stay stable.
    expect(tsv.split("\n")[0].split("\t")[1]).toBe("Vercel CLI");
  });
});

describe("renderReleaseRows (search)", () => {
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = 0;
  });

  it("TTY: title on the primary line, cleaned excerpt as an indented continuation", () => {
    const hit: ReleaseRow[] = [
      {
        id: "rel_e",
        title: "LangSmith now supports MCP",
        version: null,
        summary: "## Trace\n**MCP** tool calls end-to-end",
        publishedAt: null,
        sourceName: "LangChain",
        sourceSlug: "langchain-changelog",
      },
    ];
    const out = stripAnsi(renderReleaseRows(hit, { mode: "search", isTTY: true, maxWidth: 100 }));
    const lines = out.split("\n");
    expect(lines[0]).toContain("LangChain");
    expect(lines[0]).toContain("LangSmith now supports MCP");
    expect(lines[1].trimStart()).toBe("Trace MCP tool calls end-to-end");
    expect(lines[1].startsWith(" ")).toBe(true); // indented continuation
  });

  it("skips the excerpt continuation when it just repeats the title", () => {
    const hit: ReleaseRow[] = [
      {
        id: "rel_r",
        title: "Better Webhooks, Better Service Settings",
        version: null,
        summary: "Better Webhooks, Better Service Settings",
        publishedAt: null,
        sourceName: "Railway",
        sourceSlug: "railway",
      },
    ];
    const out = stripAnsi(renderReleaseRows(hit, { mode: "search", isTTY: true, maxWidth: 100 }));
    expect(out.split("\n")).toHaveLength(1); // no redundant continuation line
  });

  it("collapses tabs/newlines in a search title so the row contract holds", () => {
    const hit: ReleaseRow[] = [
      {
        id: "rel_t",
        title: "Multi\nline\ttitle",
        version: null,
        summary: "body",
        publishedAt: null,
        sourceName: "Src",
        sourceSlug: "src",
      },
    ];
    // TSV: exactly one row, the title field free of raw tabs/newlines.
    const tsv = renderReleaseRows(hit, { mode: "search", isTTY: false });
    expect(tsv.split("\n")).toHaveLength(1);
    expect(tsv.split("\t")[2]).toBe("Multi line title");
    // TTY: the primary line carries the collapsed title (no embedded newline).
    const tty = stripAnsi(renderReleaseRows(hit, { mode: "search", isTTY: true, maxWidth: 100 }));
    expect(tty.split("\n")[0]).toContain("Multi line title");
  });

  it("prefixes the identity with the owning org (Org/Source) when the hit carries one", () => {
    const hit: ReleaseRow[] = [
      {
        id: "rel_o",
        title: "Custom webhooks",
        version: null,
        summary: "Axiom introduces custom webhooks.",
        publishedAt: null,
        sourceName: "Changelog",
        sourceSlug: "changelog",
        orgName: "Axiom",
        orgSlug: "axiom",
      },
    ];
    const tty = stripAnsi(renderReleaseRows(hit, { mode: "search", isTTY: true, maxWidth: 100 }));
    expect(tty.split("\n")[0].startsWith("Axiom/Changelog")).toBe(true);
    // Same coordinate leads the machine TSV identity column.
    const tsv = renderReleaseRows(hit, { mode: "search", isTTY: false });
    expect(tsv.split("\t")[1]).toBe("Axiom/Changelog");
  });

  it("non-TTY: one plain line per hit, no continuation", () => {
    const hit: ReleaseRow[] = [
      {
        id: "rel_e",
        title: "T",
        version: null,
        summary: "body",
        publishedAt: null,
        sourceName: "Lang",
        sourceSlug: "lang",
      },
    ];
    const out = renderReleaseRows(hit, { mode: "search", isTTY: false });
    expect(out.split("\n")).toHaveLength(1);
  });
});

describe("renderReleaseRows (importance marker)", () => {
  // `chalk` is a process-wide singleton, so forcing colour on here and then
  // hardcoding it back to 0 would clobber whatever level the runner picked for
  // every suite that follows. Save and restore instead.
  let priorChalkLevel: typeof chalk.level;
  beforeAll(() => {
    priorChalkLevel = chalk.level;
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = priorChalkLevel;
  });

  const rowWith = (importance: number | null | undefined): ReleaseRow => ({
    id: "rel_i",
    title: "Some release",
    version: null,
    summary: null,
    publishedAt: null,
    sourceName: "Src",
    sourceSlug: "src",
    importance,
  });

  it("TTY: shows the solid marker at importance 5", () => {
    const out = stripAnsi(
      renderReleaseRows([rowWith(5)], { mode: "feed", isTTY: true, maxWidth: 100 }),
    );
    expect(out).toContain("◆ Some release");
  });

  it("TTY: shows the outline marker at importance 4", () => {
    const out = stripAnsi(
      renderReleaseRows([rowWith(4)], { mode: "feed", isTTY: true, maxWidth: 100 }),
    );
    expect(out).toContain("◇ Some release");
  });

  it("TTY: shows no marker for importance 3 and below", () => {
    for (const importance of [3, 2, 1]) {
      const out = stripAnsi(
        renderReleaseRows([rowWith(importance)], { mode: "feed", isTTY: true, maxWidth: 100 }),
      );
      expect(out).not.toContain("◆");
      expect(out).not.toContain("◇");
      expect(out.trim().startsWith("Some release") || out.includes(" Some release")).toBe(true);
    }
  });

  it("TTY: shows no marker for a null (unscored) or undefined (absent) importance", () => {
    for (const importance of [null, undefined]) {
      const out = stripAnsi(
        renderReleaseRows([rowWith(importance)], { mode: "feed", isTTY: true, maxWidth: 100 }),
      );
      expect(out).not.toContain("◆");
      expect(out).not.toContain("◇");
    }
  });

  it("non-TTY: the machine TSV never carries the marker glyph, regardless of importance", () => {
    const out = renderReleaseRows([rowWith(5)], { mode: "feed", isTTY: false });
    expect(out).not.toContain("◆");
    expect(out.split("\t")[2]).toBe("Some release");
  });
});
