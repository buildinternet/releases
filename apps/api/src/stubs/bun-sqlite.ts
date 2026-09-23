// Stub for bun:sqlite — never executed in Workers runtime.
// Required because @releases/db/connection.ts imports bun:sqlite,
// and some adapter code transitively pulls that module in.
// oxlint-disable-next-line no-extraneous-class -- stub must match bun:sqlite's `new Database()` call-site API
export class Database {
  constructor() {
    throw new Error("bun:sqlite is not available in Cloudflare Workers");
  }
}
