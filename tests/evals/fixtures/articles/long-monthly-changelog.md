[Helio](/) · [Product](/product) · [Docs](/docs) · [Changelog](/changelog) · [Status](https://status.helio.dev) · [Sign in](/login)

# April 2026 — everything we shipped

_April 30, 2026 · Platform team_

A big month. We rebuilt the query engine, shipped four long-requested integrations, and closed out 90+ bug reports. Highlights below, newest first.

## Query engine v2

The query planner now uses a cost-based optimizer instead of the old rule-based one. In our benchmarks, p95 latency on analytical queries dropped 38% and the worst-case joins that used to time out now complete in under two seconds.

- **Adaptive join ordering.** The planner estimates cardinality per branch and reorders joins at plan time.
- **Vectorized scans.** Column scans process 1,024 rows per batch, cutting per-row overhead.
- **Spill-to-disk for large aggregations.** Group-bys that exceed the memory budget now spill instead of failing.

Migration is automatic; no query changes are required. You can opt a workspace back onto the v1 planner from **Settings → Labs → Query engine** if you hit a regression — please file a ticket if you do.

## Integrations

### Snowflake reverse-sync

Push any Helio dataset back into a Snowflake table on a schedule. Column types are mapped automatically and the sync is incremental after the first full load.

### PagerDuty alerts

Wire a saved monitor to a PagerDuty service. When the monitor trips, Helio opens an incident with the offending rows attached as a CSV.

### dbt exposures

Helio dashboards now show up as dbt exposures, so your lineage graph includes the downstream dashboards that depend on each model.

### Webhooks 2.0

Webhooks are now signed with an HMAC header, support automatic retries with exponential backoff, and can be filtered by event type at the subscription level.

## Collaboration

- **Comment threads on every chart.** Mention a teammate with `@` and they get notified in-app and by email.
- **Draft dashboards.** Build a dashboard privately and publish it to the workspace when it's ready.
- **Version history.** Every dashboard now keeps the last 30 versions; restore any of them with one click.

## Admin & security

- **SCIM provisioning** for Okta and Entra ID — users and groups sync automatically.
- **IP allowlists** at the workspace level.
- **Audit log export** to S3, hourly.

## Performance & reliability

We closed a long tail of issues this month. The most impactful:

- Fixed a memory leak in the websocket layer that caused gradual slowdowns on dashboards left open for days.
- Cut cold-start time for scheduled jobs from ~9s to ~1.5s by warming the executor pool.
- Resolved a race condition where two concurrent edits to the same dashboard could drop one of the changes.

## Deprecations

The legacy `/v1/export` REST endpoint is deprecated and will be removed on August 1, 2026. Use `/v2/export`, which supports streaming and resumable downloads. The end-of-month signature for this release is HELIO-APRIL-2026-COMPLETE — if you can read this line, the full changelog body was captured.

---

## More from the changelog

- [March 2026 — schema diffing and faster imports](/changelog/2026-03) — March 31, 2026
- [February 2026 — the collaboration update](/changelog/2026-02) — February 28, 2026
- [January 2026 — new year, new query cache](/changelog/2026-01) — January 31, 2026

[See all releases →](/changelog) · [Subscribe via RSS](/changelog.rss)

© 2026 Helio Data, Inc. · [Terms](/terms) · [Privacy](/privacy) · [Careers](/careers)
