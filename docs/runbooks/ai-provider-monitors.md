# AI provider monitors (Axiom)

Alerting for "an AI provider stopped serving us" (#2168, item 5c).

On 2026-07-23 the Anthropic account hit a configured spend cap and every call was rejected for
six days. Nothing surfaced it — it was found only because the Anthropic dashboard showed $0/day
and someone asked whether that was expected. These monitors exist so that specific silence is
never again the thing that notices first.

Four failure modes, four monitors, because they need different signals:

| Failure                                              | Signal                                    | Monitor |
| ---------------------------------------------------- | ----------------------------------------- | ------- |
| A provider rejects calls with a quota/billing error  | the error text / typed event              | 1       |
| A provider just stops being used, no matchable error | absence of `ai_usage`, vs. its baseline   | 2       |
| Everything stops, all providers at once              | absence of `ai_usage` globally            | 3       |
| Releases insert but summarization doesn't run        | `ai_usage` vs. work that demonstrably ran | 4       |

Monitors 1–3 detect silence by comparing against **history**; monitor 4 compares against
**observed work in the same window**, which is why it detects in ~1h where they need 12h–60h. They
cover different lanes, though — see the scope note on monitor 4 before treating it as the fast
path for everything.

All four are **live**, Threshold type, routed to the shared team notifier `sajiFns75aNFy3xSXH`
(the "Email" notifier, same channel as the auth and managed-agent monitors).

| Monitor                                         | ID                   | Window / every | Alert when   |
| ----------------------------------------------- | -------------------- | -------------- | ------------ |
| AI provider quota shutoff                       | `1oo9THKJT9xDUu6hnK` | 60m / 15m      | `count_ > 0` |
| AI provider heartbeat lost                      | `RlEtnGcWm63LuiafWF` | 7d / 60m       | `count_ > 0` |
| AI inference silent — no `ai_usage` in 12h      | `xuxpXTLc8wsDXcQ7mb` | 12h / 60m      | `count_ < 1` |
| Ingest inserting releases with no summarization | `R777X1f5nFIPGTRYgY` | 60m / 15m      | `count_ > 0` |

> **The monitor IDs are the source of truth; this table is a snapshot, accurate as of
> 2026-07-28.** Monitor config lives in Axiom, not in git, so there is no drift detection: a
> threshold retuned in the dashboard leaves this page quietly wrong. Run `checkMonitors` (MCP) or
> open the monitor by ID before trusting a number here, and update this table when you change one.

See [logging.md](../architecture/logging.md) for `logEvent` payload conventions and
[content-pipelines.md](../architecture/content-pipelines.md) for which lanes call which provider.

### Editing them programmatically

The Axiom **MCP** (`mcp__axiom__*`) can create and update monitors — `createMonitor` /
`updateMonitor`, alongside `checkMonitors` for state. All three monitors here were created and
tuned through it. (Earlier docs, including
[auth-audit-monitors.md](./auth-audit-monitors.md), said the MCP was read-only for monitors and
that writes had to go through the management API with `AXIOM_MGMT_TOKEN`; that is no longer
true. The management API still works and remains the option for non-agent automation.)

On `updateMonitor`, omit `notifierIds` to keep the existing notifiers — passing `[]` removes
them. The query must return a single scalar (`summarize count()`), and monitor queries must not
carry their own outer time filter: the monitor applies `rangeMinutes` as the window. Monitor 2 is
the exception that proves the rule — it uses `ago()` _inside_ a `summarize` to slice its range
into a recent window and a baseline, which is a comparison within the window, not a replacement
for it.

---

## Monitor 1 — provider quota shutoff

**Alert when:** `count_ > 0`. **Window:** 60m. **Every:** 15m.

```kusto
['releases-cloudflare-logs']
| where ['body'] contains 'provider-quota-exhausted'
   or ['body'] contains 'reached your specified API usage limits'
   or ['body'] contains 'credit balance is too low'
   or ['body'] contains 'Insufficient credits'
| summarize count()
```

Matches the structured `provider-quota-exhausted` event (from `classifyProviderQuota`,
`packages/lib/src/provider-quota.ts`) **and** the raw provider wording. The raw-text arm is
deliberate on two counts: item 5d of #2168 is still open, so several lanes don't yet emit the
typed event; and substring matching reaches the nested `err.message` where these arrive, which a
`parse_json(body).event` filter would miss. Once 5d lands, the structured arm carries the load and
the text arm becomes belt-and-braces — **keep both**.

**Backtest:** fires at `2026-07-23T00:00Z`, the outage's first hour, with 4 hits, and stays hot
throughout.

**When it fires:** the account is out of quota — a spend cap, a billing shutoff, or exhausted
prepaid credit. This is not retryable and not transient; it will fail identically for every source
until a human raises the cap or the reset date passes.

**Respond:** the alert payload names the provider. Check that provider's billing console for a cap
or a zero balance, and note the `regainAccessAt` in the event if one was parsed. Raising the cap
restores service but **is not necessarily the fix** — on 2026-07-23 the lanes that hit the cap
were lanes that were never supposed to be on Anthropic at all (a `buildFetchOneEnv` bug, #2176).
Before closing out, confirm _which_ lanes were spending, via the lane breakdown query below.

## Monitor 2 — provider heartbeat lost

**Alert when:** `count_ > 0`. **Window:** 7d. **Every:** 60m.

```kusto
['releases-cloudflare-logs']
| where ['body'] contains '"event":"ai_usage"'
| extend p = parse_json(['body'])
| extend provider = tostring(p['provider'])
| where isnotempty(provider)
| summarize recent12 = countif(_time > ago(12h)),
            recent60 = countif(_time > ago(60h)),
            total    = count()
  by provider
| where (recent12 == 0 and total - recent12 >= 300)
    or (recent60 == 0 and total - recent60 >= 20)
| summarize count()
```

Covers a provider going dark **without** throwing anything Monitor 1 can match. Per-provider, and
each provider is gated against **its own** baseline in the older part of the window, so the rule
generalizes to any future provider instead of hardcoding Anthropic and OpenRouter.

- **Fast arm** — zero `ai_usage` in 12h for a provider that logged 300+ events in the rest of the
  7d window. That describes a high-volume heartbeat (OpenRouter runs ~12/h), where 12h of total
  silence is unambiguous.
- **Slow arm** — zero `ai_usage` in 60h for a provider with 20+ events in the older part of the
  window. That covers a bursty mid-volume lane.

### The windows are measured. Do not shorten them.

#2168 originally specified a **6h** window ("`ai_usage` going to zero for a provider over 6h while
another is still active"). Backtested over 264 pre-outage hourly evaluations (Jul 12–23), that rule
would have false-fired on **45% of evaluations** for Anthropic. Its traffic is cron-driven and
bursty — 18–19 events/day clustered in the afternoon, routinely silent for a full day — so
"zero in 6h" was its _normal_ state, not a fault signal.

Measured false positives over that pre-outage window, per provider, per trailing window length:

| Window | Anthropic | OpenRouter |
| ------ | --------- | ---------- |
| 6h     | 120       | 1          |
| 30h    | 16        | 0          |
| 48h    | 0         | 0          |
| 60h    | 0         | 0          |

48h was the shortest window with zero false positives; 60h is that plus margin, on only ~11 days
of pre-outage history.

**A volume gate cannot substitute for window length — it inverts.** The obvious fix ("only alert
if the provider was busy recently") does not work, because a sustained outage decays its own
baseline. Measured: the pre-outage false-positive points had a trailing-7d baseline of 59–75,
while the _real_ outage points had 32–60. Gating on a healthy baseline would have suppressed the
true positive more readily than the false ones. Window length is doing the work here; the gates
only stop the rule arming for providers with negligible traffic.

**Backtest:** with the shipped thresholds — 0 false positives across 264 pre-outage evaluations
for both providers; fires `2026-07-25T11:00Z`, 2.4 days into the outage (vs. the 5.5 days it
actually took to notice), stays hot for 76 consecutive evaluations, and self-clears at
`2026-07-28T14:00Z` when Anthropic traffic resumed.

**Deliberately no `environment` filter — and it stays off.** The rule going forward is simply
that an availability monitor must not filter on a field whose absence is indistinguishable from a
provider being down: a filter that silently drops events fails _closed_, turning a missing field
into silence, which is precisely the thing being watched for. Staging runs no crons, so the noise
this filter would remove is negligible — it buys nothing and can cost everything.

The concrete near-miss that motivated it is now historical, and that's the point: the `ai_usage`
events from the misrouted `feed-enrich` and `marketing-classifier` lanes carried an **empty**
`environment`, because the same `buildFetchOneEnv` bug that misrouted them also failed to forward
`ENVIRONMENT`. #2176 routed every `fetchOne` call site through `buildFetchOneEnv`
(`_fetch-env.ts:143` forwards `ENVIRONMENT`), so events emitted _after_ that fix do carry the
field — but the old events can't be retroactively fixed, and a future forwarding gap would look
identical. **Do not "fix" the filter back in on the grounds that the field is populated now.**
(The auth monitors hit the mirror image of this — see the environment note in
[auth-audit-monitors.md](./auth-audit-monitors.md).)

**Known limit — it detects the transition into silence, not indefinite silence.** A provider with
no events anywhere in the 7d range produces no row and cannot fire. After 7 days dark, Monitor 1
and the operator staleness digest carry it. This is inherent to a bounded window, not an oversight.

**Also note what it will _not_ arm for today.** Since the #2176 routing fix, Anthropic runs ~24
events/7d — below the slow arm's gate of 20 in the baseline segment, and legitimately capable of a
60h gap. So Anthropic is currently **not** covered by this monitor, by design: it no longer has a
heartbeat to lose. That is the correct behavior while its lanes are near-zero, and it re-arms
automatically if Anthropic volume returns. Anthropic's error-shaped failures stay covered by
Monitor 1 regardless of volume.

**When it fires:** a provider that was reliably serving traffic has stopped, with no quota error to
show for it. Causes seen or plausible: a silent routing change (a lane fell back to a different
provider), an expired or revoked API key, a provider outage that manifests as timeouts, or a
feature flag flipping a lane off.

**Respond:** run the lane breakdown below. If the traffic **moved** to another provider, that's a
routing change — confirm it was intended (`resolveTextModel` falls back to Anthropic Haiku when a
lane's OpenRouter model id is `undefined`, which is how #2168 item 1 stayed invisible for three
weeks). If the traffic **vanished** with nothing taking its place, check the crons are running at
all before suspecting the provider.

## Monitor 3 — all inference silent

**Alert when:** `count_ < 1`. **Window:** 12h. **Every:** 60m.

```kusto
['releases-cloudflare-logs']
| where ['body'] contains '"event":"ai_usage"'
| summarize count()
```

Backstop for inference stopping **entirely**, across all providers — a dead cron, a bad deploy, a
kill switch left on. Not per-provider on purpose; that's Monitor 2's job.

**It would NOT have caught the 2026-07-23 outage.** Global `ai_usage` stayed at 6–171 per 6h
throughout, because `summarize-release` was already on DeepSeek via OpenRouter and kept running.
Recorded explicitly so nobody mistakes it for coverage of that failure mode.

Range was widened 6h → 12h on 2026-07-28 after measurement: over 428 hourly evaluations
(Jul 11–28) a 6h window hit zero once (`2026-07-20T02:00Z`) with everything healthy, while a 12h
window never did. 6h bought one false alarm per ~2.5 weeks and no useful detection speed on a
signal this coarse.

## Monitor 4 — releases inserting with no summarization

**Alert when:** `count_ > 0`. **Window:** 60m. **Every:** 15m.

```kusto
['releases-cloudflare-logs']
| where ['body'] contains '"event":"fetch-done"' or ['body'] contains '"event":"ai_usage"'
| extend p = parse_json(['body'])
| extend ev = tostring(p['event']), lane = tostring(p['lane']), ins = toint(p['inserted'])
| summarize inserts = sumif(ins, ev == 'fetch-done'),
            summarizeCalls = countif(ev == 'ai_usage' and lane == 'summarize-release')
| where inserts >= 3 and summarizeCalls == 0
| summarize count()
```

The other three monitors infer _expected_ traffic from history, which is what forces their long
windows: on a bursty cron-driven signal, "silent for 6h" is indistinguishable from "silent because
nothing was scheduled." This one doesn't need a baseline. Ingest is schedule-anchored and
`poll-fetch.ts:2012` already emits `fetch-done` carrying how many releases were inserted, so it
correlates inference against **work that demonstrably happened** in the same window. Releases
inserting with no summarization at all is anomalous no matter how bursty the provider is — which
is what buys ~1h detection instead of 12h–60h.

Note the log field is **`inserted`**, not `releasesInserted` (that's the `fetch_log` column and
the API type; the event key is shorter).

### Why `>= 3`, and what it does not cover

Both numbers below are measured over the same Jul 12–23 healthy window used for Monitor 2:

| Rule                                 | Healthy windows | False fires |
| ------------------------------------ | --------------- | ----------- |
| `inserts >= 1` and no `ai_usage`     | 202             | 5 (~2.5%)   |
| `inserts >= 3` and no summarize lane | 143             | **0**       |

All five `>= 1` false fires were single-insert windows (`shopify-ios`, `turso`, `claude-ios`,
`livekit-rust-sdks`, `openclaw`) — an insert landing near an hour boundary with its summarize call
in the next bin, or a source that doesn't summarize at all. Requiring 3 removes them without
weakening the signal, since a real summarization outage takes out every insert, not one.

**It would NOT have caught the 2026-07-23 outage: 0 fires across 69 outage windows.** Worth being
precise about why, because the reasoning generalizes. Insertion only anchors lanes that sit
**downstream of and proportional to** it — that's `summarize-release`, which was on OpenRouter and
perfectly healthy throughout. The lanes that actually died, `feed-enrich` and
`marketing-classifier`, sit _beside_ or _before_ insertion: they're gated on per-source metadata
rather than firing per insert, and they fail open, so inserts continued at a normal rate the whole
time they were dark. A work-anchored correlate is only as good as the coupling between the work
and the lane, and for those two lanes there isn't one.

So this is a fast path for **summarization** dying, not a general replacement for Monitor 2. Keep
both.

**When it fires:** releases are being ingested but nothing is summarizing them — the provider
carrying `summarize-release` is down, its key is bad, or the lane is switched off.

**Respond:** check `summarize-release` in the lane breakdown below. If the lane is deliberately
disabled (a flag or a model var), this fires continuously and correctly — confirm intent before
chasing it as an incident.

---

## Triage queries

Lane × provider breakdown — the first thing to run for Monitor 1 or 2:

```kusto
['releases-cloudflare-logs']
| where ['body'] contains '"event":"ai_usage"'
| extend p = parse_json(['body'])
| extend provider = tostring(p['provider']), lane = tostring(p['lane']), model = tostring(p['model'])
| summarize count() by provider, lane, model
```

Per-provider daily volume — is this a cliff or a slope?

```kusto
['releases-cloudflare-logs']
| where ['body'] contains '"event":"ai_usage"'
| extend provider = tostring(parse_json(['body'])['provider'])
| summarize count() by provider, bin(_time, 1d)
```

Inserts vs. summarization, hour by hour — for Monitor 4. In healthy operation these track 1:1
(a spot check on 2026-07-28 showed 7 inserts / 7 summarize calls in the same hour):

```kusto
['releases-cloudflare-logs']
| where ['body'] contains '"event":"fetch-done"' or ['body'] contains '"event":"ai_usage"'
| extend p = parse_json(['body'])
| extend ev = tostring(p['event']), lane = tostring(p['lane']), ins = toint(p['inserted'])
| summarize inserts = sumif(ins, ev == 'fetch-done'),
            summarizeCalls = countif(ev == 'ai_usage' and lane == 'summarize-release')
  by bin(_time, 1h)
| sort by _time desc
```

Quota errors with their context:

```kusto
['releases-cloudflare-logs']
| where ['body'] contains 'provider-quota-exhausted'
| extend p = parse_json(['body'])
| project _time, provider = tostring(p['provider']), regainAccessAt = tostring(p['regainAccessAt']),
          sourceId = tostring(p['sourceId']), providerMessage = tostring(p['providerMessage'])
| sort by _time desc
```

## Retuning

Re-measure before changing any window; don't reason from the daily averages, which hide the
burstiness that makes short windows unusable. This query counts how often a given trailing window
would have been zero, per provider — set the `dynamic([...])` filter length to the window in hours
and read `zeroPoints` as the false-positive count over a healthy period:

```kusto
['releases-cloudflare-logs']
| where ['body'] contains '"event":"ai_usage"'
| extend provider = tostring(parse_json(['body'])['provider'])
| where isnotempty(provider)
| make-series c = count() default=0
    on _time from datetime(2026-07-12T00:00:00Z) to datetime(2026-07-23T00:00:00Z) step 1h
    by provider
| extend s = series_fir(c, dynamic([1,1,1,1,1,1]), false, false)   // 6 ones = 6h window
| project provider, time, s
| mv-expand time to typeof(datetime), s to typeof(long)
| summarize points = count(), zeroPoints = countif(s == 0) by provider
```

APL notes for anyone extending this: `make-series` names its time axis **`time`**, not `_time`,
and it must be `project`ed before `mv-expand`. Axiom has no `repeat()` (write the `dynamic([...])`
array out) and no `prev()` / `serialize`, so gap analysis goes through `make-series` + `series_fir`
rather than row-to-row comparison.
