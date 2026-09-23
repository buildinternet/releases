import { createYoga } from "graphql-yoga";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { createLoaders } from "./loaders.js";
import { persistedOperationsPlugin } from "./persisted-plugin.js";
import { hardeningPlugins } from "./plugins.js";
import { schema } from "./schema.js";
import type { GraphQLContext } from "./builder.js";

export type GraphQLServerContext = { env: Env["Bindings"]; isAdmin: boolean };

// Single Yoga instance per worker isolate. Context factory runs per request,
// so loaders + db handle are still scoped correctly. This module is loaded on
// the first /v1/graphql request (see handler.ts), not at isolate startup.
export const yoga = createYoga<GraphQLServerContext>({
  schema,
  // Yoga uses this for self-references (GraphiQL fetch URL, error links). The
  // Hono mount path is the source of truth — change both together.
  graphqlEndpoint: "/v1/graphql",
  graphiql: (_req, { env }) => env.ENVIRONMENT !== "production",
  context: ({ env, isAdmin }): GraphQLContext => {
    const db = createDb(env.DB);
    return {
      db,
      loaders: createLoaders(db),
      isAdmin,
      mediaOrigin: env.MEDIA_ORIGIN ?? "",
    };
  },
  landingPage: false,
  plugins: [...hardeningPlugins<GraphQLServerContext>(), persistedOperationsPlugin()],
});
