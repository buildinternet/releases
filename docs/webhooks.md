# Webhooks

Receive `release.created` events as HTTPS POSTs to your endpoint, signed with HMAC-SHA256.

## Quickstart

Subscribe (the Rally team handles this for v1 named customers):

```bash
releases admin webhook add \
  --org acme \
  --url https://your.app/releases \
  --description "production hook"
```

The CLI prints a signing key once. Save it — you can't retrieve it later. Use `releases admin webhook rotate-secret <id>` to regenerate.

## Delivery format

Each event arrives as `POST <your-url>` with these headers:

```
Content-Type: application/json
X-Releases-Version: 1
X-Releases-Event-Id: evt_<id>         # idempotency key
X-Releases-Timestamp: <unix-seconds>
X-Releases-Signature: sha256=<hex>    # HMAC-SHA256(key, "${timestamp}.${body}")
User-Agent: releases-webhooks/1
```

Body: a JSON `ReleaseEvent` (see [architecture/events.md](./architecture/events.md)).

Respond `2xx` within 10 seconds to ack. Anything else triggers retry (5xx) or terminal failure (4xx).

## Verifying signatures

### Node.js

```js
import crypto from "node:crypto";

function verify(secret, timestamp, body, signature, now = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > 300) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(`${ts}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

### Python

```python
import hmac, hashlib, time

def verify(secret, timestamp, body, signature, now=None):
    if now is None:
        now = int(time.time())
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(now - ts) > 300:
        return False
    expected = "sha256=" + hmac.new(
        bytes.fromhex(secret),
        f"{ts}.{body}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

### Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "strconv"
    "time"
)

func verify(secret, timestamp, body, sig string) bool {
    ts, err := strconv.ParseInt(timestamp, 10, 64)
    if err != nil {
        return false
    }
    diff := time.Now().Unix() - ts
    if diff < -300 || diff > 300 {
        return false
    }
    key, err := hex.DecodeString(secret)
    if err != nil {
        return false
    }
    m := hmac.New(sha256.New, key)
    m.Write([]byte(fmt.Sprintf("%d.%s", ts, body)))
    expected := "sha256=" + hex.EncodeToString(m.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(sig))
}
```

## Replay protection

`X-Releases-Timestamp` is included in the signed input (`"${timestamp}.${body}"`), so the signature covers both the payload and the time it was issued. To prevent an attacker from capturing a valid request and replaying it later, your verifier should reject any request whose timestamp is more than ±5 minutes (300 seconds) from your server's wall clock — before performing the HMAC check. The reference snippets above already do this. A tighter window (e.g. 30 seconds) is fine if your clocks are well-synchronized.

## Idempotency

Cloudflare Queues guarantees at-least-once delivery, so the same event may arrive more than once (typically after a transient failure on your side). Use `X-Releases-Event-Id` as the dedup key and persist it in durable storage — e.g. a `processed_event_ids` table with a unique index, checked before you act on the event. An in-memory set or TTL cache is not sufficient: a process restart between delivery and ack will cause replays to be reprocessed.

## Self-serve subscriptions

Signed-in users manage webhooks at `/v1/me/webhooks` (session, `relu_` user key, or OAuth JWT). See the API for create/list/patch/delete, `rotate-secret`, `test`, and delivery history.

### Org-scoped (default)

`POST /v1/me/webhooks` with `orgId` or `orgSlug` and an optional `sourceId` / `sourceSlug` filter. Up to **10** org-scoped subscriptions per account.

### Follows-scoped

`POST /v1/me/webhooks { "scope": "follows", "url": "…" }` delivers `release.created` events for releases matching the caller's current `user_follows` graph — same semantics as `GET /v1/me/feed` (org follow covers all sources under that org; product follow matches releases from sources tied to that product). **One** follows-scoped subscription per account; it does not count against the 10 org-scoped cap. Follow/unfollow changes apply on the next publish (no snapshot). Scope cannot be converted via `PATCH` — delete and recreate.

### URL requirements

Webhook URLs must use **HTTPS** and must not target private or internal networks. Registration rejects:

- `localhost`, `.localhost`, `.local`, and `.internal` hostnames
- Private, link-local, and reserved IP ranges (RFC1918, `127.0.0.0/8`, `169.254.0.0/16`, CGNAT, …)
- Cloud metadata endpoints (e.g. `169.254.169.254`)
- Domain names that resolve (at registration time) to any private/reserved address

Use a publicly reachable HTTPS endpoint on the public internet.

### Test endpoint limits

`POST /v1/me/webhooks/:id/test` enqueues a real signed delivery. To prevent abuse, self-serve test sends are capped at **5 per minute per subscription** and **20 per minute per account**. Over-limit requests return `429` with `Retry-After: 60`.

## Retry behavior

- `2xx` → ack, no retry.
- `4xx` → no retry. Subscriber bug; fix and use `releases admin webhook test <id>` to verify.
- `5xx`, network error, timeout → retried up to 6 times with exponential backoff (~2 hours total).
- After 6 retries → message moves to the dead-letter queue. The subscription's `consecutive_failures` counter increments. After 50 consecutive failures the subscription is auto-disabled; re-enable with `releases admin webhook edit <id> --enable`.

## Replay

```
GET https://api.releases.sh/v1/webhooks/events?since=<seq>&limit=<1-500>
```

Public endpoint — no authentication required.

Response:

```json
{ "events": [...], "head": <current-seq>, "gap": { "oldestSeq": <n> } }
```

`gap` is set when `since` is below what we still have buffered (~7 days). Backfill older events via `GET /v1/releases/latest`.

## Local debugging

Verify signatures from a captured payload using the CLI:

```bash
releases webhook verify \
  --secret <key> \
  --signature <X-Releases-Signature header> \
  --timestamp <X-Releases-Timestamp header> \
  --body-file path/to/captured-body.json
```

Exit code 0 on match, 1 on mismatch.
