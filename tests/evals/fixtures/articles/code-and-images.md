[Home](/) [Reference](/ref) [Changelog](/changelog) [GitHub](https://github.com/orbit/sdk)

# SDK v3.2: typed query builder

_May 9, 2026 · @orbit/sdk_

The v3.2 release adds a fully-typed query builder so filters are checked at compile time instead of failing at runtime.

![Type errors surfaced inline in the editor](https://cdn.orbit.dev/img/query-builder-types.png)

Install the new version:

```bash
npm install @orbit/sdk@3.2
```

Build a query with autocomplete on every column:

```ts
const rows = await db
  .from("orders")
  .where("status", "=", "paid")
  .orderBy("created_at", "desc")
  .limit(50);
```

`where()` now rejects unknown columns and mismatched value types. The old string-based `.raw()` escape hatch is still available for dynamic queries.

## Breaking changes

- `db.query()` is removed. Use the builder or `.raw()`.
- Minimum TypeScript version is now 5.4.

Related: [Read the migration guide](/docs/migrate-v3) · [Report an issue](https://github.com/orbit/sdk/issues)
