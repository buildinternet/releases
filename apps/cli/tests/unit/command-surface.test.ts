import { describe, it, expect } from "bun:test";
import type { Command } from "commander";
import { program } from "../../src/cli/program.js";

/**
 * Registration coverage for the flags, arguments, and subcommands that agents
 * and scripts depend on. Walks the commander tree in-process instead of
 * spawning `releases <cmd> --help` once per flag. Each command's behavior
 * (validation, request bodies) is covered by its own unit or CLI test; this
 * table only proves the surface stays wired up.
 *
 * Entries: `--flag` is an option, `<name>` is a positional argument, and a
 * bare word is a subcommand (or alias).
 */
const SURFACE: Record<string, string[]> = {
  "": ["changelog"],
  tail: ["--limit", "--count"],
  list: ["--kind"],
  search: ["--kind"],
  submit: ["--note", "--contact", "--dry-run"],
  "webhook list": ["--workspace"],
  "webhook add": ["--workspace"],
  "webhook show": ["--workspace"],
  "webhook edit": ["--workspace"],
  "webhook remove": ["--workspace"],
  "webhook test": ["--workspace"],
  "webhook rotate-secret": ["--workspace"],
  "workspace list": ["--json"],
  "keys create": ["--no-browser"],
  "keys list": ["--no-browser"],
  "keys revoke": ["--no-browser"],
  "publish-token create": ["--no-browser"],
  "publish-token list": ["--no-browser"],
  "publish-token revoke": ["--no-browser"],

  "admin work": ["start", "status", "end"],
  "admin feedback": ["triage", "archive", "delete"],
  "admin feedback archive": ["--undo"],
  "admin feedback delete": ["--yes"],
  "admin recommendations": ["list", "triage", "archive", "delete", "notify-added"],
  "admin recommendations archive": ["--undo"],
  "admin recommendations delete": ["--yes"],
  "admin recommendations notify-added": ["--org", "--source", "--dry-run", "--json"],
  "admin playbook": ["--notes-file"],
  "admin overview": ["get", "list", "plan", "inputs", "update"],
  "admin overview list": [
    "--stale-days",
    "--missing",
    "--has-activity",
    "--stale",
    "--stale-min-releases",
  ],
  "admin overview plan": ["--stale-days", "--missing", "--has-activity"],
  "admin overview inputs": ["--check", "--max-content-chars"],
  "admin overview update": ["--content-file", "--citations-file", "--unescape-html"],

  "admin org create": ["--strict", "--tags"],
  "admin org add": ["--strict"],
  "admin org update": ["--featured", "--no-featured", "--paused", "--no-paused", "--discovery"],
  "admin org edit": ["--featured", "--no-featured", "--paused", "--no-paused", "--discovery"],
  "admin org delete": ["--hard", "--yes"],
  "admin org remove": ["--hard"],
  "admin org create-stub": ["--location", "--from-file", "--domain"],
  "admin org create-stub-from-domain": ["<domain>", "--dry-run"],
  "admin org promote": ["<slug>", "--dry-run"],

  "admin product create": ["--kind"],
  "admin product update": ["--kind", "--no-kind"],
  "admin product list": ["--kind"],

  "admin source create": ["--keyword-allow", "--metadata-set", "--primary", "--strict"],
  "admin source add": ["--strict"],
  "admin source update": ["--discovery", "--kind", "--no-kind", "--parse-instructions-file"],
  "admin source edit": ["--parse-instructions-file"],
  "admin source delete": ["--hard"],
  "admin source backfill": ["--max-windows", "--no-dry-run", "--markdown-file", "--wait", "--json"],
  "admin source backfill-status": ["<instanceId>", "--json"],
  "admin source reextract": ["--snapshot-id", "--max-windows", "--no-dry-run", "--json"],

  "admin release delete": ["<ids>", "--file", "--hard", "--source"],
  "admin release suppress": ["<ids>", "--file"],
  "admin release unsuppress": ["<ids>", "--file"],
  "admin release refetch": ["<releaseId>", "--url", "--apply", "--json"],
};

function findCommand(path: string): Command | undefined {
  let cmd: Command | undefined = program;
  for (const name of path.split(" ").filter(Boolean)) {
    cmd = cmd?.commands.find((c) => c.name() === name || c.aliases().includes(name));
  }
  return cmd;
}

function surfaceOf(cmd: Command): Set<string> {
  return new Set([
    ...cmd.options.flatMap((o) => [o.long, o.short].filter((f): f is string => !!f)),
    ...cmd.registeredArguments.map((a) => `<${a.name()}>`),
    ...cmd.commands.flatMap((c) => [c.name(), ...c.aliases()]),
  ]);
}

describe("command surface", () => {
  for (const [path, expected] of Object.entries(SURFACE)) {
    it(`releases ${path || "(root)"}`.trim(), () => {
      const cmd = findCommand(path);
      expect(cmd).toBeDefined();
      const surface = surfaceOf(cmd!);
      expect(expected.filter((e) => !surface.has(e))).toEqual([]);
    });
  }

  it("retired overview batch subcommand stays gone", () => {
    expect(findCommand("admin overview batch")).toBeUndefined();
  });
});
