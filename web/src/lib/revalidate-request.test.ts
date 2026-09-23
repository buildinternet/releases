import { describe, expect, it } from "bun:test";
import { handleRevalidateRequest, type RevalidateDeps } from "./revalidate-request.js";

const SECRET = "s3cret-token";

function deps(overrides: Partial<RevalidateDeps> = {}): {
  deps: RevalidateDeps;
  revalidated: string[];
} {
  const revalidated: string[] = [];
  return {
    revalidated,
    deps: { serviceKey: SECRET, revalidate: (path) => revalidated.push(path), ...overrides },
  };
}

function post(body: unknown, token: string | null = SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://releases.sh/api/revalidate", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleRevalidateRequest", () => {
  it("fails closed with 503 when no secret is configured", async () => {
    const { deps: d, revalidated } = deps({ serviceKey: undefined });
    const res = await handleRevalidateRequest(post({ orgSlug: "vercel" }), d);
    expect(res.status).toBe(503);
    expect(revalidated).toEqual([]);
  });

  it("rejects a request with no Authorization header", async () => {
    const { deps: d, revalidated } = deps();
    const res = await handleRevalidateRequest(post({ orgSlug: "vercel" }, null), d);
    expect(res.status).toBe(401);
    expect(revalidated).toEqual([]);
  });

  it("rejects a mismatched bearer token", async () => {
    const { deps: d, revalidated } = deps();
    const res = await handleRevalidateRequest(post({ orgSlug: "vercel" }, "wrong"), d);
    expect(res.status).toBe(401);
    expect(revalidated).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const { deps: d } = deps();
    const res = await handleRevalidateRequest(post("not json at all"), d);
    expect(res.status).toBe(400);
  });

  it("rejects a body with no orgSlug", async () => {
    const { deps: d } = deps();
    const res = await handleRevalidateRequest(post({ sourceSlug: "changelog" }), d);
    expect(res.status).toBe(400);
  });

  it("revalidates only the org page when just an orgSlug is given", async () => {
    const { deps: d, revalidated } = deps();
    const res = await handleRevalidateRequest(post({ orgSlug: "vercel" }), d);
    expect(res.status).toBe(200);
    expect(revalidated).toEqual(["/vercel"]);
    expect(await res.json()).toEqual({ revalidated: ["/vercel"] });
  });

  it("revalidates the org, source and product pages together", async () => {
    const { deps: d, revalidated } = deps();
    const res = await handleRevalidateRequest(
      post({ orgSlug: "vercel", sourceSlug: "changelog", productSlug: "next-js" }),
      d,
    );
    expect(res.status).toBe(200);
    expect(revalidated).toEqual(["/vercel", "/vercel/changelog", "/vercel/next-js"]);
  });

  it("does not revalidate the same path twice when source and product collide", async () => {
    const { deps: d, revalidated } = deps();
    await handleRevalidateRequest(
      post({ orgSlug: "vercel", sourceSlug: "next-js", productSlug: "next-js" }),
      d,
    );
    expect(revalidated).toEqual(["/vercel", "/vercel/next-js"]);
  });

  // The worker is a trusted caller, but a slug carrying path syntax would let a
  // compromised or buggy upstream aim revalidatePath() at arbitrary routes —
  // `revalidatePath("/")` would dump the entire cache on every ingest.
  it("rejects slugs carrying path syntax", async () => {
    const { deps: d, revalidated } = deps();
    const res = await handleRevalidateRequest(post({ orgSlug: "../.." }), d);
    expect(res.status).toBe(400);
    expect(revalidated).toEqual([]);
  });

  it("rejects a source slug carrying path syntax", async () => {
    const { deps: d, revalidated } = deps();
    const res = await handleRevalidateRequest(
      post({ orgSlug: "vercel", sourceSlug: "a/../../etc" }),
      d,
    );
    expect(res.status).toBe(400);
    expect(revalidated).toEqual([]);
  });

  describe("the generalized paths shape", () => {
    it("still requires the bearer token", async () => {
      const { deps: d, revalidated } = deps();
      const res = await handleRevalidateRequest(post({ paths: ["/"] }, null), d);
      expect(res.status).toBe(401);
      expect(revalidated).toEqual([]);
    });

    it("revalidates the homepage and collection paths from a weekly-digest ping", async () => {
      const { deps: d, revalidated } = deps();
      const res = await handleRevalidateRequest(
        post({ paths: ["/", "/collections", "/collections/ai-labs"] }),
        d,
      );
      expect(res.status).toBe(200);
      expect(revalidated).toEqual(["/", "/collections", "/collections/ai-labs"]);
      expect(await res.json()).toEqual({
        revalidated: ["/", "/collections", "/collections/ai-labs"],
      });
    });

    it("revalidates an org page path (the shape the per-source ping's derivation uses)", async () => {
      const { deps: d, revalidated } = deps();
      const res = await handleRevalidateRequest(
        post({ paths: ["/vercel", "/vercel/changelog"] }),
        d,
      );
      expect(res.status).toBe(200);
      expect(revalidated).toEqual(["/vercel", "/vercel/changelog"]);
    });

    it("dedups repeated paths", async () => {
      const { deps: d, revalidated } = deps();
      await handleRevalidateRequest(post({ paths: ["/", "/", "/collections"] }), d);
      expect(revalidated).toEqual(["/", "/collections"]);
    });

    it("rejects an empty paths array", async () => {
      const { deps: d, revalidated } = deps();
      const res = await handleRevalidateRequest(post({ paths: [] }), d);
      expect(res.status).toBe(400);
      expect(revalidated).toEqual([]);
    });

    it("rejects a paths array over the cap", async () => {
      const { deps: d, revalidated } = deps();
      const paths = Array.from({ length: 51 }, (_, i) => `/collections/c${i}`);
      const res = await handleRevalidateRequest(post({ paths }), d);
      expect(res.status).toBe(400);
      expect(revalidated).toEqual([]);
    });

    it("accepts exactly 50 paths", async () => {
      const { deps: d, revalidated } = deps();
      const paths = Array.from({ length: 50 }, (_, i) => `/collections/c${i}`);
      const res = await handleRevalidateRequest(post({ paths }), d);
      expect(res.status).toBe(200);
      expect(revalidated).toHaveLength(50);
    });

    it("rejects a path outside the allowlist", async () => {
      const { deps: d, revalidated } = deps();
      const res = await handleRevalidateRequest(
        post({ paths: ["/collections/ai-labs/digest/2026-06-08"] }),
        d,
      );
      expect(res.status).toBe(400);
      expect(revalidated).toEqual([]);
    });

    it("rejects path-traversal syntax inside a paths entry", async () => {
      const { deps: d, revalidated } = deps();
      const res = await handleRevalidateRequest(post({ paths: ["/../etc/passwd"] }), d);
      expect(res.status).toBe(400);
      expect(revalidated).toEqual([]);
    });

    it("rejects a non-string entry in the paths array", async () => {
      const { deps: d, revalidated } = deps();
      const res = await handleRevalidateRequest(post({ paths: ["/", 42] }), d);
      expect(res.status).toBe(400);
      expect(revalidated).toEqual([]);
    });
  });
});
