import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("CLI source lifecycle", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    const seed = cli(dataDir, ["admin", "org", "add", "Acme Corp", "--category", "cloud"]);
    if (seed.exitCode !== 0) throw new Error(`Seed failed: ${seed.stderr}`);
  });

  afterAll(() => cleanup());

  it("starts with no sources", () => {
    const sources = cliJson<unknown[]>(dataDir, ["list", "--json"]);
    expect(sources).toEqual([]);
  });

  it("adds a source with --skip-eval", () => {
    const result = cli(dataDir, [
      "admin", "source", "add", "Acme Changelog",
      "--url", "https://example.com/changelog",
      "--org", "acme-corp",
      "--skip-eval",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const source = JSON.parse(result.stdout);
    expect(source.name).toBe("Acme Changelog");
    expect(source.slug).toBe("acme-changelog");
    expect(source.type).toBe("scrape");
    expect(source.status).toBe("added");
  });

  it("source appears in list", () => {
    const sources = cliJson<{ slug: string }[]>(dataDir, ["list", "--json"]);
    expect(sources.length).toBe(1);
    expect(sources[0].slug).toBe("acme-changelog");
  });

  it("shows single source details", () => {
    const source = cliJson<{ slug: string; url: string; type: string }>(
      dataDir,
      ["list", "acme-changelog", "--json"],
    );
    expect(source.slug).toBe("acme-changelog");
    expect(source.url).toBe("https://example.com/changelog");
    expect(source.type).toBe("scrape");
  });

  it("edits source name", () => {
    const result = cli(dataDir, [
      "admin", "source", "edit", "acme-changelog",
      "--name", "Acme Release Notes",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.name).toBe("Acme Release Notes");
  });

  it("edits source URL", () => {
    const result = cli(dataDir, [
      "admin", "source", "edit", "acme-changelog",
      "--url", "https://example.com/releases",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.url).toBe("https://example.com/releases");
  });

  it("adds a GitHub source with auto-detected type", () => {
    const result = cli(dataDir, [
      "admin", "source", "add", "Acme Releases",
      "--url", "https://github.com/acme/acme",
      "--org", "acme-corp",
      "--skip-eval",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const source = JSON.parse(result.stdout);
    expect(source.type).toBe("github");
  });

  it("adds a source with explicit type", () => {
    const result = cli(dataDir, [
      "admin", "source", "add", "Acme Feed",
      "--url", "https://example.com/feed.xml",
      "--type", "feed",
      "--org", "acme-corp",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const source = JSON.parse(result.stdout);
    expect(source.type).toBe("feed");
  });

  it("rejects invalid source type", () => {
    const result = cli(dataDir, [
      "admin", "source", "add", "Bad Source",
      "--url", "https://example.com",
      "--type", "invalid",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("lists sources filtered by org", () => {
    const sources = cliJson<{ slug: string }[]>(dataDir, [
      "list", "--org", "acme-corp", "--json",
    ]);
    expect(sources.length).toBe(3);
  });

  it("lists sources filtered by query", () => {
    const sources = cliJson<{ slug: string }[]>(dataDir, [
      "list", "--query", "feed", "--json",
    ]);
    expect(sources.length).toBe(1);
    expect(sources[0].slug).toBe("acme-feed");
  });

  it("removes a source", () => {
    const result = cli(dataDir, ["admin", "source", "remove", "acme-feed", "--json"]);
    expect(result.exitCode).toBe(0);
    const removed = JSON.parse(result.stdout);
    expect(removed).toEqual([
      expect.objectContaining({ slug: "acme-feed", status: "removed" }),
    ]);
  });

  it("source is gone after removal", () => {
    const sources = cliJson<{ slug: string }[]>(dataDir, ["list", "--json"]);
    const slugs = sources.map((s) => s.slug);
    expect(slugs).not.toContain("acme-feed");
  });

  it("removing a non-existent source fails", () => {
    const result = cli(dataDir, ["admin", "source", "remove", "nonexistent", "--json"]);
    expect(result.exitCode).toBe(1);
  });

  it("editing a non-existent source fails", () => {
    const result = cli(dataDir, ["admin", "source", "edit", "nonexistent", "--name", "foo"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("source shows up in org show", () => {
    const org = cliJson<{ sources: { slug: string }[] }>(
      dataDir,
      ["admin", "org", "show", "acme-corp", "--json"],
    );
    expect(org.sources.length).toBeGreaterThanOrEqual(1);
    const slugs = org.sources.map((s) => s.slug);
    expect(slugs).toContain("acme-changelog");
  });

  it("adds a source with feed-url", () => {
    const result = cli(dataDir, [
      "admin", "source", "add", "Feed Source",
      "--url", "https://example.com/blog",
      "--feed-url", "https://example.com/blog/feed.xml",
      "--org", "acme-corp",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const source = JSON.parse(result.stdout);
    expect(source.status).toBe("added");
  });

  it("marks a source as primary", () => {
    const result = cli(dataDir, ["admin", "source", "edit", "acme-changelog", "--primary", "--json"]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.isPrimary).toBeTruthy();
  });

  it("disables a source", () => {
    const result = cli(dataDir, ["admin", "source", "edit", "acme-changelog", "--disable", "--json"]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.isHidden).toBeTruthy();
  });

  it("disabled source excluded from default list", () => {
    const sources = cliJson<{ slug: string }[]>(dataDir, ["list", "--json"]);
    const slugs = sources.map((s) => s.slug);
    expect(slugs).not.toContain("acme-changelog");
  });

  it("disabled source included with --include-disabled", () => {
    const sources = cliJson<{ slug: string }[]>(dataDir, [
      "list", "--include-disabled", "--json",
    ]);
    const slugs = sources.map((s) => s.slug);
    expect(slugs).toContain("acme-changelog");
  });

  it("re-enables a source", () => {
    const result = cli(dataDir, ["admin", "source", "edit", "acme-changelog", "--enable", "--json"]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.isHidden).toBeFalsy();
  });
});
