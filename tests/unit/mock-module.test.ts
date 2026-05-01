/**
 * Unit tests for tests/mock-module.ts.
 *
 * Validates that the helper:
 *   - passes when the factory covers all real-module exports
 *   - throws a descriptive error when the factory is missing exports
 *   - skips the check (and still calls mock.module) for un-importable specifiers
 *   - excludes `default` from the comparison when it's only present on one side
 */
import { describe, it, expect, mock, spyOn } from "bun:test";
import { mockModule } from "../mock-module.ts";

// ─── tests ────────────────────────────────────────────────────────────────────

describe("mockModule", () => {
  it("passes and calls mock.module when factory covers all real exports", async () => {
    // Use tests/db-helper.ts as the "real" module under test (path relative to
    // *this* file, which lives in tests/unit/).
    // Its named exports are: applyMigrations, createTestDb, clearAllTables
    // (exported types don't appear as runtime keys).
    const spy = spyOn(mock, "module");
    try {
      await mockModule(
        "../db-helper.ts",
        () => ({
          applyMigrations: () => {},
          createTestDb: () => ({}),
          clearAllTables: () => {},
        }),
        import.meta.url,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("throws with a descriptive message when factory is missing exports", async () => {
    // Omit createTestDb and clearAllTables intentionally.
    await expect(
      mockModule(
        "../db-helper.ts",
        () => ({
          applyMigrations: () => {},
          // createTestDb and clearAllTables are intentionally absent
        }),
        import.meta.url,
      ),
    ).rejects.toThrow(/missing.*export/i);
  });

  it("error message names the specific missing exports", async () => {
    let caughtMessage = "";
    try {
      await mockModule(
        "../db-helper.ts",
        () => ({
          applyMigrations: () => {},
          // createTestDb intentionally absent
        }),
        import.meta.url,
      );
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).toContain("createTestDb");
  });

  it("skips the check and still calls mock.module for un-importable specifiers", async () => {
    const spy = spyOn(mock, "module");
    try {
      // "cloudflare:workers" is not importable in the Bun test runtime
      // (it only resolves inside a Cloudflare Worker). The helper should
      // swallow the import error, skip the completeness check, and still
      // delegate to mock.module so the test can proceed normally.
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      class DurableObjectStub {}
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      class WorkflowEntrypointStub {}
      await mockModule(
        "cloudflare:workers",
        () => ({
          DurableObject: DurableObjectStub,
          WorkflowEntrypoint: WorkflowEntrypointStub,
        }),
        import.meta.url,
      );
      // Should not have thrown, and mock.module should have been called.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not flag a missing `default` export as an error (TS/CJS interop)", async () => {
    // db-helper.ts has no `default` export, so if the factory doesn't include
    // one either, the check should still pass cleanly.
    const spy = spyOn(mock, "module");
    try {
      // Should resolve without throwing.
      await mockModule(
        "../db-helper.ts",
        () => ({
          applyMigrations: () => {},
          createTestDb: () => ({}),
          clearAllTables: () => {},
          // no `default` key — that's fine
        }),
        import.meta.url,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
