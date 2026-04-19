import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("CLI ignored URLs", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
    const seed = cli(dataDir, ["admin", "org", "add", "Acme Corp"]);
    if (seed.exitCode !== 0) throw new Error(`Seed failed: ${seed.stderr}`);
  });

  afterAll(() => cleanup());

  it("starts with no ignored URLs", () => {
    const rows = cliJson<unknown[]>(dataDir, [
      "admin",
      "policy",
      "ignore",
      "list",
      "--org",
      "acme-corp",
      "--json",
    ]);
    expect(rows).toEqual([]);
  });

  it("ignores a URL", () => {
    const result = cli(dataDir, [
      "admin",
      "policy",
      "ignore",
      "add",
      "https://example.com/blog",
      "--org",
      "acme-corp",
      "--reason",
      "not a changelog",
    ]);
    expect(result.exitCode).toBe(0);
    // ignore add uses logger.info (stderr)
    expect(result.stderr).toContain("Ignored");
  });

  it("ignored URL appears in list", () => {
    const rows = cliJson<{ url: string; reason: string }[]>(dataDir, [
      "admin",
      "policy",
      "ignore",
      "list",
      "--org",
      "acme-corp",
      "--json",
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].url).toBe("https://example.com/blog");
    expect(rows[0].reason).toBe("not a changelog");
  });

  it("un-ignores a URL", () => {
    const result = cli(dataDir, [
      "admin",
      "policy",
      "ignore",
      "remove",
      "https://example.com/blog",
      "--org",
      "acme-corp",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("unignored");
  });

  it("URL is gone after un-ignoring", () => {
    const rows = cliJson<unknown[]>(dataDir, [
      "admin",
      "policy",
      "ignore",
      "list",
      "--org",
      "acme-corp",
      "--json",
    ]);
    expect(rows).toEqual([]);
  });

  it("ignore commands require --org", () => {
    const result = cli(dataDir, ["admin", "policy", "ignore", "list"]);
    expect(result.exitCode).toBe(1);
  });

  it("ignore on unknown org fails", () => {
    const result = cli(dataDir, [
      "admin",
      "policy",
      "ignore",
      "add",
      "https://example.com",
      "--org",
      "nonexistent",
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("dry-run does not persist", () => {
    cli(dataDir, [
      "admin",
      "policy",
      "ignore",
      "add",
      "https://example.com/dry",
      "--org",
      "acme-corp",
      "--dry-run",
    ]);
    const rows = cliJson<unknown[]>(dataDir, [
      "admin",
      "policy",
      "ignore",
      "list",
      "--org",
      "acme-corp",
      "--json",
    ]);
    expect(rows).toEqual([]);
  });
});

describe("CLI blocked URLs", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
  });

  afterAll(() => cleanup());

  it("starts with no blocked URLs", () => {
    const rows = cliJson<unknown[]>(dataDir, ["admin", "policy", "block", "list", "--json"]);
    expect(rows).toEqual([]);
  });

  it("blocks a URL", () => {
    const result = cli(dataDir, [
      "admin",
      "policy",
      "block",
      "add",
      "https://spam.example.com/fake",
      "--reason",
      "spam site",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("blocked");
    expect(parsed.pattern).toBe("https://spam.example.com/fake");
  });

  it("blocks a domain", () => {
    const result = cli(dataDir, [
      "admin",
      "policy",
      "block",
      "add",
      "badsite.com",
      "--domain",
      "--reason",
      "known bad domain",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.type).toBe("domain");
  });

  it("lists blocked entries", () => {
    const rows = cliJson<{ pattern: string; type: string }[]>(dataDir, [
      "admin",
      "policy",
      "block",
      "list",
      "--json",
    ]);
    expect(rows.length).toBe(2);
    const patterns = rows.map((r) => r.pattern);
    expect(patterns).toContain("https://spam.example.com/fake");
    expect(patterns).toContain("badsite.com");
  });

  it("unblocks a URL", () => {
    const result = cli(dataDir, [
      "admin",
      "policy",
      "block",
      "remove",
      "https://spam.example.com/fake",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("unblocked");
  });

  it("only domain block remains", () => {
    const rows = cliJson<{ pattern: string }[]>(dataDir, [
      "admin",
      "policy",
      "block",
      "list",
      "--json",
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].pattern).toBe("badsite.com");
  });

  it("dry-run does not persist", () => {
    cli(dataDir, [
      "admin",
      "policy",
      "block",
      "add",
      "https://dry-run.example.com",
      "--dry-run",
      "--json",
    ]);
    const rows = cliJson<{ pattern: string }[]>(dataDir, [
      "admin",
      "policy",
      "block",
      "list",
      "--json",
    ]);
    expect(rows.length).toBe(1); // still just the domain block
  });
});
