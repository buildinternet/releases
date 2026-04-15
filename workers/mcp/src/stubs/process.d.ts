// Minimal `process.env` ambient declaration for the MCP worker.
//
// `@releases/lib/embeddings.ts` reads `process.env.EMBEDDING_PROVIDER`
// / `VOYAGE_API_KEY` / `OPENAI_API_KEY` at module scope. The CLI side
// has bun types, the API worker side has bun types via the root
// workspace, but the MCP worker isn't a workspace and doesn't bundle
// node/bun types — so we declare the narrowest possible shim here.
//
// At runtime, the Cloudflare Workers runtime exposes `process.env` as
// an empty object (Node compat); the embeddings module never needs
// real values because the MCP worker always passes an explicit
// `EmbeddingConfig` override built from secrets.
declare const process: {
  env: Record<string, string | undefined>;
};
