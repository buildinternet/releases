import { describe, it, expect } from "bun:test";
import { mcpPrincipal } from "./rate-limit";

const anon = {
  kind: "anonymous",
  scopes: ["read"],
  tokenId: null,
  token: null,
  userToken: null,
} as const;

describe("mcpPrincipal", () => {
  it("maps anonymous identity to the IP bucket", () => {
    expect(mcpPrincipal(anon, "1.1.1.1")).toEqual({ tier: "anonymous", bucketKey: "1.1.1.1" });
  });

  it("maps an OAuth-JWT user token to the account tier", () => {
    const id = {
      kind: "token",
      scopes: ["read"],
      tokenId: "oauth_user_9",
      token: null,
      userToken: "jwt",
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "oauth_user_9" });
  });

  it("maps a relu_ user key to the account tier", () => {
    const id = {
      kind: "token",
      scopes: ["read"],
      tokenId: "relu_key_3",
      token: null,
      userToken: "relu_x",
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "relu_key_3" });
  });

  it("maps a relk_ machine token to the machine tier", () => {
    const id = {
      kind: "token",
      scopes: ["read"],
      tokenId: "tok_1",
      token: "relk_x",
      userToken: null,
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "machine", bucketKey: "tok_1" });
  });

  it("maps root to exempt", () => {
    const id = {
      kind: "root",
      scopes: ["*"],
      tokenId: null,
      token: null,
      userToken: null,
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "exempt" });
  });
});
