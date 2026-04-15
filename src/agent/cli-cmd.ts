import { resolve } from "path";

/** Resolve the CLI command — env override, source-mode detection, or default binary name. */
export function resolveCLICmd(): string {
  if (process.env.RELEASED_CLI_CMD) return process.env.RELEASED_CLI_CMD;
  if (process.argv[1]?.endsWith(".ts")) {
    const projectRoot = resolve(import.meta.dir, "../..");
    return `bun ${projectRoot}/src/index.ts`;
  }
  return "releases";
}
