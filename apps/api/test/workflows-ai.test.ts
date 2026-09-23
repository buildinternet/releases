import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { workflowsRoutes } from "../src/routes/workflows.js";

describe("GET /v1/workflows/batch-summarize/status/:instanceId", () => {
  function mkAppWithWorkflow(workflow: unknown) {
    const app = new Hono();
    const v1 = new Hono();
    v1.route("/", workflowsRoutes);
    app.route("/v1", v1);
    return (req: Request) => app.fetch(req, { BATCH_SUMMARIZE_WORKFLOW: workflow });
  }

  it("returns workflow status for a known instance", async () => {
    const fakeStatus = { status: "running", error: null, output: null };
    const fakeWorkflow = {
      get: async (id: string) => ({
        id,
        status: async () => fakeStatus,
      }),
    };
    const fetch = mkAppWithWorkflow(fakeWorkflow);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/batch-summarize/status/batch-summarize-admin-123"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instanceId: string;
      status: string;
    };
    expect(body.instanceId).toBe("batch-summarize-admin-123");
    expect(body.status).toBe("running");
  });

  it("returns 404 when the instance does not exist", async () => {
    const fakeWorkflow = {
      get: async () => {
        throw new Error("workflow instance not found");
      },
    };
    const fetch = mkAppWithWorkflow(fakeWorkflow);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/batch-summarize/status/nonexistent"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; type: string; message: string };
    };
    expect(body.error.code).toBe("instance_not_found");
    expect(body.error.message).toContain("not found");
  });

  it("returns 503 when the workflow binding is missing", async () => {
    const fetch = mkAppWithWorkflow(undefined);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/batch-summarize/status/anything"),
    );
    expect(res.status).toBe(503);
  });

  it("returns 500 when binding.get throws an unrelated error", async () => {
    const fakeWorkflow = {
      get: async () => {
        throw new Error("network unreachable");
      },
    };
    const fetch = mkAppWithWorkflow(fakeWorkflow);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/batch-summarize/status/some-id"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; type: string; message: string };
    };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Internal server error");
  });

  it("returns 500 when instance.status() throws", async () => {
    const fakeWorkflow = {
      get: async (id: string) => ({
        id,
        status: async () => {
          throw new Error("status RPC failed");
        },
      }),
    };
    const fetch = mkAppWithWorkflow(fakeWorkflow);

    const res = await fetch(
      new Request("https://x.test/v1/workflows/batch-summarize/status/some-id"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; type: string; message: string };
    };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Internal server error");
  });
});
