import { describe, it, expect } from "bun:test";
import { mcpPrincipal } from "../src/rate-limit";
import type { McpIdentity } from "../src/auth";

const anon: McpIdentity = {
  kind: "anonymous",
  scopes: ["read"],
  tokenId: null,
  token: null,
  userToken: null,
};

describe("mcpPrincipal", () => {
  it("maps anonymous identity to the IP bucket", () => {
    expect(mcpPrincipal(anon, "1.1.1.1")).toEqual({ tier: "anonymous", bucketKey: "1.1.1.1" });
  });

  it("maps an OAuth-JWT user token to the account tier, keyed on the userId (<sub>)", () => {
    const id: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      tokenId: "oauth_user_9",
      token: null,
      userToken: "jwt",
      userId: "user_9",
    };
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "user_9" });
  });

  it("maps a relu_ user key to the account tier, bucketed on the owning userId (#1729)", () => {
    const id: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      tokenId: "relu_key_3",
      token: null,
      userToken: "relu_x",
      userId: "user_42",
    };
    // /v1/tokens/me now exposes the owner userId, so all of a user's relu_ keys
    // share one per-account bucket instead of one bucket per key.
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "user_42" });
  });

  it("two relu_ keys owned by the same user share one account bucket (#1729)", () => {
    const keyA: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      token: null,
      userId: "user_42",
      tokenId: "relu_key_a",
      userToken: "relu_a",
    };
    const keyB: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      token: null,
      userId: "user_42",
      tokenId: "relu_key_b",
      userToken: "relu_b",
    };
    expect(mcpPrincipal(keyA, "1.1.1.1")).toEqual(mcpPrincipal(keyB, "1.1.1.1"));
  });

  it("falls back to per-key bucketing when an older API omits userId", () => {
    const id: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      tokenId: "relu_key_3",
      token: null,
      userToken: "relu_x",
      userId: null,
    };
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "relu_key_3" });
  });

  it("maps a relk_ machine token to the machine tier", () => {
    const id: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      tokenId: "tok_1",
      token: "relk_x",
      userToken: null,
      userId: null,
    };
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "machine", bucketKey: "tok_1" });
  });

  it("maps root to exempt", () => {
    const id: McpIdentity = {
      kind: "root",
      scopes: ["*"],
      tokenId: null,
      token: null,
      userToken: null,
    };
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "exempt" });
  });
});
