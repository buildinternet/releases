# Mastra

Mastra's April–May shipping sprint centered on making agents resilient, async, and cloud-deployable at scale.

**Durable agents and resumable streams landed in `@mastra/core@1.30.0`.** `DurableAgent` caches stream events so clients can reconnect mid-run via `observe(runId, { offset })`, and agents can be lifted out of the HTTP request entirely using `createEventedAgent` or `createInngestAgent` for crash-safe long-running tool loops. A pluggable `PubSub` + `ServerCache` layer (Redis/Upstash-ready defaults) backs the infrastructure.

**Background task dispatch decoupled slow tools from the main conversation turn** (`@mastra/core@1.26.0`). Agents fire off heavy tool calls asynchronously, stream the main response immediately, then inject results back when they complete. New `/api/background-tasks` endpoints, client methods, and `BackgroundTasksStorage` implementations across Redis, Postgres, MongoDB, and LibSQL ship with it. `streamUntilIdle()` complements this by keeping SSE open until all background tasks settle before closing (`@mastra/core@1.29.0`).

**Cloud sandbox and storage providers expanded significantly.** `@mastra/azure` added Azure Blob Storage workspace and content-addressable store support. `@mastra/modal` added Modal-backed isolated cloud sandbox execution with pause/resume. `@mastra/redis` introduced a Redis-backed storage provider for memory, workflows, and scores. Workspace's `filesystem` option now accepts a resolver function for per-request multi-tenant routing.

**CLI browser automation shipped in `@mastra/core@1.27.0`.** `BrowserViewer` launches Chrome via Playwright with remote debugging; `BrowserCliHandler` auto-detects browser CLI tools and injects the CDP URL. Live screencasts stream to Studio with thread-isolated session lifecycle management.

RAG and MCP tracing (from `@mastra/core@1.24.0`) and per-user server auth resource scoping (`@mastra/core@1.25.0`) remain active infrastructure.
