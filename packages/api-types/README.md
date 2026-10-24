# @buildinternet/releases-api-types

**Scope:** request/response wire types for the public API worker. No request logic, no client code, no server handlers.

Wire protocol for the [Releases](https://releases.sh) registry API: TypeScript
types plus the Zod schemas they are inferred from, describing the request and
response shapes served at `api.releases.sh`. Consumed by the web frontend, the
remote MCP server, and the [Releases CLI](../../apps/cli). Ships as compiled
ES modules with declarations, so it works in Node, Bun, Deno, and bundlers.

## Install

```bash
npm install @buildinternet/releases-api-types
```

## Usage

```ts
import type { OrgListResponse } from "@buildinternet/releases-api-types";

async function listOrgs(): Promise<OrgListResponse> {
  const res = await fetch("https://api.releases.sh/v1/orgs");
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return (await res.json()) as OrgListResponse;
}
```

To validate a response at runtime, use the matching schema:

```ts
import { OrgListResponseSchema } from "@buildinternet/releases-api-types";

const orgs = OrgListResponseSchema.parse(await res.json());
```

Paginated list endpoints return a `ListResponse<T>` envelope (`{ items, pagination }`). The shared pagination semantics also live in
`@buildinternet/releases-core/cli-contracts` for CLI callers.

## Versioning

This package follows semantic versioning against the `api.releases.sh` wire
contract. Additive changes (new optional fields, new types) bump the minor
version. Renames and removals get a deprecation cycle — the old name remains as
a deprecated alias for one minor version before being removed in the next major.

## License

MIT
