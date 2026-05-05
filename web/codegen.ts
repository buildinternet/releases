import type { CodegenConfig } from "@graphql-codegen/cli";

/**
 * Generates typed document nodes for GraphQL operations under
 * src/lib/graphql/operations/. The schema source is the committed snapshot
 * at packages/api-types/graphql/schema.graphql — keep it in sync via:
 *
 *   bun workers/api/scripts/print-graphql-schema.ts
 */
const config: CodegenConfig = {
  schema: "../packages/api-types/graphql/schema.graphql",
  documents: ["src/**/*.graphql"],
  ignoreNoDocuments: true,
  // Server serializes both custom scalars to JSON strings (DateTime: ISO-8601;
  // JSON: opaque to the client). Default `unknown` would force every consumer
  // through a cast, so we narrow them at the codegen layer.
  config: {
    scalars: {
      DateTime: "string",
      JSON: "unknown",
    },
  },
  generates: {
    "./src/lib/graphql/__generated__/": {
      preset: "client",
      presetConfig: {
        // Smaller output: skip the persisted-fragment-masking layer until we
        // need it. Plain `TypedDocumentNode` exports + types is enough for
        // SSR-only callers.
        fragmentMasking: false,
      },
    },
  },
};

export default config;
