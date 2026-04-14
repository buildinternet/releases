import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTempDataDir, cli, cliJson } from "./roundtrip-helper.js";

describe("CLI org lifecycle", () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ dataDir, cleanup } = createTempDataDir());
  });

  afterAll(() => cleanup());

  it("starts with no organizations", () => {
    const orgs = cliJson<unknown[]>(dataDir, ["admin", "org", "list", "--json"]);
    expect(orgs).toEqual([]);
  });

  it("adds an organization", () => {
    const result = cli(dataDir, ["admin", "org", "add", "Acme Corp", "--category", "cloud", "--json"]);
    expect(result.exitCode).toBe(0);
    const org = JSON.parse(result.stdout);
    expect(org.name).toBe("Acme Corp");
    expect(org.slug).toBe("acme-corp");
    expect(org.category).toBe("cloud");
  });

  it("appears in org list", () => {
    const orgs = cliJson<{ slug: string }[]>(dataDir, ["admin", "org", "list", "--json"]);
    expect(orgs.length).toBe(1);
    expect(orgs[0].slug).toBe("acme-corp");
  });

  it("shows org details", () => {
    const result = cliJson<{ name: string; slug: string; category: string }>(
      dataDir,
      ["admin", "org", "show", "acme-corp", "--json"],
    );
    expect(result.name).toBe("Acme Corp");
    expect(result.slug).toBe("acme-corp");
    expect(result.category).toBe("cloud");
  });

  it("edits the organization category", () => {
    const result = cli(dataDir, ["admin", "org", "edit", "acme-corp", "--category", "ai", "--json"]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.category).toBe("ai");
  });

  it("edits the organization name", () => {
    const result = cli(dataDir, ["admin", "org", "edit", "acme-corp", "--name", "Acme Inc", "--json"]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.name).toBe("Acme Inc");
  });

  it("reflects edits in org show", () => {
    const result = cliJson<{ name: string; category: string }>(
      dataDir,
      ["admin", "org", "show", "acme-corp", "--json"],
    );
    expect(result.name).toBe("Acme Inc");
    expect(result.category).toBe("ai");
  });

  it("rejects duplicate org slug", () => {
    const result = cli(dataDir, ["admin", "org", "add", "Acme Corp", "--slug", "acme-corp"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");
  });

  it("adds a second organization", () => {
    const result = cli(dataDir, ["admin", "org", "add", "Beta Labs", "--domain", "beta.io", "--json"]);
    expect(result.exitCode).toBe(0);
    const org = JSON.parse(result.stdout);
    expect(org.slug).toBe("beta-labs");
    expect(org.domain).toBe("beta.io");
  });

  it("lists both organizations", () => {
    const orgs = cliJson<unknown[]>(dataDir, ["admin", "org", "list", "--json"]);
    expect(orgs.length).toBe(2);
  });

  it("filters org list by query", () => {
    const orgs = cliJson<{ slug: string }[]>(dataDir, ["admin", "org", "list", "--query", "beta", "--json"]);
    expect(orgs.length).toBe(1);
    expect(orgs[0].slug).toBe("beta-labs");
  });

  it("removes an organization", () => {
    const result = cli(dataDir, ["admin", "org", "remove", "beta-labs", "--json"]);
    expect(result.exitCode).toBe(0);
    const removed = JSON.parse(result.stdout);
    expect(removed.removed).toBe("beta-labs");
  });

  it("org is gone after removal", () => {
    const orgs = cliJson<{ slug: string }[]>(dataDir, ["admin", "org", "list", "--json"]);
    expect(orgs.length).toBe(1);
    expect(orgs[0].slug).toBe("acme-corp");
  });

  it("removing a non-existent org fails", () => {
    const result = cli(dataDir, ["admin", "org", "remove", "nonexistent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("showing a non-existent org fails", () => {
    const result = cli(dataDir, ["admin", "org", "show", "nonexistent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("org add with description", () => {
    const result = cli(dataDir, [
      "admin", "org", "add", "Described Org",
      "--description", "A well-described organization",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const org = JSON.parse(result.stdout);
    expect(org.description).toBe("A well-described organization");
  });

  it("edits org description", () => {
    const result = cli(dataDir, [
      "admin", "org", "edit", "described-org",
      "--description", "Updated description",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.description).toBe("Updated description");
  });

  it("org add with avatar", () => {
    const result = cli(dataDir, [
      "admin", "org", "add", "Avatar Org",
      "--avatar", "https://example.com/logo.png",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const org = JSON.parse(result.stdout);
    expect(org.avatarUrl).toBe("https://example.com/logo.png");
  });

  it("edits org avatar", () => {
    const result = cli(dataDir, [
      "admin", "org", "edit", "avatar-org",
      "--avatar", "https://example.com/new-logo.png",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.avatarUrl).toBe("https://example.com/new-logo.png");
  });

  it("clears org avatar with --no-avatar", () => {
    const result = cli(dataDir, [
      "admin", "org", "edit", "avatar-org",
      "--no-avatar",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.avatarUrl).toBeNull();
  });
});
