# API trusted-proxy WAF skip (Vercel → api.releases.sh)

## When you need this

The web app proxies session-authed account calls (avatar uploads at `/api/account/*`) to
`api.releases.sh` from Vercel serverless. Cloudflare bot protection can return a managed
challenge (`Just a moment...`, HTTP 403, `text/html`) **before** the request reaches the
API worker. Browsers cannot solve that challenge inside a `fetch()` proxy hop.

Symptoms:

- Network tab: `POST /api/account/me/workspaces/.../avatar` → **403** with `Content-Type: text/html`
- Response body contains `challenges.cloudflare.com` / `Just a moment...`
- UI: `Upload failed (403)` or, after the proxy hardening, `edge_blocked` JSON

`X-Releases-Proxy-Key` / `RELEASES_PROXY_KEY` only exempts **in-worker** rate limits today.
It does **not** bypass edge bot checks unless you add the WAF skip rule below.

## Prerequisites

1. `RELEASES_PROXY_KEY` is set in the **Vercel** project (same value as the API worker secret).
2. You have zone-level WAF edit access on the `releases.sh` zone (`api.releases.sh` is on this zone).
3. For the script / GitHub Action: `CLOUDFLARE_API_TOKEN` must include **Zone → Firewall Services → Edit** (and **Zone → Zone → Read**). The repo secret used for worker deploys may be Workers-only — if the workflow returns `403 Authentication error` on `POST .../rulesets`, rotate the secret or apply via the dashboard below.

## Create the skip rule

Cloudflare dashboard → **Security** → **WAF** → **Custom rules** → **Create rule**

| Field        | Value                                                                               |
| ------------ | ----------------------------------------------------------------------------------- |
| Rule name    | `Skip bot checks for releases-web trusted proxy`                                    |
| Expression   | See below                                                                           |
| Action       | **Skip**                                                                            |
| Skip options | **All Super Bot Fight Mode rules**, **Browser Integrity Check**, **Security Level** |

Expression (requires both trusted-proxy headers the web sends on every server-to-server call):

```txt
(http.host eq "api.releases.sh"
  and http.request.headers["x-requested-with"][0] eq "releases-web"
  and http.request.headers["x-releases-proxy-key"][0] ne "")
```

Place this rule **above** any broad challenge/block rules so it matches first.

## Verify

From a machine with the proxy key:

```bash
curl -s -o /tmp/out -w "%{http_code} %{content_type}\n" \
  -X POST "https://api.releases.sh/v1/me/avatar" \
  -H "User-Agent: releases-web/verify (+https://releases.sh)" \
  -H "X-Requested-With: releases-web" \
  -H "X-Releases-Proxy-Key: $RELEASES_PROXY_KEY" \
  -F "file=@/path/to/square.png;type=image/png"
```

Expect `401 application/json` (no session cookie), **not** `403 text/html`.

After deploy, retry avatar upload on `/account/general` — should return JSON (`401`/`403`/`200`), never HTML.

## Apply via script (recommended)

With `CLOUDFLARE_API_TOKEN` (Zone WAF Edit) in the environment:

```bash
bun scripts/apply-trusted-proxy-waf-skip.ts
bun scripts/apply-trusted-proxy-waf-skip.ts --dry-run
```

Or dispatch the **Apply trusted-proxy WAF skip** GitHub Actions workflow
(`.github/workflows/apply-trusted-proxy-waf.yml`) — it uses the repo’s
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets.

## API equivalent

See [Configure a rule with the Skip action](https://developers.cloudflare.com/waf/custom-rules/skip/)
and [Available skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/)
(`phases: ["http_request_sbfm"]`, `products: ["bic", "securityLevel"]`).
