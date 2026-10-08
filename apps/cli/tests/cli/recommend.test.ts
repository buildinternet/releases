import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

/**
 * Integration coverage for the public `releases submit` command and the
 * `releases admin recommendations` review write-path. runCli spawns the CLI
 * with piped stdio, so `process.stdin.isTTY` is false in the child. We assert
 * the guard rails that fire BEFORE any network call — `--dry-run`, invalid
 * input, the required-status / required-org checks, and the destructive-delete
 * confirmation gate — plus that the verbs and flags surface in --help.
 */
describe("submit (public CLI integration)", () => {
  it("documents the command and its flags in help", () => {
    const { stdout, exitCode } = runCli(["submit", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--note");
    expect(stdout).toContain("--contact");
    expect(stdout).toContain("--dry-run");
  });

  it("previews the payload with --dry-run --json and sends nothing", () => {
    const { stdout, exitCode } = runCli([
      "submit",
      "https://example.com/releases",
      "--note",
      "GitHub: acme/acme",
      "--dry-run",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      dryRun: boolean;
      payload: { url: string; type: string; surface: string; note?: string };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.payload.url).toBe("https://example.com/releases");
    expect(parsed.payload.type).toBe("source");
    expect(parsed.payload.surface).toBe("cli");
    expect(parsed.payload.note).toBe("GitHub: acme/acme");
  });

  it("rejects an invalid url before any request", () => {
    const { stderr, exitCode } = runCli(["submit", "ftp://example.com/releases"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("url");
  });

  it("rejects an invalid --contact email before any request", () => {
    const { stderr, exitCode } = runCli([
      "submit",
      "https://example.com/releases",
      "--contact",
      "notanemail",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("email");
  });

  it("rejects a --note longer than the cap before any request", () => {
    const { stderr, exitCode } = runCli([
      "submit",
      "https://example.com/releases",
      "--note",
      "x".repeat(4001),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("too long");
  });

  it("reads the URL from stdin when no argument is given", () => {
    const { stdout, exitCode } = runCli(["submit", "--dry-run", "--json"], {
      input: "https://example.com/piped\n",
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { payload: { url: string } };
    expect(parsed.payload.url).toBe("https://example.com/piped");
  });
});

describe("admin recommendations review write-path (CLI integration)", () => {
  it("lists list / triage / archive / delete / notify-added subcommands in help", () => {
    const { stdout, exitCode } = runCli(["admin", "recommendations", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list");
    expect(stdout).toContain("triage");
    expect(stdout).toContain("archive");
    expect(stdout).toContain("delete");
    expect(stdout).toContain("notify-added");
  });

  it("requires --status on triage", () => {
    const { stderr, exitCode } = runCli(["admin", "recommendations", "triage", "rec_x"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("status");
  });

  it("rejects an invalid triage status before any request", () => {
    const { stderr, exitCode } = runCli([
      "admin",
      "recommendations",
      "triage",
      "rec_x",
      "--status",
      "bogus",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("triaged");
  });

  it("refuses a hard delete without --yes when stdin is not a TTY", () => {
    const { stderr, exitCode } = runCli(["admin", "recommendations", "delete", "rec_x"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--yes");
  });

  it("exposes --undo on archive and --yes on delete", () => {
    const archiveHelp = runCli(["admin", "recommendations", "archive", "--help"]);
    expect(archiveHelp.exitCode).toBe(0);
    expect(archiveHelp.stdout).toContain("--undo");

    const deleteHelp = runCli(["admin", "recommendations", "delete", "--help"]);
    expect(deleteHelp.exitCode).toBe(0);
    expect(deleteHelp.stdout).toContain("--yes");
  });

  it("documents notify-added flags in help", () => {
    const { stdout, exitCode } = runCli(["admin", "recommendations", "notify-added", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--org");
    expect(stdout).toContain("--source");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--json");
  });

  it("requires --org on notify-added", () => {
    const { stderr, exitCode } = runCli(["admin", "recommendations", "notify-added", "rec_x"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("org");
  });

  it("previews notify-added with --dry-run --json and sends nothing", () => {
    const { stdout, exitCode } = runCli([
      "admin",
      "recommendations",
      "notify-added",
      "rec_x",
      "--org",
      "acme",
      "--source",
      "changelog",
      "--dry-run",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      dryRun: boolean;
      wouldPost: string;
      body: { orgSlug: string; sourceSlug?: string };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldPost).toBe("/v1/admin/recommendations/rec_x/notify-added");
    expect(parsed.body).toEqual({ orgSlug: "acme", sourceSlug: "changelog" });
  });

  it("rejects a dirty notify-added identifier before any request", () => {
    const { stderr, exitCode } = runCli([
      "admin",
      "recommendations",
      "notify-added",
      "rec_x/../etc",
      "--org",
      "acme",
      "--dry-run",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("path-traversal");
  });
});
