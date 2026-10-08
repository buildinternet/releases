/**
 * Typed CLI errors + a structured JSON error payload.
 *
 * Agents that invoke the CLI with `--json` expect a parseable payload on the
 * happy path; an unstructured stderr dump on the failure path forces them to
 * fall back to brittle string-matching exactly when they most need to branch.
 * `ApiError` / `InvalidInputError` carry machine-readable fields, and
 * `toErrorPayload` renders any thrown value into a stable `{ error: … }` shape
 * (emitted to stdout by the top-level handler when `--json` is set).
 */

import { decodeApiError, isApiError } from "@buildinternet/releases-api-types";

/** A non-2xx response from the Releases API. Message format is preserved for
 * the existing `/API error \(NNN\) on METHOD path/` characterization tests. */
export class ApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  /** The server-provided message (without the `API error (…)` envelope). */
  readonly serverMessage: string;

  constructor(opts: { status: number; method: string; path: string; serverMessage: string }) {
    super(`API error (${opts.status}) on ${opts.method} ${opts.path}: ${opts.serverMessage}`);
    this.name = "ApiError";
    this.status = opts.status;
    this.method = opts.method;
    this.path = opts.path;
    this.serverMessage = opts.serverMessage;
  }
}

/** An expected, user-facing CLI failure (e.g. an unreadable file). Printed as a
 * clean one-line message in human mode and serialized as `kind: "error"` under
 * `--json` — distinct from an unexpected internal error, which keeps its stack. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** A user-supplied identifier or path that failed input hardening (control
 * characters, traversal, embedded query/fragment, percent-encoding). Thrown
 * before any network or filesystem access. */
export class InvalidInputError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.name = "InvalidInputError";
    this.field = field;
  }
}

export type CliErrorPayload = {
  error: {
    kind: "api" | "invalid_input" | "error";
    message: string;
    status?: number;
    method?: string;
    path?: string;
    field?: string;
  };
};

/**
 * Pull the human message out of a non-2xx API body. The API emits the
 * standardized nested envelope `{ error: { code, type, message } }`; a real
 * envelope is decoded via api-types' canonical `decodeApiError`, the single
 * source of truth for the wire shape.
 *
 * Returns `undefined` (so the caller falls back to `res.statusText`) for
 * anything that isn't a full envelope — an empty message, or a malformed body
 * like a bare `{ error: "not_found" }`. We keep a manual fallback for a legacy
 * flat `{ message }` body (which predates the envelope and so is NOT an
 * `isApiError`); `decodeApiError` can't read that on its own.
 */
export function apiErrorMessage(body: unknown): string | undefined {
  if (isApiError(body)) {
    const { message } = decodeApiError(body);
    if (message.length > 0) return message;
  }
  const flat = (body as { message?: unknown } | null)?.message;
  return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

/** Render any thrown value into the stable structured error payload. */
export function toErrorPayload(err: unknown): CliErrorPayload {
  if (err instanceof ApiError) {
    return {
      error: {
        kind: "api",
        message: err.serverMessage,
        status: err.status,
        method: err.method,
        path: err.path,
      },
    };
  }
  if (err instanceof InvalidInputError) {
    return { error: { kind: "invalid_input", message: err.message, field: err.field } };
  }
  return { error: { kind: "error", message: err instanceof Error ? err.message : String(err) } };
}
