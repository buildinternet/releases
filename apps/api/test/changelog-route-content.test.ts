/**
 * GET /v1/orgs/:orgSlug/sources/:sourceSlug/changelog ships `content` only for
 * the file it returns. These cover the three ways that file is picked: the
 * default root-level file, an explicit `?path=`, and the first-row fallback
 * when a source has no root-level file (which needs a second content read).
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, sourceChangelogFiles } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { respondError } from "../src/lib/error-response.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

type ChangelogBody = { path: string; content: string; files: { path: string }[] };

async function seed(db: ReturnType<typeof mkDb>, paths: string[]) {
  await db.insert(organizations).values({ id: "org_acme", slug: "acme", name: "Acme" });
  await db.insert(sources).values({
    id: "src_acme_mono",
    slug: "mono",
    name: "Acme Monorepo",
    type: "github",
    url: "https://github.com/acme/mono",
    orgId: "org_acme",
  });
  await db.insert(sourceChangelogFiles).values(
    paths.map((path) => ({
      sourceId: "src_acme_mono",
      path,
      filename: path.split("/").pop()!,
      url: `https://github.com/acme/mono/blob/HEAD/${path}`,
      rawUrl: `https://raw.githubusercontent.com/acme/mono/HEAD/${path}`,
      content: `# ${path}`,
      contentHash: path,
      bytes: path.length + 2,
    })),
  );
}

async function get(paths: string[], query = ""): Promise<ChangelogBody> {
  const db = mkDb();
  await seed(db, paths);
  const fetch = createTestApp(db, [sourceRoutes], { onError: (err, c) => respondError(c, err) });
  const res = await fetch(
    new Request(`https://x.test/v1/orgs/acme/sources/mono/changelog${query}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ChangelogBody;
}

describe("source changelog route content selection", () => {
  it("returns the root-level file's content by default", async () => {
    const body = await get(["packages/a/CHANGELOG.md", "CHANGELOG.md"]);
    expect(body.path).toBe("CHANGELOG.md");
    expect(body.content).toBe("# CHANGELOG.md");
    expect(body.files.map((f) => f.path)).toEqual(["CHANGELOG.md", "packages/a/CHANGELOG.md"]);
  });

  it("returns the requested nested file's content for ?path=", async () => {
    const body = await get(
      ["CHANGELOG.md", "packages/a/CHANGELOG.md"],
      "?path=packages%2Fa%2FCHANGELOG.md",
    );
    expect(body.path).toBe("packages/a/CHANGELOG.md");
    expect(body.content).toBe("# packages/a/CHANGELOG.md");
  });

  it("loads the first file's content when there is no root-level file", async () => {
    const body = await get(["packages/b/CHANGELOG.md", "packages/a/CHANGELOG.md"]);
    expect(body.path).toBe("packages/a/CHANGELOG.md");
    expect(body.content).toBe("# packages/a/CHANGELOG.md");
  });
});
