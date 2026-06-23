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

  it("maps an OAuth-JWT user token to the account tier, keyed on the userId (prefix stripped)", () => {
    const id: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      tokenId: "oauth_user_9",
      token: null,
      userToken: "jwt",
    };
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "user_9" });
  });

  it("maps a relu_ user key to the account tier, bucketed per-key (MCP has no owner userId)", () => {
    const id: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      tokenId: "relu_key_3",
      token: null,
      userToken: "relu_x",
    };
    // MCP's /tokens/me introspection returns the key id, not the owner userId, so
    // relu_ keys bucket per-key here (documented exception; see accountBucketKey).
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "relu_key_3" });
  });

  it("maps a relk_ machine token to the machine tier", () => {
    const id: McpIdentity = {
      kind: "token",
      scopes: ["read"],
      tokenId: "tok_1",
      token: "relk_x",
      userToken: null,
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
