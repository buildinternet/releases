/**
 * Yoga plugins for /v1/graphql — query-shape limits + introspection gate.
 * Extracted from handler.ts so tests can build a yoga with the same wiring.
 *
 * Order matches the GraphQL request lifecycle: parse → validate → execute.
 * Token-count is a parse-time guard (cheapest, runs first); the rest are
 * validation-time visitors.
 */
import { useDisableIntrospection } from "@envelop/disable-introspection";
import { costLimitPlugin } from "@escape.tech/graphql-armor-cost-limit";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { maxTokensPlugin } from "@escape.tech/graphql-armor-max-tokens";
import type { Plugin } from "graphql-yoga";

// Tuned to comfortably accommodate the homepage ticker
// (depth 4: latestReleases.items.source.org.slug) plus headroom for a
// couple more levels, while rejecting the obvious abuse shapes:
//
//   - depth bombs: nested `org { products { sources { releases { source { … } } } } }`
//   - alias bombs: `latestReleases` aliased N times in one document
//   - parser DoS: huge documents that explode token count
//   - resolver fan-out: cost = (objectCost + scalarCost·breadth) × depthFactor^depth
//
// Per-list-field upper bounds are enforced inside the resolvers
// (clampLimit at 100 in schema.ts), so cost-limit catches alias abuse
// rather than absurd `limit:` values.
export const MAX_QUERY_DEPTH = 6;
export const MAX_QUERY_ALIASES = 15;
export const MAX_QUERY_TOKENS = 1000;
export const MAX_QUERY_COST = 1000;

export interface HardeningContext {
  env: { ENVIRONMENT?: string };
}

export function hardeningPlugins<TContext extends HardeningContext>(): Plugin<TContext>[] {
  return [
    maxTokensPlugin({ n: MAX_QUERY_TOKENS }),
    maxDepthPlugin({ n: MAX_QUERY_DEPTH, ignoreIntrospection: true }),
    maxAliasesPlugin({ n: MAX_QUERY_ALIASES }),
    costLimitPlugin({
      maxCost: MAX_QUERY_COST,
      objectCost: 2,
      scalarCost: 1,
      depthCostFactor: 1.5,
      ignoreIntrospection: true,
    }),
    // Block __schema / __type queries in production. GraphiQL is gated in
    // the handler, so dev/staging clients keep their introspection — only
    // the public prod endpoint refuses to enumerate the schema.
    useDisableIntrospection({
      disableIf: ({ context }) => (context as TContext).env.ENVIRONMENT === "production",
    }) as Plugin<TContext>,
  ];
}
