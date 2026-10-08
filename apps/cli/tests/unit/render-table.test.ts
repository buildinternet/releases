import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { renderTable } from "../../src/cli/render/table.js";
import { stripAnsi } from "../../src/lib/sanitize.js";

describe("renderTable", () => {
  let prevLevel: typeof chalk.level;
  beforeAll(() => {
    prevLevel = chalk.level;
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  it("returns empty string for no rows", () => {
    expect(renderTable({ head: ["A", "B"], rows: [], isTTY: true, maxWidth: 80 })).toBe("");
  });

  it("renders space-padded columns with uppercased cyan headers in TTY mode", () => {
    const out = renderTable({
      head: ["Name", "Slug"],
      rows: [
        ["alpha", "a"],
        ["beta", "b"],
      ],
      isTTY: true,
      maxWidth: 80,
    });
    const lines = out.split("\n");
    expect(stripAnsi(lines[0])).toBe("NAME   SLUG");
    expect(stripAnsi(lines[1])).toBe("alpha  a");
    expect(stripAnsi(lines[2])).toBe("beta   b");
    // header should carry ANSI color
    expect(lines[0]).not.toBe(stripAnsi(lines[0]));
  });

  it("uses tab delimiter and drops headers/colors in non-TTY mode", () => {
    const out = renderTable({
      head: ["Name", "Slug"],
      rows: [[chalk.red("alpha"), "a"]],
      isTTY: false,
    });
    expect(out).toBe("alpha\ta");
  });

  it("truncates flexible columns with an ellipsis to fit maxWidth", () => {
    const long = "x".repeat(200);
    const out = renderTable({
      head: ["Title"],
      rows: [[long]],
      isTTY: true,
      maxWidth: 20,
    });
    const cell = stripAnsi(out.split("\n")[1]);
    expect(cell.length).toBeLessThanOrEqual(20);
    expect(cell.endsWith("…")).toBe(true);
  });

  it("respects noTruncate for fixed columns", () => {
    const long = "x".repeat(200);
    const out = renderTable({
      head: [{ label: "ID", noTruncate: true }, { label: "Title" }],
      rows: [[long, "title"]],
      isTTY: true,
      maxWidth: 30,
    });
    const lines = out.split("\n");
    expect(stripAnsi(lines[1]).startsWith(long)).toBe(true);
  });

  it("right-aligns columns when alignRight is set", () => {
    const out = renderTable({
      head: [{ label: "Count", alignRight: true }, { label: "Name" }],
      rows: [
        ["1", "a"],
        ["100", "b"],
      ],
      isTTY: true,
      maxWidth: 80,
    });
    const lines = out.split("\n").map(stripAnsi);
    expect(lines[1]).toBe("    1  a");
    expect(lines[2]).toBe("  100  b");
  });

  it("does not pad past the last column (avoids trailing whitespace)", () => {
    const out = renderTable({
      head: ["A", "B"],
      rows: [["x", "y"]],
      isTTY: true,
      maxWidth: 80,
    });
    for (const line of out.split("\n")) {
      expect(line).toBe(line.replace(/\s+$/, ""));
    }
  });

  it("handles ANSI-wrapped content for width measurement", () => {
    const out = renderTable({
      head: ["X"],
      rows: [[chalk.red("hello")]],
      isTTY: true,
      maxWidth: 80,
    });
    // ANSI wrapped value should have visible width 5 (= "hello"), not raw length
    const lines = out.split("\n");
    expect(stripAnsi(lines[1])).toBe("hello");
  });

  it("redistributes leftover budget to short columns (gh pass 3)", () => {
    // Three columns. Without pass 3, the per-column flex split would leave the
    // short column underfilled. Pass 3 grows it back to its natural width.
    const out = renderTable({
      head: ["A", "B", "C"],
      rows: [["xx", "y".repeat(60), "z".repeat(60)]],
      isTTY: true,
      maxWidth: 40,
    });
    const line = stripAnsi(out.split("\n")[1]);
    expect(line.length).toBeLessThanOrEqual(40);
    // "xx" should always render in full (its natural width fits trivially)
    expect(line.startsWith("xx")).toBe(true);
  });

  it("omits the header row when showHeader is false", () => {
    const out = renderTable({
      head: ["A", "B"],
      rows: [["x", "y"]],
      isTTY: true,
      maxWidth: 80,
      showHeader: false,
    });
    expect(stripAnsi(out)).toBe("x  y");
  });

  it("renders TTY subRows indented under the first column", () => {
    const out = renderTable({
      head: [{ label: "ID", noTruncate: true }, "Desc"],
      rows: [["alpha", "title"]],
      subRows: ["a continuation line"],
      isTTY: true,
      maxWidth: 80,
      showHeader: false,
    });
    const lines = stripAnsi(out).split("\n");
    expect(lines[0]).toBe("alpha  title");
    // indent = width("alpha") + 2-space delim = 7
    expect(lines[1]).toBe("       a continuation line");
  });

  it("drops subRows entirely in non-TTY mode", () => {
    const out = renderTable({
      head: ["A", "B"],
      rows: [["x", "y"]],
      subRows: ["nope"],
      isTTY: false,
    });
    expect(out).toBe("x\ty");
  });
});
