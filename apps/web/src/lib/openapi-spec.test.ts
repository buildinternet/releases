import { describe, expect, it } from "bun:test";
import { apiReferenceEntries, docsManifest, guidesNavEntries } from "@/lib/docs-manifest";
import {
  allOperations,
  apiPageMarkdown,
  loadOpenAPISpec,
  operationsByIds,
  parseIdList,
  schemaType,
  specForOperations,
} from "@/lib/openapi-spec";

const spec = loadOpenAPISpec();
const manifest = docsManifest({ includeAdmin: false });
const endpointPages = apiReferenceEntries(manifest).filter((e) => e.navGroup);
const pageIds = (body: string) =>
  parseIdList(body.match(/<APIPage operations="([^"]*)"/)?.[1] ?? "");

describe("docs API reference", () => {
  it("documents only the production server, under /v1", () => {
    expect(spec.servers?.map((s) => s.url)).toEqual(["https://api.releases.sh/v1"]);
  });

  it("puts every public operation on exactly one endpoint page", () => {
    const seen = new Map<string, string>();
    for (const page of endpointPages) {
      for (const id of pageIds(page.doc.body)) {
        expect({ id, also: seen.get(id) }).toEqual({ id, also: undefined });
        seen.set(id, page.slug);
      }
    }
    expect(endpointPages.length).toBeGreaterThan(0);
    expect([...seen.keys()].sort()).toEqual(
      allOperations(spec)
        .map((o) => o.operationId!)
        .sort(),
    );
  });

  it("keeps endpoint pages out of the main docs sidebar, except the landing page", () => {
    const guides = guidesNavEntries(manifest).map((e) => e.slug);
    expect(guides).toContain("api/reference");
    expect(guides.some((slug) => slug.startsWith("api/reference/"))).toBe(false);
  });

  it("ships each page only its own operations", () => {
    const ops = operationsByIds(spec, ["getReleasesLatest"]);
    const trimmed = specForOperations(spec, ops);
    expect(Object.keys(trimmed.paths)).toEqual(["/releases/latest"]);
    expect(trimmed.tags?.map((t) => t.name)).toEqual(["Releases"]);
  });

  it("renders a markdown fallback with full URLs and parameter tables", () => {
    const md = apiPageMarkdown(["getReleasesLatest"]);
    expect(md).toContain("`GET https://api.releases.sh/v1/releases/latest`");
    expect(md).toContain("| `count` | query |");
    expect(md).toContain("https://api.releases.sh/v1/openapi.json");
  });

  it("throws on an unknown operationId", () => {
    expect(() => operationsByIds(spec, ["nope"])).toThrow(/docs:openapi/);
  });

  it("summarizes schema types", () => {
    expect(schemaType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(schemaType({ enum: ["a", "b"] })).toBe('"a" \\| "b"');
    expect(schemaType({ $ref: "#/components/schemas/ErrorEnvelope" })).toBe("ErrorEnvelope");
  });
});

describe("docs links", () => {
  it("every /docs link in a docs page resolves to a listed page", () => {
    const paths = new Set(manifest.map((e) => e.path));
    const broken: string[] = [];
    for (const { slug, doc } of manifest) {
      for (const [, href] of doc.body.matchAll(/\]\((\/docs[^)#\s]*)/g)) {
        if (!paths.has(href.replace(/\.md$/, ""))) broken.push(`${slug} → ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
