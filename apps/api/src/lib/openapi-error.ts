/**
 * Shared `$ref` to the single error schema registered under
 * `components.schemas.ErrorEnvelope` (see `openapi.ts`, which derives it
 * from `errorEnvelopeSchema`). Every documented 4xx/5xx response should
 * point here instead of inlining `resolver(errorEnvelopeSchema)` — that
 * used to duplicate the full schema at every response site (~206 of them);
 * a `$ref` keeps the spec small and gives every response one canonical
 * error shape to render.
 */
export const ERROR_ENVELOPE_SCHEMA = { $ref: "#/components/schemas/ErrorEnvelope" } as const;

/** A standard `application/json` error response: description + the shared envelope `$ref`. */
export function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: ERROR_ENVELOPE_SCHEMA } },
  };
}
