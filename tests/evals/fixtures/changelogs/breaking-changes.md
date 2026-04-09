# Release Notes

## 5.0.0 — April 1, 2024

### Breaking Changes

- **Node.js 16 is no longer supported.** Minimum required version is now Node.js 18.
- The `initialize()` function has been renamed to `setup()`. The old name will throw a deprecation error.
- Configuration file format changed from `.myapprc` to `myapp.config.js`. Run `npx myapp migrate-config` to convert.

### New Features

- Added TypeScript 5.4 support
- New plugin system for extending core functionality

### Migration Guide

1. Update your Node.js version to 18 or later
2. Replace all `initialize()` calls with `setup()`
3. Run `npx myapp migrate-config`

## 4.9.2 — March 15, 2024

### Bug Fixes

- Fixed memory leak in WebSocket connection handler
- Corrected type definitions for `Config` interface
