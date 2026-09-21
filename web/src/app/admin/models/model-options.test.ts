import { expect, it } from "bun:test";
import { modelOptions } from "./model-options";

const catalog = [
  { id: "typesafe/jev-1.13", name: "Typesafe: JEV 1.13 (decision)" },
  { id: "google/gemini-2.5-flash-lite", name: "Gemini Flash Lite" },
].map((m) => ({
  ...m,
  contextLength: null,
  promptPricePerMillion: null,
  completionPricePerMillion: null,
  vision: false,
}));

it("offers the decision model in marketing searches", () => {
  expect(modelOptions(catalog, "marketing", "jev").map((m) => m.id)).toEqual(["typesafe/jev-1.13"]);
});

it("excludes decision models from text-only lane choices", () => {
  for (const lane of ["summarize", "extract", "feed-enrich"] as const) {
    expect(modelOptions(catalog, lane, "").map((m) => m.id)).toEqual([
      "google/gemini-2.5-flash-lite",
    ]);
  }
});

it("keeps text-model search available to marketing", () => {
  expect(modelOptions(catalog, "marketing", "  GEMINI ").map((m) => m.id)).toEqual([
    "google/gemini-2.5-flash-lite",
  ]);
});
