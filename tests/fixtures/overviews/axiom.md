Axiom's recent focus is AI-engineering observability — metrics reached general availability, and multiple platform features now ship paired skills for coding agents.

**Metrics went generally available**, with hyper-cardinality, unification with logs and traces, and full queryability by AI agents through MCP and a dedicated metrics skill. Alongside GA, a separate **Query metrics skill** turns coding agents into metrics-exploration experts, and dashboards can now be generated directly from metrics datasets.

**The Dashboards API landed** for full programmatic control over dashboards, followed by v2 Dashboards API support in `axiom-go`. A separate changelog entry improved export tooling, adding TOON format for query-result exports.

**AI-engineering evaluations matured on two fronts.** Online evaluations score AI capabilities against live production traffic in real-time. The **Write Evaluations skill** turns coding agents into authors of evaluation suites. A user-feedback mechanism captures feedback on AI capabilities with direct trace linking.

**`axiom-go` shipped v0.28 through v0.31.1.** v0.28 added edge support. v0.29 added a variadic `SetClientOptions` in the zerolog adapter, `messages` decoding on the `Status` object, and proxy support in `DefaultHTTPTransport`. v0.30 bumped the minimum Go version to 1.25 and OTel semconv to v1.39.0. v0.31 pooled compression writers to avoid per-call allocations, added zstd compression-level support, and accepted a `newToken` payload on the token-regenerate endpoint.

Smaller platform additions included field sorting by frequency, improved APL autocompletions, and better API-token management.
