// The DB-construction factory lives in `@releases/lib/db` so all workers and
// packages build their Drizzle handle through one seam (see
// docs/architecture/storage-portability.md). Re-exported here to preserve the
// many `./db.js` import sites across this worker.
export { createDb, type AnyDb, type D1Db } from "@releases/lib/db";
