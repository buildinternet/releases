import type { DescribeRouteOptions } from "hono-openapi";
import { ERROR_ENVELOPE_SCHEMA } from "./openapi-error.js";

const RETENTION_DESCRIPTION =
  "Optional idempotency key. Reuse the same key only for an identical request; successful responses are replayable for 24 hours.";

export const idempotencyKeyParameter = {
  in: "header" as const,
  name: "Idempotency-Key",
  required: false,
  description: RETENTION_DESCRIPTION,
  schema: {
    type: "string",
    minLength: 16,
    maxLength: 255,
    pattern: "^[\\x21-\\x7e]+$",
  },
} as const;

export function idempotentPostOpenApi(input: {
  summary: string;
  successStatus: 200 | 201 | 202;
  successDescription: string;
  tags: string[];
}): DescribeRouteOptions {
  return {
    tags: input.tags,
    summary: input.summary,
    description: RETENTION_DESCRIPTION,
    parameters: [idempotencyKeyParameter],
    responses: {
      [input.successStatus]: {
        description: input.successDescription,
        headers: {
          "Idempotency-Replayed": {
            description: "`true` when this response is a replay of an earlier successful request.",
            schema: { type: "string", enum: ["true"] },
          },
        },
      },
      409: {
        description:
          "The key is already processing, or was reused with a different request fingerprint.",
        content: { "application/json": { schema: ERROR_ENVELOPE_SCHEMA } },
      },
      503: {
        description: "Idempotency storage or response replay is temporarily unavailable.",
        content: { "application/json": { schema: ERROR_ENVELOPE_SCHEMA } },
      },
    },
  };
}
