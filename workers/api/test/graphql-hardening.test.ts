/**
 * Tier-1 hardening (#755) — query-shape limits + introspection gate.
 *
 * These tests exercise the Yoga plugin pipeline (parse → validate → execute),
 * not the resolvers, so we use a tiny stand-in schema to control depth
 * deterministically rather than threading the production schema's specific
 * field shapes through every assertion.
 */
import { describe, it, expect } from "bun:test";
import { createSchema, createYoga } from "graphql-yoga";
import { hardeningPlugins, MAX_QUERY_DEPTH } from "../src/graphql/plugins.js";

interface Ctx {
  env: { ENVIRONMENT?: string };
}

const SCHEMA = createSchema({
  // Recursive Node type — lets us nest selections to arbitrary depth in tests
  // without depending on the production schema's exact relations. The `roots`
  // field takes a `first` arg so the cost-limit visitor's setMultiplier path
  // (which multiplies cost by `first`/`last`) is exercised — that's how
  // production blocks `latestReleases(limit: …)`-style fan-out abuse.
  typeDefs: /* GraphQL */ `
    type Node {
      id: ID!
      name: String!
      child: Node
    }
    type Query {
      root: Node!
      roots(first: Int): [Node!]!
    }
  `,
  resolvers: {
    Query: {
      root: () => ({ id: "0", name: "root" }),
      roots: (_: unknown, args: { first?: number }) =>
        Array.from({ length: args.first ?? 1 }, (_v, i) => ({
          id: String(i),
          name: `root${i}`,
        })),
    },
    Node: {
      child: (parent: { id: string }) => ({ id: `${parent.id}.0`, name: "child" }),
    },
  },
});

function makeYoga() {
  return createYoga<Ctx>({
    // Cast: YogaSchemaDefinition's generic on `_context` is invariant on Ctx,
    // but our schema doesn't read context at all, so the cast is purely a
    // type-check pacifier with no runtime effect.
    schema: SCHEMA as Parameters<typeof createYoga<Ctx>>[0]["schema"],
    plugins: hardeningPlugins<Ctx>(),
    graphiql: false,
    landingPage: false,
  });
}

async function runQuery(
  yoga: ReturnType<typeof makeYoga>,
  query: string,
  env: { ENVIRONMENT?: string } = {},
  variables?: Record<string, unknown>,
) {
  // env flows through serverContext (the 2nd arg to yoga.fetch) — that's the
  // shape envelop's onValidate hook reads, which is what useDisableIntrospection
  // uses. The GraphQL context factory runs later, after validate.
  const res = await yoga.fetch(
    new Request("http://t/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
    { env },
  );
  return (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
}

// Build a query nested `n` levels deep: root { child { child { … { name } } } }.
function depthN(n: number): string {
  let body = "name";
  for (let i = 0; i < n; i++) body = `child { ${body} }`;
  return `query { root { ${body} } }`;
}

describe("graphql tier-1 hardening", () => {
  describe("max depth", () => {
    it("accepts a query at the depth ceiling", async () => {
      // depthN(n) wraps `name` in n `child` selections + the leading `root` —
      // the depth visitor counts each selection-set entry, so depthN(n) is
      // depth n + 2 (root + n children + leaf scalar). depthN(4) is the
      // largest at MAX_QUERY_DEPTH=6.
      const out = await runQuery(makeYoga(), depthN(MAX_QUERY_DEPTH - 2));
      expect(out.errors).toBeUndefined();
    });

    it("rejects a query one level past the ceiling", async () => {
      const out = await runQuery(makeYoga(), depthN(MAX_QUERY_DEPTH - 1));
      expect(out.errors).toBeDefined();
      expect(out.errors?.[0]?.message.toLowerCase()).toMatch(/depth/);
    });
  });

  describe("max aliases", () => {
    it("rejects a query with too many aliases", async () => {
      // 20 aliased copies > MAX_QUERY_ALIASES (15).
      const aliases = Array.from({ length: 20 }, (_, i) => `r${i}: root { id }`).join(" ");
      const out = await runQuery(makeYoga(), `query { ${aliases} }`);
      expect(out.errors).toBeDefined();
      expect(out.errors?.[0]?.message.toLowerCase()).toMatch(/alias/);
    });
  });

  describe("max tokens", () => {
    it("rejects a query whose token count blows the cap", async () => {
      // Repeating `id` adds tokens fast — 1500 fields blows past 1000.
      const fields = Array.from({ length: 1500 }, () => "id").join(" ");
      const out = await runQuery(makeYoga(), `query { root { ${fields} } }`);
      expect(out.errors).toBeDefined();
      expect(out.errors?.[0]?.message.toLowerCase()).toMatch(/token/);
    });
  });

  describe("cost limit", () => {
    it("rejects a query whose computed cost exceeds the cap", async () => {
      // The cost-limit visitor multiplies a node's cost by its `first`/`last`
      // arg — same shape as `latestReleases(limit: …)` in prod. With
      // depthCostFactor=1.5 compounding through 4 nested `child` selections,
      // a `roots(first: 50)` rolls in well above maxCost=1000. No aliases,
      // depth 5 (under ceiling), token count well under 1000.
      const q = `query { roots(first: 50) { child { child { child { child { name } } } } } }`;
      const out = await runQuery(makeYoga(), q);
      expect(out.errors).toBeDefined();
      expect(out.errors?.[0]?.message.toLowerCase()).toMatch(/cost|complex/);
    });
  });

  describe("introspection gate", () => {
    const introspectionQuery = `query { __schema { types { name } } }`;

    it("disables __schema in production", async () => {
      const out = await runQuery(makeYoga(), introspectionQuery, { ENVIRONMENT: "production" });
      expect(out.errors).toBeDefined();
      expect(out.errors?.[0]?.message.toLowerCase()).toMatch(/introspection|cannot query field/);
    });

    it("allows __schema in staging", async () => {
      const out = await runQuery(makeYoga(), introspectionQuery, { ENVIRONMENT: "staging" });
      expect(out.errors).toBeUndefined();
      expect(out.data).toBeDefined();
    });

    it("allows __schema when ENVIRONMENT is unset (local dev)", async () => {
      const out = await runQuery(makeYoga(), introspectionQuery, {});
      expect(out.errors).toBeUndefined();
    });
  });
});
