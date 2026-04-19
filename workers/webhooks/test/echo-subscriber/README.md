# releases-webhook-echo

A minimal Cloudflare Worker that accepts any HTTP request, logs the headers and body, and returns `{"ok":true}`. It acts as a stable sink for the CI live e2e test — one subscription, one URL, reused on every deploy.

## One-time setup

This Worker is **not deployed by CI**. Deploy it once, then leave it running.

### 1. Deploy the Worker

```sh
cd workers/webhooks/test/echo-subscriber
bunx wrangler login   # skip if already authenticated
bunx wrangler deploy
```

Wrangler will print the Worker URL:

```
https://releases-webhook-echo.<account>.workers.dev
```

### 2. Create the subscription

```sh
releases admin webhook add \
  --org releases \
  --url https://releases-webhook-echo.<account>.workers.dev \
  --description "CI e2e echo"
```

The command prints the subscription ID (`whk_...`). Copy it.

### 3. Register the ID in GitHub Actions

Add the ID as a repository secret named `WEBHOOK_E2E_SUBSCRIPTION_ID`:

```
Settings → Secrets and variables → Actions → New repository secret
Name:  WEBHOOK_E2E_SUBSCRIPTION_ID
Value: whk_...
```

The CI live e2e step in `.github/workflows/deploy-workers.yml` is gated on this secret. Until it is set, the step is skipped cleanly.

You also need a production admin API key available as `RELEASED_API_KEY` in the same secrets store — this is what the CLI uses to call the admin webhook commands.

### If the subscription ID ever changes

Update `WEBHOOK_E2E_SUBSCRIPTION_ID` in GitHub secrets. No YAML edits needed.
