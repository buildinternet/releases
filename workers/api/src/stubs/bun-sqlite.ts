// Stub for bun:sqlite — never executed in Workers runtime.
// Required because @released/db/connection.ts imports bun:sqlite,
// and some adapter code transitively pulls that module in.
export class Database {
  constructor() {
    throw new Error("bun:sqlite is not available in Cloudflare Workers");
  }
}
