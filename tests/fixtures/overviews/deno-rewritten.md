Deno completed its Rust-native Node.js HTTP rewrite, expanded observability tooling, and shipped Fresh 2.3 with zero-JS pages by default.

**Deno's Node.js HTTP layer is now Rust-native.** v2.7.13 swapped in llhttp and a native TCP binding, following the same rewrite pattern earlier landed for TLS and pipes. Faster, lower GC pressure, and closer to Node-on-V8 fidelity for HTTP-heavy code.

**Observability and profiling tooling expanded across patch releases.**

- Console exporter for local OpenTelemetry output
- HTTP span attributes copied to metrics
- Permission-audit data routes into OTEL pipelines
- `--cpu-prof` flag added CPU profiling output
- Function-level coverage now appears in HTML reports

**Fresh 2.3 shipped zero-JS pages by default.** Pages opt out of JavaScript unless they declare an island. The release also landed:

- View Transitions API support
- CSP nonce injection and IP filtering
- Temporal API access inside islands
- First-class WebSocket routes
- Babel CJS transform removed in favor of Vite's native handling (2.3.1–2.3.3 patched the regressions)

The 2.7.x patch cadence kept closing individual `node:*` module gaps; `node:repl` and `node:dns` improvements landed most recently.
