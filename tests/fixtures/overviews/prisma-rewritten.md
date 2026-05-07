Prisma's recent work spans CLI bootstrap, query-cache controls, partial indexes, and driver-adapter fixes — all converging on the `7.8.0` release.

**Prisma Postgres setup is now a single interactive command.** `prisma bootstrap` (added in `7.7.0`) detects project state and runs only the steps you need: scaffold from one of ten starter templates, browser-auth link, install, migrate, generate, and seed. `7.6.0` added `prisma postgres link` as the first member of a new `prisma postgres` CLI group.

**Apps can tune the query-plan cache directly.** A new `queryPlanCacheMaxSize` constructor option (in `7.8.0`) lets you trade memory for performance — pass `0` to disable caching entirely. The Wasm query compiler underneath, introduced in `7.4.0`, normalizes query shapes into cache keys to keep the event loop unblocked on repeated patterns.

**Partial indexes shipped as a preview feature.** `7.4.0` added `partialIndexes` for PostgreSQL, SQLite, SQL Server, and CockroachDB, with raw SQL and type-safe object syntax plus full migration and introspection support.

**Driver adapters and the schema engine got correctness fixes.**

- PostgreSQL JSON list filtering and `@map`-named enum parameterization patched
- `CREATE INDEX CONCURRENTLY` no longer fails during `migrate dev`
- D1 adapter now no-ops savepoints instead of running unsupported SQL
- `@prisma/adapter-mariadb` added `useTextProtocol` to fix lossy number conversion
- `@prisma/adapter-pg` gained `statementNameGenerator` for prepared-statement caching

`6.19.3` shipped a security patch updating the `effect` dependency.
