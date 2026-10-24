/**
 * Every non-2xx response from the Releases API carries the envelope
 * `{ error: { code, type, message, details? } }`. `type` is a fixed category
 * tied to the HTTP status; `code` is specific and stable but open-ended, so
 * branch defensively on codes you don't recognize.
 */
export class ReleasesError extends Error {
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  /** Specific machine code, e.g. `not_found`, `rate_limited`. */
  readonly code: string;
  /** Coarse category, e.g. `not_found`, `validation`, `auth`, `internal`. */
  readonly type: string;
  readonly details?: unknown;
  readonly method: string;
  readonly path: string;

  constructor(init: {
    status: number;
    code: string;
    type: string;
    message: string;
    details?: unknown;
    method: string;
    path: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ReleasesError";
    this.status = init.status;
    this.code = init.code;
    this.type = init.type;
    this.details = init.details;
    this.method = init.method;
    this.path = init.path;
  }
}

type Envelope = { error: { code: string; type: string; message: string; details?: unknown } };

function isEnvelope(body: unknown): body is Envelope {
  const error = (body as { error?: unknown } | null)?.error as Record<string, unknown> | undefined;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof error.code === "string" &&
    typeof error.type === "string" &&
    typeof error.message === "string"
  );
}

/** Build a `ReleasesError` from a failed response's status and parsed body. */
export function errorFromResponse(
  status: number,
  statusText: string,
  body: unknown,
  method: string,
  path: string,
): ReleasesError {
  if (isEnvelope(body)) {
    const { code, type, message, details } = body.error;
    return new ReleasesError({ status, code, type, message, details, method, path });
  }
  return new ReleasesError({
    status,
    code: "unknown_error",
    type: status >= 500 ? "internal" : "unknown",
    message: statusText || `HTTP ${status}`,
    method,
    path,
  });
}
