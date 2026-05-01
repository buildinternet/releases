/**
 * Fixture for the "default-interop" branch in mockModule's unit tests.
 *
 * The helper's asymmetric-default exclusion (mock-module.ts: `onlyInReal`
 * check) only fires when the real module has a `default` export and the
 * factory omits it. The other fixture (mock-module-target.ts) has no
 * default — using it for the interop test would silently skip that branch
 * because both sides would lack `default`. This fixture forces the path
 * to run.
 */

export const phi = "phi";

export default { kind: "fixture-default" };
