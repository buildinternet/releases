/**
 * Tests that manage_source and manage_org action="edit" forward the
 * `discovery` field to the PATCH API endpoint (#1317).
 */
import { describe, it, expect } from "bun:test";
import { createTypedExecutor } from "../../managed-agents/src/shared/agent-tools.js";

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function makeFetcher(responses: Response[]) {
  const recorded: RecordedRequest[] = [];
  let i = 0;
  return {
    recorded,
    fetcher: {
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = new URL(typeof input === "string" ? input : input.toString());
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
        recorded.push({
          method: init?.method ?? "GET",
          path: url.pathname.replace(/^\/v1/, "") + url.search,
          body,
        });
        const res = responses[i++];
        if (!res) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
        return res;
      },
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("manage_source(edit) forwards discovery field", () => {
  it("sends discovery in the PATCH body when provided", async () => {
    const { recorded, fetcher } = makeFetcher([
      jsonResponse({ id: "src_test", slug: "example", discovery: "curated" }),
    ]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_source", {
      action: "edit",
      identifier: "org/example",
      discovery: "curated",
    });

    expect(recorded).toHaveLength(1);
    const req = recorded[0];
    expect(req.method).toBe("PATCH");
    expect(req.body?.discovery).toBe("curated");
  });

  it("does not send discovery when not provided", async () => {
    const { recorded, fetcher } = makeFetcher([jsonResponse({ id: "src_test", slug: "example" })]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_source", {
      action: "edit",
      identifier: "org/example",
      name: "Updated Name",
    });

    expect(recorded).toHaveLength(1);
    const req = recorded[0];
    expect(req.body?.discovery).toBeUndefined();
  });
});

describe("manage_org(edit) forwards discovery field", () => {
  it("sends discovery in the PATCH body when provided", async () => {
    const { recorded, fetcher } = makeFetcher([
      jsonResponse({ id: "org_test", slug: "example", discovery: "curated" }),
    ]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_org", {
      action: "edit",
      identifier: "example",
      discovery: "curated",
    });

    expect(recorded).toHaveLength(1);
    const req = recorded[0];
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/orgs/example");
    expect(req.body?.discovery).toBe("curated");
  });

  it("does not send discovery when not provided", async () => {
    const { recorded, fetcher } = makeFetcher([jsonResponse({ id: "org_test", slug: "example" })]);

    const runTool = createTypedExecutor({ fetcher, apiKey: "k" });
    await runTool("manage_org", {
      action: "edit",
      identifier: "example",
      name: "New Name",
    });

    expect(recorded).toHaveLength(1);
    const req = recorded[0];
    expect(req.body?.discovery).toBeUndefined();
  });
});
