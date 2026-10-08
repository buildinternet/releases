import { assertSafeReadPath } from "./validate-input.js";
import { CliError } from "./errors.js";

/**
 * Read content from a file path or stdin.
 *
 * Pass `"-"` to read from stdin; any other value is treated as a file path.
 * The path is hardened first: a `..` traversal segment (the way an agent turns
 * `--batch <file>` into an arbitrary-file read) is rejected before any read.
 *
 * Errors are thrown, not exited on, so they reach the top-level handler — which
 * serializes them to the structured `{ error }` payload under `--json`. A
 * traversal is an `InvalidInputError` (`kind: "invalid_input"`); an unreadable
 * file is a `CliError` (`kind: "error"`), each printed as a clean one-line
 * message in human mode.
 */
export async function readContentArg(pathOrDash: string): Promise<string> {
  if (pathOrDash === "-") return Bun.stdin.text();
  // Outside the try so the typed InvalidInputError propagates as-is rather than
  // being re-wrapped as a read failure.
  assertSafeReadPath(pathOrDash);
  try {
    return await Bun.file(pathOrDash).text();
  } catch (err) {
    throw new CliError(
      `cannot read file "${pathOrDash}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read and parse a raw JSON body from a `--input` flag (the agent-ergonomic
 * raw-payload path, #324 item 3). Lets an agent send the request shape directly
 * instead of reverse-mapping it onto a dozen bespoke `--name/--url/--type/…`
 * flags.
 *
 * Three forms, disambiguated without a mode flag:
 *   - a literal JSON string (`--input '{"name":"…"}'`) — the common agent case;
 *   - `@<path>` — read the body from a file (hardened against `..` traversal via
 *     `readContentArg`);
 *   - `-` — read the body from stdin.
 *
 * A literal JSON value never begins with `@`, so the `@`-prefix file sigil is
 * unambiguous against an inline object/array/scalar. A parse failure throws a
 * `CliError`, so it surfaces as the structured `{ error }` payload under
 * `--json` rather than an unstructured crash.
 */
export async function readJsonInputArg(value: string): Promise<unknown> {
  let raw: string;
  if (value === "-") {
    raw = await Bun.stdin.text();
  } else if (value.startsWith("@")) {
    raw = await readContentArg(value.slice(1));
  } else {
    raw = value;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      `--input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
