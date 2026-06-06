## 7.2.1

- Reworked the websocket reconnect backoff to use jitter.
- Fixed unbounded memory growth in the subscription manager — long-lived
  connections could climb past 8 GB RSS before the process was OOM-killed,
  dropping every in-flight write that had not yet been flushed.
- Updated the bundled CA certificate store.
- Polished the loading spinner animation.
