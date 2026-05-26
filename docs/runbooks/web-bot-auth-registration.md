# Web Bot Auth - verification & Cloudflare registration

## Prerequisites

- Keys provisioned: public key committed in `packages/core/src/web-bot-auth.ts` (`WEB_BOT_AUTH_PUBLIC_JWK`), private key stored in Cloudflare Secrets Store as `WEB_BOT_AUTH_PRIVATE_KEY` (run `bun scripts/gen-web-bot-auth-key.ts` to generate both).
- `https://releases.sh/.well-known/http-message-signatures-directory` returns 200 + a JWKS (it 404s until the public key is provisioned).
- The `/bot` page is live at `https://releases.sh/bot`.

## Provision the keys

Generate the keypair and split it across its two homes — public key into code, private key into the Cloudflare Secrets Store:

```bash
bun scripts/gen-web-bot-auth-key.ts
```

- Paste the printed **public** JWK (`kty`/`crv`/`x`/`kid`) into `WEB_BOT_AUTH_PUBLIC_JWK` in `packages/core/src/web-bot-auth.ts` and commit. The public key is not secret; this is what the directory serves.
- Store the printed **private** JWK in the Cloudflare **Secrets Store** — the same account-level store as `WEBHOOK_HMAC_MASTER` (store id `a887a71cab084105b79706df23380723`) — under the name `WEB_BOT_AUTH_PRIVATE_KEY`. One secret serves **both** the `api` and `discovery` workers; their `wrangler.jsonc` already bind it. It is **not** needed in Vercel — only the Cloudflare Workers sign requests; the web frontend only serves the public key.
  - That store id is the `store_id` in the `secrets_store_secrets` bindings in each `wrangler.jsonc` (search for `WEB_BOT_AUTH_PRIVATE_KEY`); if it ever changes, find the current id via the dashboard → Manage Account → Secrets Store, or `bunx wrangler secrets-store store list`.

Via the dashboard (Manage Account → Secrets Store), or the CLI (run against the Build Internet account):

```bash
# paste the private JWK at the prompt — omit --value so it doesn't land in shell history
bunx wrangler secrets-store secret create a887a71cab084105b79706df23380723 \
  --name WEB_BOT_AUTH_PRIVATE_KEY --scopes workers --remote
```

## Enable signing

Set `WEB_BOT_AUTH_ENABLED=true` in the `vars` of the api + discovery workers and deploy (branch deploy via the GitHub Actions `deploy-workers.yml`, or merge to main). Until then, signing is off and all fetches go out unsigned (fail-safe).

## Verify the signature is well-formed

Send a signed request to Cloudflare's tester and check the status:

- `401` = signature is well-formed but the key is not yet known to Cloudflare (expected before registration is approved).
- `200` = key known and verified (expected after approval).
- `400` = malformed; fix before submitting.

Test endpoint: `https://crawltest.com/cdn-cgi/web-bot-auth`

Also run the public scanner: POST the site to `https://isitagentready.com/api/scan` and confirm `checks.botAccessControl.webBotAuth.status: "pass"`.

## Submit the Bot Submission Form

Cloudflare dashboard -> Manage Account -> Configurations -> Bot Submission Form:

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| Bot name                  | Releases                                                           |
| I own this bot            | checked                                                            |
| Bot documentation URL     | https://releases.sh/bot                                            |
| Short description         | Changelog indexer & registry crawler for AI agents and developers. |
| Bot type                  | Verified Bot                                                       |
| Bot crawler category      | AI Crawler                                                         |
| Verification method       | Request signature (beta)                                           |
| Validation instructions   | https://releases.sh/.well-known/http-message-signatures-directory  |
| User-Agents header values | releases/0.1 (+https://releases.sh)                                |
| User-Agents match pattern | releases                                                           |

## After approval

Re-run the crawltest endpoint; expect `200`. Note: pages fetched via Cloudflare Browser Rendering (JS-rendered/crawl paths) are signed by Cloudflare under its own "Cloudflare Browser Rendering" identity, not ours - that is expected and documented in the design spec (`docs/superpowers/specs/2026-05-26-web-bot-auth-design.md`). Only our direct fetches (feeds, scrape probes, feed-enrich) carry the `releases` identity.
