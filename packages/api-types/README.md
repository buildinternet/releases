# @buildinternet/releases-api-types

Wire protocol types for the [Releases](https://releases.sh) registry API.

Pure TypeScript types — zero runtime dependencies — describing request/response
shapes for the public HTTP API served at `api.releases.sh`. Consumed by the web
frontend, the remote MCP server, and the [Releases CLI](https://github.com/buildinternet/releases-cli).

## Install

```bash
npm install @buildinternet/releases-api-types
```

## Usage

```ts
import type { OrgListResponse } from "@buildinternet/releases-api-types";

async function listOrgs(): Promise<OrgListResponse> {
  const res = await fetch("https://api.releases.sh/v1/orgs");
  return (await res.json()) as OrgListResponse;
}
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
