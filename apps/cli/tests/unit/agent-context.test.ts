import { describe, it, expect } from "bun:test";
import { program } from "../../src/cli/program.js";
import { buildAgentContext } from "../../src/cli/commands/agent-context.js";

describe("buildAgentContext", () => {
  const doc = buildAgentContext(program);

  it("has schemaVersion === '1'", () => {
    expect(doc.schemaVersion).toBe("1");
  });

  it("has binary === 'releases'", () => {
    expect(doc.binary).toBe("releases");
  });

  it("has a non-empty version string", () => {
    expect(typeof doc.version).toBe("string");
    expect(doc.version.length).toBeGreaterThan(0);
  });

  it("has exit codes including 0 and 1", () => {
    const codes = doc.exitCodes.map((e) => e.code);
    expect(codes).toContain(0);
    expect(codes).toContain(1);
    expect(codes).toContain(2);
    expect(codes).toContain(130);
  });

  it("has more than 20 commands (covers the full CLI tree)", () => {
    expect(doc.commands.length).toBeGreaterThan(20);
  });

  it("every command has a non-empty path array", () => {
    for (const cmd of doc.commands) {
      expect(Array.isArray(cmd.path)).toBe(true);
      expect(cmd.path.length).toBeGreaterThan(0);
      for (const segment of cmd.path) {
        expect(typeof segment).toBe("string");
        expect(segment.length).toBeGreaterThan(0);
      }
    }
  });

  it("every command has deprecated as a boolean (never undefined)", () => {
    for (const cmd of doc.commands) {
      expect(typeof cmd.deprecated).toBe("boolean");
      // Must be strictly true or false — never undefined.
      expect(cmd.deprecated === true || cmd.deprecated === false).toBe(true);
    }
  });

  it("every option has flags and description strings, with boolean invariants", () => {
    for (const cmd of doc.commands) {
      for (const opt of cmd.options) {
        expect(typeof opt.flags).toBe("string");
        expect(opt.flags.length).toBeGreaterThan(0);
        expect(typeof opt.description).toBe("string");
        expect(opt.description.length).toBeGreaterThan(0);
        expect(typeof opt.acceptsStdin).toBe("boolean");
        expect(typeof opt.required).toBe("boolean");
      }
    }
  });

  it("includes admin source create with correct shape", () => {
    const cmd = doc.commands.find(
      (c) =>
        c.path.length === 3 &&
        c.path[0] === "admin" &&
        c.path[1] === "source" &&
        c.path[2] === "create",
    );
    expect(cmd).toBeDefined();
    expect(cmd!.deprecated).toBe(false);
    expect(cmd!.deprecatedReplacement).toBeNull();
    const batchOpt = cmd!.options.find((o) => o.flags.includes("--batch"));
    expect(batchOpt).toBeDefined();
    expect(batchOpt!.acceptsStdin).toBe(true);
  });

  it("deprecated alias commands are marked with deprecated: true and a replacement", () => {
    // The `add` command under admin source is a deprecated alias for `create`.
    const addCmd = doc.commands.find(
      (c) =>
        c.path.length === 3 &&
        c.path[0] === "admin" &&
        c.path[1] === "source" &&
        c.path[2] === "add",
    );
    expect(addCmd).toBeDefined();
    expect(addCmd!.deprecated).toBe(true);
    expect(addCmd!.deprecatedReplacement).toBe("create");

    // The `show` top-level command is a deprecated alias for `get`.
    const showCmd = doc.commands.find((c) => c.path.length === 1 && c.path[0] === "show");
    expect(showCmd).toBeDefined();
    expect(showCmd!.deprecated).toBe(true);
    expect(showCmd!.deprecatedReplacement).toBe("get");
  });

  it("webhook add --format documents json, slack, and discord", () => {
    const cmd = doc.commands.find((c) => c.path.join(" ") === "webhook add");
    expect(cmd).toBeDefined();
    const opt = cmd!.options.find((o) => o.flags.includes("--format"));
    expect(opt).toBeDefined();
    expect(opt!.description).toContain("discord");
    expect(opt!.description).toContain("slack");
  });

  it("webhook verify --body-file is marked acceptsStdin", () => {
    const cmd = doc.commands.find((c) => c.path.at(-1) === "verify" && c.path.includes("webhook"));
    expect(cmd).toBeDefined();
    const opt = cmd!.options.find((o) => o.flags.includes("--body-file"));
    expect(opt).toBeDefined();
    expect(opt!.acceptsStdin).toBe(true);
  });

  it("overview-write --content-file is marked acceptsStdin", () => {
    const cmd = doc.commands.find((c) => c.path.at(-1) === "overview-write");
    expect(cmd).toBeDefined();
    const opt = cmd!.options.find((o) => o.flags.includes("--content-file"));
    expect(opt).toBeDefined();
    expect(opt!.acceptsStdin).toBe(true);
  });

  it("import <file> positional is annotated with stdin note", () => {
    const cmd = doc.commands.find((c) => c.path.at(-1) === "import");
    expect(cmd).toBeDefined();
    const fileArg = cmd!.args.find((a) => a.name === "file");
    expect(fileArg).toBeDefined();
    expect(fileArg!.description).toContain("stdin");
  });

  it("every arg has acceptsStdin as a boolean (never undefined)", () => {
    for (const cmd of doc.commands) {
      for (const arg of cmd.args) {
        expect(typeof arg.acceptsStdin).toBe("boolean");
      }
    }
  });
});
