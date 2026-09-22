# Classification analytics

Operator read API over marketing-classifier decisions. Each decision is a Workers Analytics Engine point, not a D1 row: points are sampled, kept for about three months, and carry no release text. The ingest path that writes them is the marketing classifier in [ingest.md → Marketing classifier](ingest.md#marketing-classifier). The dashboard is the Classifications tab at `/admin/status?tab=classifications` ([web.md → Admin hub](web.md#admin-hub)), which links to `/admin/classifier` for tuning the threshold and per-source filter — see [ingest.md → Marketing classifier](ingest.md#marketing-classifier).

## Why Analytics Engine

The view operators need is recent and time-bucketed: how many items were kept or suppressed, which choice was selected, where the probability sits relative to the effective suppression threshold, and what it cost. A D1 event table would retain that history exactly, and it would also be the natural place to put title, content, and URL next to every attempt — including items that were never inserted. Analytics Engine is the existing sampled telemetry store (the same SQL API as webhook delivery history). It is the wrong store for a permanent audit log. A D1 table remains the follow-up if classification history becomes calibration data or has to outlive the three-month window.

Axiom `ai_usage` and `marketing-filter-applied` stay as they are. This API does not replace them.

## Point schema

Positional and append-only. Queries pin these indexes. Do not reorder blobs or doubles.

- `index1`: source id, or `none` when the attempt has no source
- `blob1`: schema version (`1`)
- `blob2`: environment (`production` | `staging` | `development`)
- `blob3`: origin (`ingest` | `manual` | `eval`)
- `blob4`: classification type (`marketing`)
- `blob5`: release id, or empty when the row was not inserted
- `blob6`: source id (duplicate of the index; empty when `index1` is `none`)
- `blob7`: provider
- `blob8`: model
- `blob9`: choice
- `blob10`: disposition (`kept` | `suppressed` | `failed` | `skipped`)
- `blob11`: reason slug
- `blob12`: policy version
- `blob13`: failure or skip category (never a raw provider error)
- `double1`: selected-choice probability, or `-1` when absent
- `double2`: provider confidence, or `-1` when absent
- `double3`: suppression threshold
- `double4`: cost USD, or `-1` when absent
- `double5`: input tokens, or `-1` when absent
- `double6`: output tokens, or `-1` when absent
- `double7`: duration milliseconds, or `-1` when absent
- `double8`: event count (always `1`)

The writer lives in `workers/api/src/lib/classification-schema.ts`. Reads always filter `blob1 = '1'` and `blob4 = 'marketing'`. Semantic-alert decisions share this dataset with `blob4 = semantic-alert` and a separate writer; they stay out of the marketing admin queries. Their read API is `GET /v1/admin/semantic-alerts/summary` (match rate and fail-closed counts; cost stays on `ai_usage`). See [semantic-alerts.md](semantic-alerts.md).

Absent numerics use the sentinel `-1` (`ABSENT_DOUBLE`). Zero is a real value. Probabilities are only meaningful in `0..1`. The threshold stored on each point is the EFFECTIVE threshold at classify time — the operator override from `GET/PUT /v1/admin/marketing-classifier` when one is stored, else `MARKETING_SUPPRESSION_THRESHOLD` (default `0.65`, see [ingest.md → Marketing classifier](ingest.md#marketing-classifier)) — not a fixed constant, so points written before and after a threshold change carry different values by design. The summary's `probability.threshold` reports the CURRENT effective threshold, not an average of the points' stored values. Selected-choice probability and provider confidence stay on different doubles; confidence is not a substitute for the probability the suppression rule uses.

`classificationDatasetName` picks the dataset: `release_classifications` unless `ENVIRONMENT` is `staging`, in which case `release_classifications_staging`. Points are not copied between the two.

## Sampling and retention

Analytics Engine keeps points for about three months (`CLASSIFICATION_RETENTION_DAYS = 90`) and may sample. Aggregate queries weight rows with `SUM(_sample_interval)`. A sum of a double has to skip the sentinel, or a missing cost becomes `-1` dollars:

```sql
SUM(if(double4 >= 0, _sample_interval * double4, 0))
```

The recent list returns the sampled rows themselves and does not multiply them by `_sample_interval`. The summary response sets `meta.sampled: true` and `meta.retentionDays: 90`. The read API rejects a window longer than 100 days so a query cannot ask for more than retention. Time filters are half-open UTC bounds: `timestamp >= toDateTime('YYYY-MM-DD HH:MM:SS') AND timestamp < toDateTime('...')`.

## Credentials

Queries go to the Analytics Engine SQL API: `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql` with the SQL as the body. The bearer token and account id are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, resolved by `resolveCloudflareAeCredentials` — the same Secrets Store bindings as Browser Rendering and webhook delivery history. There is no second token.

Missing credentials return `503` with code `deliveries_unavailable`. A non-2xx SQL response returns `502` with code `ae_query_failed`. `UpstreamError` keeps the message generic. `details` carries only `{ query, status }` — which of the summary statements failed, and the Analytics Engine HTTP status. The response body from Analytics Engine is logged, not returned. The token is sent only on the `Authorization` header. SQL is not logged. Analytics Engine has no bound parameters, so every interpolated value is an allowlisted literal, a regex-checked token, or a timestamp the API formatted itself. Anything else is a `400` `bad_request` and never reaches the statement.

## Routes

Both are admin-only (`admin/classifications` in `adminRoutes`).

- `GET /v1/admin/classifications/summary` — totals, a disposition time series, choice counts, choice counts over time, provider/model volume and cost, and two histograms. Selected-choice probability is `double1`. Provider confidence is `double2`. Bins are fixed width `0.1` from `0.0` through `1.0` (ten bins, always present). `0.8` is the start of the `0.8`–`0.9` bin. `missing` counts points whose double is `< 0`.
- `GET /v1/admin/classifications/recent` — newest sampled decisions. Source name, slug, and org slug, and the release title, are loaded from D1 by id (`inArray`, chunks of 90). The title is the stored `title`. Content and URL are not selected. A missing D1 row leaves the display fields null and keeps the decision. A suppressed release row still present in D1 keeps its title. `ORDER BY timestamp DESC LIMIT n+1`; when an extra row comes back, `nextCursor` is the last returned item's timestamp and that extra row is dropped.

Omitted `origin` means `ingest`, so manual smoke tests and evals do not land in the default operator view. `origin=all` drops the origin predicate. `manual` and `eval` filter `blob3`.

Omitted `after` is now minus 7 days. Omitted `before` is now. `bucket` defaults to `hour` when the span is at most 48 hours, otherwise `day`.

The summary JSON is cached for 45 seconds in `LATEST_CACHE` when that binding exists. The key is `classification-summary:v1:` plus a hash of the validated query (dataset, origin, bucket, model, source, and any explicit bounds) — not the raw query string. Omitted bounds share one key so a dashboard refresh hits. Errors are not cached. Recent is not cached. Workers KV refuses an expiration under 60 seconds, so the key is stored with a 60-second TTL and the cached entry carries its own timestamp; a read older than 45 seconds misses and recomputes. This is not the public `/v1/releases/latest` cache: nothing here calls `invalidateLatestCache` or the public `cacheControl` middleware. Admin requests carry `Authorization` and stay `private, no-store` at the edge.

## What is not stored

The point writer drops free-form input: title, content, URL, raw provider errors, and tokens. `blob11` is a reason slug. `blob13` is a failure or skip category, never the provider's error text. Neither admin response includes release content or URL.
