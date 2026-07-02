import { z } from "zod";
import { ERROR_TYPES, type ErrorType, type ErrorCode } from "@buildinternet/releases-core/errors";

/**
 * The one on-the-wire error shape. `type` is constrained (documents the
 * contract, powers OpenAPI); `code` is an open string so a new server code an
 * older client doesn't recognize still parses. The throwable hierarchy in
 * `@releases/lib/releases-error` serializes to this via `toWire()`.
 */
export const errorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z
        .string()
        .describe(
          "Stable, specific machine code (e.g. `not_found`, `rate_limited`). Never reworded once shipped, but open-ended — branch defensively on codes you don't recognize.",
        ),
      type: z
        .enum(ERROR_TYPES)
        .describe(
          "Coarse category from a fixed set; determines the HTTP status. Safe to switch on.",
        ),
      message: z.string().describe("Human-readable explanation. May change; do not parse."),
      details: z
        .unknown()
        .optional()
        .describe(
          "Optional structured context carried by select codes (e.g. `database_not_initialized`).",
        ),
    }),
  })
  .describe(
    "Standardized error response — every non-2xx response uses this shape. Switch on `error.type` (fixed set → HTTP status) or match `error.code` (specific, stable). See https://releases.sh/docs/api/errors.",
  );

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Lenient variant used ONLY for decode: `type` is left open so an unknown
 * category (older client, newer server) does not reject.
 */
const lenientEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    type: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export interface DecodedApiError {
  code: string;
  type: ErrorType;
  message: string;
  details?: unknown;
}

/**
 * Parse an API error body into a typed, normalized shape. Forward-compatible: a
 * malformed body or an unknown `type` degrades to `internal` and never throws.
 */
export function decodeApiError(body: unknown): DecodedApiError {
  const parsed = lenientEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return { code: "internal_error", type: "internal", message: "Unknown error" };
  }
  const { code, type, message, details } = parsed.data.error;
  const normalizedType: ErrorType = (ERROR_TYPES as readonly string[]).includes(type)
    ? (type as ErrorType)
    : "internal";
  return details === undefined
    ? { code, type: normalizedType, message }
    : { code, type: normalizedType, message, details };
}

/** True if `body` is an API error envelope; if `code` is given, also matches it. */
export function isApiError(body: unknown, code?: ErrorCode): boolean {
  const parsed = lenientEnvelopeSchema.safeParse(body);
  if (!parsed.success) return false;
  return code === undefined || parsed.data.error.code === code;
}
