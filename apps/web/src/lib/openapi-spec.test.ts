import { describe, expect, it } from "bun:test";
import { docsManifest } from "@/lib/docs-manifest";
import {
  apiPageMarkdown,
  HTTP_METHODS,
  loadOpenAPISpec,
  operationsForTags,
  parseTagList,
  schemaType,
  specForOperations,
} from "@/lib/openapi-spec";

const spec = loadOpenAPISpec();
const referencePages = docsManifest({ includeAdmin: false }).filter((e) =>
  e.slug.startsWith("api/reference/"),
);
const pageTags = (body: string) => parseTagList(body.match(/<APIPage tags="([^"]*)"/)?.[1] ?? "");

describe("docs API reference", () => {
  it("documents only the production server, under /v1", () => {
    expect(spec.servers?.map((s) => s.url)).toEqual(["https://api.releases.sh/v1"]);
  });

  it("puts every public operation on exactly one reference page", () => {
    const seen = new Map<string, string>();
    for (const page of referencePages) {
      for (const op of operationsForTags(spec, pageTags(page.doc.body))) {
        const key = `${op.method} ${op.path}`;
        expect({ key, also: seen.get(key) }).toEqual({ key, also: undefined });
        seen.set(key, page.slug);
      }
    }
    let total = 0;
    for (const item of Object.values(spec.paths)) {
      total += HTTP_METHODS.filter((m) => item[m]).length;
    }
    expect(referencePages.length).toBeGreaterThan(0);
    expect(seen.size).toBe(total);
  });

  it("ships each page only its own operations", () => {
    const ops = operationsForTags(spec, ["Releases"]);
    const trimmed = specForOperations(spec, ops);
    expect(Object.keys(trimmed.paths).length).toBeLessThan(Object.keys(spec.paths).length);
    expect(trimmed.tags?.map((t) => t.name)).toEqual(["Releases"]);
  });

  it("renders a markdown fallback with full URLs and parameter tables", () => {
    const md = apiPageMarkdown(["Releases"]);
    expect(md).toContain("`GET https://api.releases.sh/v1/releases/latest`");
    expect(md).toContain("| `count` | query |");
    expect(md).toContain("https://api.releases.sh/v1/openapi.json");
  });

  it("summarizes schema types", () => {
    expect(schemaType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(schemaType({ enum: ["a", "b"] })).toBe('"a" \\| "b"');
    expect(schemaType({ $ref: "#/components/schemas/ErrorEnvelope" })).toBe("ErrorEnvelope");
  });
});
