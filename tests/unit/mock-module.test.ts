/**
 * Unit tests for tests/mock-module.ts.
 *
 * Validates that the helper:
 *   - passes when the factory covers all real-module exports
 *   - throws a descriptive error when the factory is missing exports
 *   - skips the check (and still calls mock.module) for un-importable specifiers
 *   - excludes `default` from the comparison when it's only present on one side
 *
 * The "real" module under test is a bespoke fixture under __fixtures__/ rather
 * than a shared helper like tests/db-helper.ts. Two reasons: (1) the fixture's
 * export set is stable, so the helper's tests don't churn whenever an unrelated
 * shared module's surface changes; (2) even with no-op'd spies on mock.module,
 * pointing at a real module makes a future regression of that isolation
 * silently corrupt the rest of the test suite — the fixture removes the blast
 * radius entirely.
 */
import { describe, it, expect, mock, spyOn } from "bun:test";
import { mockModule } from "../mock-module.js";

const FIXTURE = "./__fixtures__/mock-module-target.ts";
const FIXTURE_WITH_DEFAULT = "./__fixtures__/mock-module-target-with-default.ts";

// ─── tests ────────────────────────────────────────────────────────────────────

describe("mockModule", () => {
  it("passes and calls mock.module when factory covers all real exports", async () => {
    // The fixture exports: alpha (function), beta (const), Gamma (class).
    // The spy is no-op'd because spyOn's default is call-through, which would
    // register a real process-global module mock for the fixture path.
    const spy = spyOn(mock, "module").mockImplementation((() => undefined) as never);
    try {
      await mockModule(
        FIXTURE,
        () => ({
          alpha: () => "stub",
          beta: 0,
          // eslint-disable-next-line @typescript-eslint/no-extraneous-class
          Gamma: class {},
        }),
        import.meta.url,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("throws with a descriptive message when factory is missing exports", async () => {
    // Omit beta and Gamma intentionally.
    let caughtMessage = "";
    try {
      await mockModule(
        FIXTURE,
        () => ({
          alpha: () => "stub",
          // beta and Gamma are intentionally absent
        }),
        import.meta.url,
      );
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).toMatch(/missing.*export/i);
  });

  it("error message names the specific missing exports", async () => {
    let caughtMessage = "";
    try {
      await mockModule(
        FIXTURE,
        () => ({
          alpha: () => "stub",
          beta: 0,
          // Gamma intentionally absent
        }),
        import.meta.url,
      );
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).toContain("Gamma");
  });

  it("skips the check and never invokes the factory for un-importable specifiers", async () => {
    const spy = spyOn(mock, "module").mockImplementation((() => undefined) as never);
    try {
      // "cloudflare:workers" is not importable in the Bun test runtime
      // (it only resolves inside a Cloudflare Worker). The helper should
      // swallow the resolution error, skip the completeness check, and
      // delegate to mock.module — without ever invoking the factory itself,
      // since mock.module is responsible for that when registering the mock.
      // The no-op spy on mock.module means the factory should run zero times.
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      class DurableObjectStub {}
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      class WorkflowEntrypointStub {}
      let factoryCalled = 0;
      const factory = () => {
        factoryCalled++;
        return {
          DurableObject: DurableObjectStub,
          WorkflowEntrypoint: WorkflowEntrypointStub,
        };
      };
      await mockModule("cloudflare:workers", factory, import.meta.url);
      expect(factoryCalled).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not flag a missing `default` export as an error (TS/CJS interop)", async () => {
    // The fixture-with-default has both a named export (phi) and a default
    // export. Omitting `default` from the factory exercises the asymmetric
    // exclusion at mock-module.ts's `onlyInReal` branch — without a fixture
    // that actually has `default`, this path would never run.
    const spy = spyOn(mock, "module").mockImplementation((() => undefined) as never);
    try {
      await mockModule(
        FIXTURE_WITH_DEFAULT,
        () => ({
          phi: "stub",
          // no `default` key — interop quirk; helper should not flag this
        }),
        import.meta.url,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
