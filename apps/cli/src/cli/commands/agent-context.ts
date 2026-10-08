import { Command } from "commander";
import { writeJson } from "../../lib/output.js";
import { VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentContextArg {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
  acceptsStdin: boolean;
}

export interface AgentContextOption {
  flags: string;
  description: string;
  required: boolean;
  default: unknown;
  acceptsStdin: boolean;
}

export interface AgentContextCommand {
  path: string[];
  summary: string;
  deprecated: boolean;
  deprecatedReplacement: string | null;
  args: AgentContextArg[];
  options: AgentContextOption[];
}

export interface AgentContextDocument {
  schemaVersion: "1";
  binary: "releases";
  version: string;
  exitCodes: Array<{ code: number; meaning: string }>;
  commands: AgentContextCommand[];
}

// ---------------------------------------------------------------------------
// Stdin-accepting flags allowlist
//
// Commander has no generic signal for "this flag accepts - for stdin". The
// pairs below are (command-path-suffix, flag-long-name) tuples that we know
// accept "-" to mean stdin. Extend this list whenever a new stdin-capable
// flag is added to the CLI.
// ---------------------------------------------------------------------------
const STDIN_FLAGS: Array<{ pathSuffix: string[]; flagName: string }> = [
  // releases import <file>
  { pathSuffix: ["import"], flagName: "<file>" },
  // releases admin source add --batch <file>
  { pathSuffix: ["add"], flagName: "--batch" },
  // releases admin source create --batch <file>
  { pathSuffix: ["create"], flagName: "--batch" },
  // releases admin webhook verify --body-file <path>
  { pathSuffix: ["verify"], flagName: "--body-file" },
  // releases admin overview update --content-file <path> (canonical)
  { pathSuffix: ["overview", "update"], flagName: "--content-file" },
  // releases admin overview-write --content-file <path> (deprecated alias)
  { pathSuffix: ["overview-write"], flagName: "--content-file" },
  // releases admin release {delete,suppress,unsuppress} --file <path>
  { pathSuffix: ["delete"], flagName: "--file" },
  { pathSuffix: ["suppress"], flagName: "--file" },
  { pathSuffix: ["unsuppress"], flagName: "--file" },
];

// ---------------------------------------------------------------------------
// Deprecated command detection
//
// Commands whose action is wrapped by warnDeprecatedAlias() are considered
// deprecated. We detect this via the command description, which always starts
// with "(deprecated — use <verb>)" per the pattern established across the
// codebase. This avoids needing to introspect the action function closure.
// ---------------------------------------------------------------------------
const DEPRECATED_DESCRIPTION_PREFIX = "(deprecated — use ";

function parseDeprecationFromDescription(description: string): {
  deprecated: boolean;
  deprecatedReplacement: string | null;
} {
  if (!description.startsWith(DEPRECATED_DESCRIPTION_PREFIX)) {
    return { deprecated: false, deprecatedReplacement: null };
  }
  // e.g. "(deprecated — use create) Add a new changelog source"
  const inner = description.slice(DEPRECATED_DESCRIPTION_PREFIX.length);
  const closeIdx = inner.indexOf(")");
  const replacement = closeIdx >= 0 ? inner.slice(0, closeIdx).trim() : null;
  return { deprecated: true, deprecatedReplacement: replacement };
}

// ---------------------------------------------------------------------------
// Introspection helpers
// ---------------------------------------------------------------------------

function pathEndsWith(path: string[], suffix: string[]): boolean {
  if (suffix.length > path.length) return false;
  for (let i = 0; i < suffix.length; i++) {
    if (path[path.length - suffix.length + i] !== suffix[i]) return false;
  }
  return true;
}

function isStdinFlag(commandPath: string[], flagString: string): boolean {
  // flagString is the option's flags string, e.g. "--batch <file>" or "<file>"
  // We check if either the long flag name appears, or if it's a positional.
  return STDIN_FLAGS.some(({ pathSuffix, flagName }) => {
    if (!pathEndsWith(commandPath, pathSuffix)) return false;
    return flagString.includes(flagName);
  });
}

function introspectCommand(cmd: Command, parentPath: string[]): AgentContextCommand[] {
  const name = cmd.name();
  // Skip the root program and pure group nodes that have no name or are the
  // root "releases" program (parent === null).
  if (!name || cmd.parent === null) {
    // Still descend into children for the root program.
    const results: AgentContextCommand[] = [];
    for (const sub of cmd.commands) {
      results.push(...introspectCommand(sub, parentPath));
    }
    return results;
  }

  const path = [...parentPath, name];

  const { deprecated, deprecatedReplacement } = parseDeprecationFromDescription(
    cmd.description() ?? "",
  );

  // Positional arguments
  // Commander exposes these via the public registeredArguments accessor (added
  // in Commander 10; the old ._args private field was removed in v12).
  const args: AgentContextArg[] = cmd.registeredArguments.map((a) => ({
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    description: a.description ?? "",
    acceptsStdin: false, // filled in below
  }));

  // Options — Commander stores these on .options[]
  const options: AgentContextOption[] = cmd.options.map((opt) => {
    // acceptsStdin: check both the flags string and the command path.
    const acceptsStdin = isStdinFlag(path, opt.flags);
    return {
      flags: opt.flags,
      description: opt.description ?? "",
      required: opt.mandatory ?? false,
      default: opt.defaultValue ?? null,
      acceptsStdin,
    };
  });

  // Also check positional args for stdin acceptance (e.g. `import <file>`)
  const argsWithStdin: AgentContextArg[] = args.map((a) => {
    // Positionals use the arg name as the "flag" key in the allowlist
    const syntheticFlagStr = `<${a.name}>`;
    if (isStdinFlag(path, syntheticFlagStr)) {
      // Set acceptsStdin structurally and annotate the description so agents
      // can discover stdin support both programmatically and in prose.
      const note = " (use - for stdin)";
      const description = a.description.includes("stdin") ? a.description : a.description + note;
      return {
        name: a.name,
        required: a.required,
        variadic: a.variadic,
        description,
        acceptsStdin: true,
      };
    }
    return a;
  });

  const result: AgentContextCommand = {
    path,
    summary: cmd.description() ?? "",
    deprecated,
    deprecatedReplacement,
    args: argsWithStdin,
    options,
  };

  const results: AgentContextCommand[] = [result];

  // Recurse into subcommands
  for (const sub of cmd.commands) {
    results.push(...introspectCommand(sub, path));
  }

  return results;
}

/**
 * Walk the Commander program tree and produce the agent-context document.
 * Exported for unit testing.
 */
export function buildAgentContext(program: Command): AgentContextDocument {
  const commands: AgentContextCommand[] = [];
  for (const sub of program.commands) {
    commands.push(...introspectCommand(sub, []));
  }

  return {
    schemaVersion: "1",
    binary: "releases",
    version: VERSION,
    exitCodes: [
      // TODO: source from EXIT_CODES constant once #111 lands.
      { code: 0, meaning: "success" },
      { code: 1, meaning: "application error" },
      { code: 2, meaning: "usage / provider error" },
      { code: 130, meaning: "cancellation (SIGINT)" },
    ],
    commands,
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerAgentContextCommand(program: Command): void {
  program
    .command("agent-context")
    .description("Emit a versioned JSON document describing every command, argument, and option")
    .addHelpText(
      "after",
      `
Emit a versioned JSON document describing every command, argument, option,
and exit code in this CLI.

Designed for agents that need machine-readable command metadata without
parsing per-command --help output.

Schema version: 1 (bumps on breaking field renames/removals; additive
changes are silent).

Examples:
  releases agent-context | jq '.commands[] | select(.deprecated)'
  releases agent-context | jq '.exitCodes'`,
    )
    .action(async () => {
      const doc = buildAgentContext(program);
      await writeJson(doc);
    });
}
