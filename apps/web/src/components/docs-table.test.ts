import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { collectHeaderTexts } from "./docs-table";

function th(text: string) {
  return createElement("th", null, text);
}
function tr(...cells: ReturnType<typeof th>[]) {
  return createElement("tr", null, ...cells);
}
function thead(...rows: ReturnType<typeof tr>[]) {
  return createElement("thead", null, ...rows);
}

describe("collectHeaderTexts", () => {
  it("reads the first header row", () => {
    const headers = collectHeaderTexts(
      thead(tr(th("Shape"), th("Surfaces"), th("Input"), th("Output"))),
    );
    expect(headers).toEqual(["Shape", "Surfaces", "Input", "Output"]);
  });

  it("returns empty for no children", () => {
    expect(collectHeaderTexts(null)).toEqual([]);
  });
});
