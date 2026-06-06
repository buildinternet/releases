## v4.3.0

- Added `--color-output` flag to force ANSI colors in piped output.
- Added `RELEASES_CACHE_DIR` env var to relocate the on-disk cache.
- New `doctor` subcommand prints a diagnostic report of the local config.
- Telemetry is now opt-in via `RELEASES_TELEMETRY=1` (was sent automatically in 4.1.0–4.2.x).
- Improved the error message shown when the config file is malformed (PR #2291).
- Fixed a typo in the `--help` output for `sync`.
