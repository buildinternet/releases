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
X-Released-Version: 1
X-Released-Event-Id: evt_<id>         # idempotency key
X-Released-Timestamp: <unix-seconds>
X-Released-Signature: sha256=<hex>    # HMAC-SHA256(key, "${timestamp}.${body}")
User-Agent: releases-webhooks/1
```

Body: a JSON `ReleaseEvent` (see [architecture/events.md](./architecture/events.md)).

Respond `2xx` within 10 seconds to ack. Anything else triggers retry (5xx) or terminal failure (4xx).

## Verifying signatures

### Node.js

```js
import crypto from "node:crypto";

function verify(secret, timestamp, body, signature) {
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", Buffer.from(secret, "hex"))
      .update(`${timestamp}.${body}`)
      .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

### Python

```python
import hmac, hashlib

def verify(secret, timestamp, body, signature):
    expected = "sha256=" + hmac.new(
        bytes.fromhex(secret),
        f"{timestamp}.{body}".encode(),
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
)

func verify(secret, ts, body, sig string) bool {
    key, _ := hex.DecodeString(secret)
    m := hmac.New(sha256.New, key)
    m.Write([]byte(fmt.Sprintf("%s.%s", ts, body)))
    expected := "sha256=" + hex.EncodeToString(m.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(sig))
}
```

## Idempotency

Cloudflare Queues guarantees at-least-once delivery, so the same event may arrive more than once (typically after a transient failure on your side). Use `X-Released-Event-Id` as the dedup key and persist it in durable storage — e.g. a `processed_event_ids` table with a unique index, checked before you act on the event. An in-memory set or TTL cache is not sufficient: a process restart between delivery and ack will cause replays to be reprocessed.

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
  --signature <X-Released-Signature header> \
  --timestamp <X-Released-Timestamp header> \
  --body-file path/to/captured-body.json
```

Exit code 0 on match, 1 on mismatch.
