// Structured JSON logger for worker code. Workers Logs indexes top-level keys
// of JSON-stringified `console.*` lines as filterable fields; this helper
// standardizes the payload shape across the four workers.
//
// Severity is set by which `console.*` function is invoked — Workers Logs
// reads the function for the level field — so callers pick the level via the
// first arg and the helper dispatches accordingly. Don't put `level` in the
// payload.
//
// Worker-safe: no `fs` / `path` / Node-only imports. Do not use
// `@buildinternet/releases-lib/logger` in a worker — it writes to a virtual
// fs discarded per-request and double-tags components with its hard-coded
// `[releases]` prefix.

type Level = "info" | "warn" | "error";

export interface LogPayload {
  component: string;
  event: string;
  [key: string]: unknown;
}

export function logEvent(level: Level, payload: LogPayload): void {
  const line = JSON.stringify(payload, errorReplacer);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// Default JSON.stringify on an Error produces `{}` — unwrap so the message
// and stack actually surface in Workers Logs.
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    if (value.cause !== undefined) {
      out.cause = value.cause;
    }
    return out;
  }
  return value;
}
