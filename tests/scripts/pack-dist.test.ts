import { describe, expect, test } from "bun:test";
import { distExports, distManifest } from "../../scripts/pack-dist.js";

describe("pack-dist", () => {
  test("maps source exports to dist JavaScript and declarations", () => {
    expect(
      distExports({ ".": "./src/api-types.ts", "./datasets": "./src/schemas/datasets.ts" }),
    ).toEqual({
      ".": { types: "./dist/api-types.d.ts", default: "./dist/api-types.js" },
      "./datasets": {
        types: "./dist/schemas/datasets.d.ts",
        default: "./dist/schemas/datasets.js",
      },
    });
  });

  test("rejects an export that is not a ./src/*.ts path", () => {
    expect(() => distExports({ ".": "./index.js" })).toThrow("not a ./src/*.ts path");
  });

  test("publishes dist in place of src and keeps other files", () => {
    const manifest = distManifest({
      name: "x",
      exports: {},
      files: ["src", "fixtures", "README.md"],
    });
    expect(manifest.files).toEqual(["dist", "fixtures", "README.md"]);
    expect(manifest.name).toBe("x");
  });
});
