Deno's recent work split between completing its Node.js I/O rewrite, expanding observability tooling, and shipping a major Fresh update that fundamentally changes how islands ship JavaScript.

**`node:http` was rewritten with llhttp and a native `TCPWrap` binding in v2.7.13**, continuing the cppgc/Rust-native pattern established for TLS and pipes. v2.7.14 added delta updates via bsdiff patches to `deno upgrade`, reducing download size for incremental version jumps, and added `fs.Utf8Stream`. Alpha and beta release channels landed in v2.7.11.

**OpenTelemetry coverage expanded across multiple patch releases**: a console exporter for local OTel output, HTTP span attributes copied to metrics, and permission-audit data routable into OTEL pipelines. `--cpu-prof` flags added CPU profiling output. Function-level coverage now appears in HTML coverage reports, and `deno doc` gained support for npm packages.

**Fresh 2.3 shipped zero-JS pages by default**, View Transitions API support, CSP nonce injection, IP filtering, and Temporal API access inside islands. First-class WebSocket support was added to island routes. The Babel CJS transform was removed in favor of Vite's native handling — 2.3.1–2.3.3 patched regressions in that transition.

The existing themes around Node.js `crypto` compat, Deno Deploy GA, Deno Sandbox, and the libuv handle rewrites remain current context — the 2.7.x patch cadence continues closing individual `node:*` module gaps, most recently `node:repl` and `node:dns` improvements.
