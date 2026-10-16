import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SOURCE_DATASETS,
  getDefaultSourceDataset,
  resolveSourceDataset,
  readSourceDatasetSettings,
} from "./source-dataset";

const pilot = { ...DEFAULT_SOURCE_DATASETS[0], metadata: "{}" };
const other = { id: "src_other", orgSlug: "example", slug: "updates", name: "Example" };

describe("persisted dataset settings", () => {
  test("all current pilots remain enabled by default and survive slug renames by source ID", () => {
    expect(DEFAULT_SOURCE_DATASETS).toHaveLength(15);
    for (const source of DEFAULT_SOURCE_DATASETS) {
      expect(resolveSourceDataset({ ...source, metadata: "{}" })?.name).toBe(source.name);
      expect(resolveSourceDataset({ ...source, slug: "renamed", orgSlug: "moved" })?.name).toBe(
        source.name,
      );
    }
    expect(getDefaultSourceDataset({ ...pilot, id: "src_replacement" })).toBeUndefined();
    expect(resolveSourceDataset(other)).toBeUndefined();
  });

  test("explicit disable wins over defaults; null reset restores only defaults", () => {
    expect(
      resolveSourceDataset({ ...pilot, metadata: '{"dataset":{"enabled":false}}' }),
    ).toBeUndefined();
    expect(resolveSourceDataset({ ...pilot, metadata: '{"dataset":null}' })?.name).toBe(pilot.name);
    expect(resolveSourceDataset({ ...other, metadata: '{"dataset":null}' })).toBeUndefined();
  });

  test("operator opt-in and optional copy work for a previously unselected source", () => {
    const description =
      "A searchable collection of Example release notes with dates and original source links.";
    expect(
      resolveSourceDataset({
        ...other,
        metadata: JSON.stringify({
          dataset: { enabled: true, name: "Example history", description },
        }),
      }),
    ).toEqual({ name: "Example history", description });
    expect(resolveSourceDataset({ ...other, metadata: '{"dataset":{"enabled":true}}' })?.name).toBe(
      "A structured history of Example",
    );
    expect(resolveSourceDataset({ ...other, metadata: '{"dataset":{}}' })).toBeUndefined();
    expect(
      resolveSourceDataset({
        ...other,
        name: "x".repeat(250),
        metadata: '{"dataset":{"enabled":true}}',
      })?.name.length,
    ).toBe(200);
  });

  test.each([
    "broken",
    "[]",
    '{"dataset":{"enabled":"false"}}',
    '{"dataset":{"description":"too short"}}',
  ])("malformed persisted settings fail closed: %s", (metadata) => {
    expect(readSourceDatasetSettings(metadata).valid).toBe(false);
    expect(resolveSourceDataset({ ...pilot, metadata })).toBeUndefined();
  });

  test.each([{ isHidden: true }, { discovery: "on_demand" }])(
    "operator opt-in cannot bypass source visibility: %j",
    (visibility) => {
      expect(
        resolveSourceDataset({ ...other, ...visibility, metadata: '{"dataset":{"enabled":true}}' }),
      ).toBeUndefined();
    },
  );
});
