/**
 * Input hardening for agent-driven invocations.
 *
 * The trust model: "the agent is not a trusted operator." Agents fail in ways
 * humans rarely do — hallucinated path traversals (`../../.ssh`), embedded
 * query params or fragments inside an ID, double percent-encoding — so the CLI
 * validates user-supplied identifiers and file paths as adversarially as a web
 * API would, *before* anything is encoded into a URL or handed to the
 * filesystem.
 *
 * Two layers:
 *   - `assertCleanIdentifier` runs at the RAW user-input boundary (entity
 *     resolvers), where rejecting `%`/`?`/`#` is correct because the CLI itself
 *     adds percent-encoding downstream.
 *   - `assertSafePath` is a defense-in-depth backstop at the HTTP layer. By the
 *     time a path reaches `apiFetch` the dangerous segments are already
 *     `encodeURIComponent`-ed, so this only rejects raw control characters
 *     (which a correct encoder never emits) to avoid false-positives on
 *     legitimately percent-encoded segments (e.g. an encoded URL in the path).
 */

import { InvalidInputError } from "./errors.js";

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a raw, user-supplied identifier (slug, typed ID, or `org/repo`
 * coordinate) before it is encoded into a request path. Rejects the
 * agent-specific hallucination patterns; allows the characters real
 * identifiers use (alphanumerics, `_ - . / :`).
 */
export function assertCleanIdentifier(value: string, field = "identifier"): void {
  if (value.length === 0) throw new InvalidInputError(field, "is empty");
  if (hasControlChar(value)) throw new InvalidInputError(field, "contains a control character");
  if (/\s/.test(value)) throw new InvalidInputError(field, "contains whitespace");
  if (value.includes("..")) throw new InvalidInputError(field, "contains a path-traversal segment");
  if (value.includes("%")) throw new InvalidInputError(field, "contains a percent-encoded segment");
  if (value.includes("?") || value.includes("#"))
    throw new InvalidInputError(field, "contains an embedded query or fragment");
  if (value.includes("\\")) throw new InvalidInputError(field, "contains a backslash");
}

/**
 * Defense-in-depth backstop on a fully-assembled request path. Rejects raw
 * control characters anywhere in the path — a correctly percent-encoded path
 * never contains them, so this catches anything that bypassed
 * `assertCleanIdentifier` without false-positiving on encoded segments.
 */
export function assertSafePath(path: string): void {
  if (hasControlChar(path)) throw new InvalidInputError("path", "contains a control character");
}

/**
 * Validate a path passed to a file-reading flag (`--batch`, `--file`,
 * `--content-file`, …). The stdin sentinel `-` is handled by the caller and
 * never reaches here. Rejects control characters and any `..` traversal
 * segment, which is the hallucination pattern that turns `--batch <file>` into
 * an arbitrary-file read (`../../../etc/passwd`). Absolute paths without a
 * traversal segment stay allowed so existing human workflows keep working.
 */
export function assertSafeReadPath(path: string): void {
  if (hasControlChar(path))
    throw new InvalidInputError("file path", "contains a control character");
  const segments = path.split(/[/\\]/);
  if (segments.includes(".."))
    throw new InvalidInputError("file path", "contains a path-traversal segment (..)");
}
