import { createYoga } from "graphql-yoga";
import { Hono } from "hono";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { createLoaders } from "./loaders.js";
import { schema } from "./schema.js";
import type { GraphQLContext } from "./builder.js";

type GraphQLServerContext = { env: Env["Bindings"]; isAdmin: boolean };

// Single Yoga instance per worker isolate. Context factory runs per request,
// so loaders + db handle are still scoped correctly.
const yoga = createYoga<GraphQLServerContext>({
  schema,
  // Yoga uses this for self-references (GraphiQL fetch URL, error links). The
  // Hono mount path is the source of truth — change both together.
  graphqlEndpoint: "/v1/graphql",
  graphiql: (_req, { env }) => (env as { ENVIRONMENT?: string }).ENVIRONMENT !== "production",
  context: ({ env, isAdmin }): GraphQLContext => {
    const db = createDb(env.DB);
    return { db, loaders: createLoaders(db), isAdmin };
  },
  landingPage: false,
});

export const graphqlRoutes = new Hono<Env>();

graphqlRoutes.all("/graphql", async (c) => {
  const isAdmin = await isValidBearerAuth(c);
  // Hand Hono's Request to Yoga; Yoga expects a Fetch API Request.
  const response = await yoga.fetch(c.req.raw, { env: c.env, isAdmin });
  return response;
});
