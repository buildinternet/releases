import { describe, expect, it } from "bun:test";
import {
  WORKFLOW_NOT_FOUND_RE,
  workflowInstanceStatus,
  workflowInstanceTerminate,
} from "../src/lib/workflow-instance.js";

describe("workflow-instance helpers", () => {
  it("WORKFLOW_NOT_FOUND_RE matches Cloudflare miss messages", () => {
    expect(WORKFLOW_NOT_FOUND_RE.test("instance not found")).toBe(true);
    expect(WORKFLOW_NOT_FOUND_RE.test("does not exist")).toBe(true);
  });

  it("workflowInstanceStatus returns unavailable without binding", async () => {
    const r = await workflowInstanceStatus(undefined, "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unavailable");
  });

  it("workflowInstanceTerminate returns not_found for missing instance", async () => {
    const binding = {
      get: async () => {
        throw new Error("instance not found");
      },
    };
    const r = await workflowInstanceTerminate(binding, "missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });
});
