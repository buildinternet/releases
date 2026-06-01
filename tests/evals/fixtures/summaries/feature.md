## v3.2.0

Added a `--watch` flag to the build command that incrementally rebuilds on file
changes. Cold builds are unaffected; warm rebuilds are ~8x faster on large repos.
