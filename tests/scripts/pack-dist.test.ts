import { describe, expect, test } from "bun:test";
import {
  addJsExtensions,
  distExports,
  distManifest,
  pinWorkspaceDeps,
} from "../../scripts/pack-dist.js";

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

describe("pinWorkspaceDeps", () => {
  test("pins workspace ranges and leaves the rest", () => {
    expect(
      pinWorkspaceDeps(
        { a: "workspace:*", b: "workspace:^", c: "workspace:~", zod: "^4.4.3" },
        { a: "1.2.3", b: "0.5.0", c: "2.0.0" },
      ),
    ).toEqual({ a: "1.2.3", b: "^0.5.0", c: "~2.0.0", zod: "^4.4.3" });
  });

  test("fails on a workspace dependency it can't resolve", () => {
    expect(() => pinWorkspaceDeps({ a: "workspace:*" }, {})).toThrow("no known version");
  });
});

describe("addJsExtensions", () => {
  const files = new Set(["./slug.js", "./schemas/index.js", "../core.js"]);
  const exists = (rel: string) => files.has(rel);

  test("adds .js to relative imports, exports and import() types", () => {
    const code = [
      'import { toSlug } from "./slug";',
      "export * from './schemas';",
      'type T = import("../core").Core;',
      'import "./slug";',
    ].join("\n");
    expect(addJsExtensions(code, exists)).toBe(
      [
        'import { toSlug } from "./slug.js";',
        "export * from './schemas/index.js';",
        'type T = import("../core.js").Core;',
        'import "./slug.js";',
      ].join("\n"),
    );
  });

  test("leaves package imports, explicit extensions and unknown paths alone", () => {
    const code = 'import { z } from "zod";\nimport a from "./a.js";\nimport b from "./missing";';
    expect(addJsExtensions(code, exists)).toBe(code);
  });
});
