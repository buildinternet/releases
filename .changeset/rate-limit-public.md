---
"@buildinternet/releases": patch
---

Adds an optional per-IP rate limiter for unauthenticated public reads on the hosted API. Gated by a `RATE_LIMIT_ENABLED` worker var that defaults to off, so the initial deploy is a no-op. Callers presenting a valid API key bypass the limiter, so CLI and MCP tooling in remote mode are never throttled. Throttled requests receive a 429 with a `Retry-After` header.
