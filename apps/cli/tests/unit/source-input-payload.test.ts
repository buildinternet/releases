import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { CliError } from "../../src/lib/errors.js";

// Drive the real mode.ts via env (a top-level mock.module is process-global and
// leaks into other files — see api-client.test.ts for the rationale).
const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

const { createSourceAction } = await import("../../src/cli/commands/create.js");
const { updateSourceAction } = await import("../../src/cli/commands/update.js");

/**
 * #324 item 3 — raw-payload `--input` path. An agent can send the request shape
 * directly instead of reverse-mapping it onto a dozen bespoke flags. The body
 * maps to the CLI input shape, so dedup / metadata-packing / validation still
 * run; it is NOT forwarded raw to the API.
 */
describe("source create --input", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWrite: typeof process.stdout.write;
  let postBody: Record<string, unknown> | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    postBody = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/sources")) {
        postBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "src_new",
            slug: "astro",
            name: "Astro",
            type: "scrape",
            url: "https://astro.build/blog",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("filterByUrls=true")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("null", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });

  it("creates one source from a literal JSON body, packing metadataSet tokens", async () => {
    await createSourceAction(undefined, {
      input:
        '{"name":"Astro","url":"https://astro.build/blog","type":"scrape","metadataSet":["marketingFilter=true"]}',
    });
    expect(postBody).not.toBeNull();
    expect(postBody!.name).toBe("Astro");
    expect(postBody!.url).toBe("https://astro.build/blog");
    expect(postBody!.type).toBe("scrape");
    const meta = JSON.parse(String(postBody!.metadata));
    expect(meta.marketingFilter).toBe(true); // coerced like the flag path
  });

  it("does not POST on --dry-run and stamps dryRun: true on the --json preview", async () => {
    let out = "";
    process.stdout.write = ((chunk: unknown) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    await createSourceAction(undefined, {
      input: '{"name":"Astro","url":"https://astro.build/blog","type":"scrape"}',
      dryRun: true,
      json: true,
    });
    expect(postBody).toBeNull();
    expect(JSON.parse(out).dryRun).toBe(true);
  });

  // Validation errors THROW CliError (rather than process.exit) so they reach
  // the top-level handler and serialize to the structured `{ error }` payload
  // under --json — the whole point of the agent-DX work (#324/#325).
  it("rejects a JSON array (points at --batch) with a CliError", async () => {
    const err = await createSourceAction(undefined, {
      input: '[{"name":"A","url":"https://a.dev"}]',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/--batch/);
    expect(postBody).toBeNull();
  });

  it("rejects a body missing required fields with a CliError", async () => {
    const err = await createSourceAction(undefined, { input: '{"name":"Astro"}' }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/name.*url|url.*name|required/);
  });

  // JSON is permissive — `{"name": 123}` is valid JSON — so the field type is
  // validated, not just truthiness; a non-string would otherwise reach
  // createSingleSource and misbehave instead of failing cleanly.
  it("rejects a non-string name/url with a CliError (no POST)", async () => {
    const err = await createSourceAction(undefined, {
      input: '{"name":123,"url":"https://a.dev"}',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/string/);
    expect(postBody).toBeNull();
  });

  it("rejects --batch + --input together with a CliError", async () => {
    const err = await createSourceAction(undefined, {
      input: '{"name":"Astro","url":"https://astro.build/blog"}',
      batch: "sources.json",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/mutually exclusive/);
  });
});

describe("source update --input", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWrite: typeof process.stdout.write;
  let patchBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    patchBodies = [];

    const source = {
      id: "src_abc",
      name: "Acme",
      slug: "acme",
      type: "scrape",
      url: "https://acme.dev/changelog",
      orgId: "org_1",
      metadata: '{"existing":"keep"}',
    };

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        patchBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify(source), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // findSource(src_abc) and the --json refresh both GET the typed-id path.
      return new Response(JSON.stringify(source), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });

  it("applies scalar field updates from the body (kind, priority)", async () => {
    await updateSourceAction("src_abc", {
      input: '{"kind":"sdk","priority":"low"}',
    });
    const merged = Object.assign({}, ...patchBodies);
    expect(merged.kind).toBe("sdk");
    expect(merged.fetchPriority).toBe("low");
  });

  it("merges a metadata object onto existing metadata, deleting on null", async () => {
    await updateSourceAction("src_abc", {
      input: '{"metadata":{"crawlEnabled":true,"existing":null}}',
    });
    const metaPatch = patchBodies.find((b) => typeof b.metadata === "string");
    expect(metaPatch).toBeDefined();
    const meta = JSON.parse(String(metaPatch!.metadata));
    expect(meta.crawlEnabled).toBe(true);
    // `existing` was set to null in the body → deleted from the merged metadata.
    expect("existing" in meta).toBe(false);
  });

  it("does not PATCH on --dry-run", async () => {
    await updateSourceAction("src_abc", {
      input: '{"kind":"sdk"}',
      dryRun: true,
    });
    expect(patchBodies.length).toBe(0);
  });

  it("rejects a JSON array body with a non-zero exit", async () => {
    await expect(updateSourceAction("src_abc", { input: "[1,2,3]" })).rejects.toThrow();
  });
});
