# AI provider monitors (Axiom)

Alerting for "an AI provider stopped serving us" (#2168, item 5c).

On 2026-07-23 the Anthropic account hit a configured spend cap and every call was rejected for
six days. Nothing surfaced it — it was found only because the Anthropic dashboard showed $0/day
and someone asked whether that was expected. These monitors exist so that specific silence is
never again the thing that notices first.

Two failure modes, two monitors, because they need different signals:

| The provider…                              | Signal                         | Monitor |
| ------------------------------------------ | ------------------------------ | ------- |
| …rejects calls with a quota/billing error  | the error text / typed event   | 1       |
| …just stops being used, no matchable error | absence of `ai_usage`          | 2       |
| …everything stops, all providers at once   | absence of `ai_usage` globally | 3       |

All three are **live**, Threshold type, routed to the shared team notifier `sajiFns75aNFy3xSXH`
(the "Email" notifier, same channel as the auth and managed-agent monitors).

| Monitor                                    | ID                   | Window / every | Alert when   |
| ------------------------------------------ | -------------------- | -------------- | ------------ |
| AI provider quota shutoff                  | `1oo9THKJT9xDUu6hnK` | 60m / 15m      | `count_ > 0` |
| AI provider heartbeat lost                 | `RlEtnGcWm63LuiafWF` | 7d / 60m       | `count_ > 0` |
| AI inference silent — no `ai_usage` in 12h | `xuxpXTLc8wsDXcQ7mb` | 12h / 60m      | `count_ < 1` |

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

**Deliberately no `environment` filter.** The `ai_usage` events from the misrouted `feed-enrich`
and `marketing-classifier` lanes carry an **empty** `environment` field, because the same
`buildFetchOneEnv` bug that misrouted them also failed to forward `ENVIRONMENT`. An
`environment == 'production'` filter would have been blind to exactly the provider that went dark.
Staging runs no crons, so contamination is negligible. (The auth monitors hit the mirror image of
this — see the environment note in [auth-audit-monitors.md](./auth-audit-monitors.md).)

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
