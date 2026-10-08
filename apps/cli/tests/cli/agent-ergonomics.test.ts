import { describe, it, expect } from "bun:test";
import { runCli } from "../utils.js";

describe("unknown-command suggestion (#1)", () => {
  it("suggests 'search' when the user types a typo like 'serch'", () => {
    const { stderr, exitCode } = runCli(["serch"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown command 'serch'");
    expect(stderr).toContain("search");
  });

  it("suggests 'search' for multi-arg typo 'serch foo'", () => {
    const { stderr, exitCode } = runCli(["serch", "foo"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown command 'serch'");
    expect(stderr).toContain("search");
  });

  it("does not error when no arguments are passed — shows styled help", () => {
    const { stdout, exitCode } = runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("releases");
    expect(stdout).toContain("Commands:");
  });

  it("valid commands still work after the fix", () => {
    const { exitCode } = runCli(["categories"]);
    expect(exitCode).toBe(0);
  });
});

describe("'sources' alias for 'list' (#3)", () => {
  it("releases sources --help exits 0 and shows list usage", () => {
    const { stdout, exitCode } = runCli(["sources", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list");
    expect(stdout).toContain("sources");
  });

  it("releases sources is NOT treated as an unknown command", () => {
    // The command resolves to the list handler; it will fail at the API call
    // (test URL), but not with an "unknown command" / "too many arguments" error.
    const { stderr } = runCli(["sources"]);
    expect(stderr).not.toContain("unknown command");
    expect(stderr).not.toContain("too many arguments");
  });

  it("releases admin source --help does NOT show a 'sources' alias", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "--help"]);
    expect(exitCode).toBe(0);
    // The top-level alias must not leak into the admin subtree
    expect(stdout).not.toContain("list|sources");
  });
});

describe("Examples in --help output (#2)", () => {
  it("releases list --help contains an Examples block", () => {
    const { stdout, exitCode } = runCli(["list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("--kind sdk");
    expect(stdout).toContain("--org vercel");
  });

  it("releases sources --help (alias) also contains the Examples block", () => {
    const { stdout, exitCode } = runCli(["sources", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("--kind sdk");
  });

  it("releases changelog --help contains an Examples block", () => {
    const { stdout, exitCode } = runCli(["changelog", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("releases changelog --json");
  });

  it("releases search --help contains an Examples block", () => {
    const { stdout, exitCode } = runCli(["search", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("--kind sdk");
  });

  it("releases admin source update --help contains an Examples block with --kind", () => {
    const { stdout, exitCode } = runCli(["admin", "source", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("--kind sdk");
  });

  it("releases admin product create --help contains an Examples block with --kind", () => {
    const { stdout, exitCode } = runCli(["admin", "product", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("--kind sdk");
  });

  it("releases admin product update --help contains an Examples block with --kind", () => {
    const { stdout, exitCode } = runCli(["admin", "product", "update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("--kind");
  });
});
