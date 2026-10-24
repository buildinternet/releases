# @buildinternet/releases-sdk

TypeScript client for the [Releases](https://releases.sh) API at `api.releases.sh`. Request and response types come from [`@buildinternet/releases-api-types`](../api-types); the client calls only the operations in the public API surface ([`apps/api/src/api-surface.ts`](../../apps/api/src/api-surface.ts)). It runs anywhere `fetch` does: Node 18+, Bun, Deno, browsers and workers.

## Usage

```ts
import { Releases, ReleasesError } from "@buildinternet/releases-sdk";

const releases = new Releases({ apiKey: process.env.RELEASES_API_KEY });

// Public reads work without a key, at a lower rate limit.
const { releases: latest } = await releases.releases.latest({ org: "vercel", count: 10 });
const hits = await releases.search({ q: "edge functions", mode: "hybrid" });
const changelog = await releases.sources.changelog(
  { org: "vercel", source: "next-js" },
  { tokens: 2000 },
);

// Cursor pagination: pass `pagination.nextCursor` back as `cursor`.
let page = await releases.orgs.releases("vercel", { limit: 50 });
while (page.pagination.nextCursor) {
  page = await releases.orgs.releases("vercel", { limit: 50, cursor: page.pagination.nextCursor });
}

try {
  await releases.orgs.get("no-such-org");
} catch (err) {
  if (err instanceof ReleasesError && err.type === "not_found") {
    // err.status, err.code, err.message, err.details
  }
}
```

### Publishing releases

A publish token (minted for one source) or a `write` token can publish:

```ts
const publisher = new Releases({ apiKey: process.env.RELEASES_PUBLISH_TOKEN });
await publisher.sources.publish(
  { org: "acme", source: "acme-cli" },
  {
    mode: "upsert-content",
    releases: [
      { title: "v2.1.0", version: "2.1.0", content: "…", url: "https://acme.dev/changelog#v2.1.0" },
    ],
  },
  { idempotencyKey: crypto.randomUUID() },
);
```

### Account

With a user key (`relu_`) or OAuth token: `me.follows`, `me.feed`, `me.webhooks`, `apiKeys`, and `workspaceWebhooks(workspaceId)`.

Anything not wrapped yet is reachable through `request`, by its surface key:

```ts
const overview = await releases.request("GET /products/:slug/overview", {
  params: { slug: "next-js" },
});
```

## Options

| Option    | Default                   | Notes                                       |
| --------- | ------------------------- | ------------------------------------------- |
| `apiKey`  | none                      | Sent as `Authorization: Bearer …`.          |
| `baseUrl` | `https://api.releases.sh` | Use your own origin for staging or a fork.  |
| `fetch`   | global `fetch`            | Inject for tests, proxies, or custom retry. |
| `headers` | none                      | Sent with every request.                    |

Every method also takes `{ signal, headers, idempotencyKey }` as its last argument.

## License

MIT
