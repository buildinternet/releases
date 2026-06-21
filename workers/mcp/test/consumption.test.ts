import { describe, expect, test } from "bun:test";
import { peekMcpCall } from "../src/auth";
import {
  buildConsumptionPayload,
  consumptionPrincipal,
  OAUTH_JWT_TOKEN_PREFIX,
} from "@releases/lib/consumption-ref";
import { USER_API_KEY_PREFIX } from "@buildinternet/releases-core/api-token";

// #1700 — the MCP consumption emit fires once per BILLABLE tool call, gated by
// `peekMcpCall`, labelled by `consumptionPrincipal`. These cover the emit
// gating ("tools/list emits nothing, tools/call emits one") and the PII guard
// (principal is a TYPE, never an id/token).

function post(body: unknown): Request {
  return new Request("https://mcp.releases.sh/mcp", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("peekMcpCall", () => {
  test("tools/list is protocol overhead — not metered (emits nothing)", async () => {
    expect((await peekMcpCall(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).metered).toBe(
      false,
    );
  });

  test("tools/call is metered, carrying the tool name as the operation", async () => {
    const r = await peekMcpCall(
      post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } }),
    );
    expect(r.metered).toBe(true);
    expect(r.tool).toBe("search");
  });

  test("initialize / notifications / ping are not metered", async () => {
    expect((await peekMcpCall(post({ method: "initialize" }))).metered).toBe(false);
    expect((await peekMcpCall(post({ method: "notifications/initialized" }))).metered).toBe(false);
    expect((await peekMcpCall(post({ method: "ping" }))).metered).toBe(false);
  });

  test("GET (SSE stream) is never metered", async () => {
    expect((await peekMcpCall(new Request("https://mcp.releases.sh/mcp"))).metered).toBe(false);
  });

  test("the clone leaves the original body intact for the downstream handler", async () => {
    const req = post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_release" },
    });
    await peekMcpCall(req);
    expect(await req.json()).toMatchObject({ method: "tools/call" });
  });
});

describe("consumptionPrincipal (PII guard — type only)", () => {
  test("maps every identity to a coarse type, never an id", () => {
    expect(consumptionPrincipal({ kind: "anonymous" })).toBe("anonymous");
    expect(consumptionPrincipal({ kind: "root" })).toBe("root");
    expect(consumptionPrincipal({ kind: "token", tokenId: "relk_lookup_secret" })).toBe(
      "machine_token",
    );
    expect(consumptionPrincipal({ kind: "token", tokenId: USER_API_KEY_PREFIX })).toBe("user_key");
    expect(
      consumptionPrincipal({ kind: "token", tokenId: `${OAUTH_JWT_TOKEN_PREFIX}subject-123` }),
    ).toBe("oauth");
  });
});

describe("buildConsumptionPayload (MCP surface)", () => {
  test("relu_ keys use distinct consumerRefs when tokenIds differ", async () => {
    const a = await buildConsumptionPayload({
      surface: "mcp",
      identity: { kind: "token", tokenId: `${USER_API_KEY_PREFIX}key-a` },
      operation: "search",
    });
    const b = await buildConsumptionPayload({
      surface: "mcp",
      identity: { kind: "token", tokenId: `${USER_API_KEY_PREFIX}key-b` },
      operation: "search",
    });
    expect(a.consumerRef).not.toBe(b.consumerRef);
    expect(a.audience).toBe("external");
    expect(a.principalOwner).toBe("user");
  });
});
