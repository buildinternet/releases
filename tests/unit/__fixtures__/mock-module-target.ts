/**
 * Fixture module for tests/unit/mock-module.test.ts.
 *
 * The mockModule helper extracts value-level exports from a real module's
 * source via static analysis. The unit tests need a stable target whose
 * export set never changes — pointing them at a real shared module like
 * tests/db-helper.ts would couple the helper's tests to that module's
 * surface and risk cross-file mock leakage if the spy isolation ever
 * regressed. A bespoke fixture keeps the assertions tight.
 *
 * Three named exports exercise the function/const/class-extraction paths
 * inside extractValueExports. There is intentionally no default export so
 * the "default missing on only one side" interop case can be tested.
 */

export function alpha(): string {
  return "alpha";
}

export const beta = 42;

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class Gamma {}
