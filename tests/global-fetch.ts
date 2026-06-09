/**
 * Shared `globalThis.fetch` mocking helpers for the test suite.
 *
 * Bun loads many test files' module bodies into a single process. Capturing the
 * "real" fetch at module-load scope (`const orig = globalThis.fetch` at the top
 * of a test file) is unsafe: if another file's mock is still installed at the
 * moment this module is imported, the capture grabs that mock and its `afterEach`
 * then "restores" global fetch to the stale mock — contaminating whatever runs
 * next. The victim depends on file ordering, which is why it surfaced as an
 * intermittent, ordering-dependent CI flake (#1553).
 *
 * The fix: capture the pristine fetch exactly once, in the test preload
 * (`workers/api/test/setup.ts`) — which runs before any test module body, so no
 * mock can be installed yet. Every test restores to *that* reference, so a mock
 * can never leak across files. This module reads that captured reference.
 */
import { afterEach } from "bun:test";

/**
 * The pristine `globalThis.fetch`, captured in the test preload before any test
 * module body runs. Falls back to the current fetch if the preload didn't run
 * (e.g. a bespoke runner) — acceptable because at first import of this module
 * fetch is still pristine in that case too.
 */
export const realFetch: typeof fetch =
  (globalThis as { __REAL_FETCH__?: typeof fetch }).__REAL_FETCH__ ?? globalThis.fetch;

/** Restore `globalThis.fetch` to the pristine reference captured at preload. */
export function restoreGlobalFetch(): void {
  globalThis.fetch = realFetch;
}

/**
 * Install a mock `globalThis.fetch`. Callers should pair this with
 * `afterEach(restoreGlobalFetch)` (or `withGlobalFetchRestore()`); the preload
 * also registers a process-wide `afterEach` net so a forgotten restore can
 * never leak across files. Returns the impl for convenience.
 */
export function mockGlobalFetch<T extends typeof fetch>(impl: T): T {
  globalThis.fetch = impl;
  return impl;
}

/**
 * Register an `afterEach` (in the calling file's scope) that restores the
 * pristine fetch. Call once at the top level of a test file's `describe` (or the
 * file body) so every test in that file is cleaned up locally — belt to the
 * preload's suspenders.
 */
export function withGlobalFetchRestore(): void {
  afterEach(restoreGlobalFetch);
}
