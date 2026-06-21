import { describe, expect, test } from "bun:test";
import {
  buildConsumptionPayload,
  consumptionAudience,
  consumptionConsumerRef,
  consumptionPrincipal,
  consumptionPrincipalOwner,
  consumptionRefIdentity,
  OAUTH_JWT_TOKEN_PREFIX,
} from "./consumption-ref.js";
import { USER_API_KEY_PREFIX } from "@buildinternet/releases-core/api-token";

describe("consumptionConsumerRef", () => {
  test("root and anonymous are fixed buckets", async () => {
    expect(await consumptionConsumerRef({ kind: "root" })).toBe("root");
    expect(await consumptionConsumerRef({ kind: "anonymous" })).toBe("anonymous");
  });

  test("token ids hash to a stable hex ref, never echo the id", async () => {
    const a = await consumptionConsumerRef({ kind: "token", tokenId: "relk_lookup_abc" });
    const b = await consumptionConsumerRef({ kind: "token", tokenId: "relk_lookup_abc" });
    const c = await consumptionConsumerRef({ kind: "token", tokenId: "relk_lookup_xyz" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("relk");
    expect(a).not.toContain("lookup");
  });
});

describe("consumptionPrincipal (PII guard)", () => {
  test("maps every identity to a coarse type, never an id", () => {
    expect(consumptionPrincipal({ kind: "root" })).toBe("root");
    expect(consumptionPrincipal({ kind: "anonymous" })).toBe("anonymous");
    expect(consumptionPrincipal({ kind: "token", tokenId: "relk_lookup_secret" })).toBe(
      "machine_token",
    );
    expect(consumptionPrincipal({ kind: "token", tokenId: `${USER_API_KEY_PREFIX}abc` })).toBe(
      "user_key",
    );
    expect(consumptionPrincipal({ kind: "token", tokenId: `${OAUTH_JWT_TOKEN_PREFIX}sub` })).toBe(
      "oauth",
    );
  });
});

describe("consumptionAudience + principalOwner", () => {
  test("root and relk_/internal are internal; external consumers otherwise", () => {
    expect(consumptionAudience({ kind: "root" })).toBe("internal");
    expect(
      consumptionAudience({
        kind: "token",
        tokenId: "tok_internal",
        machinePrincipalType: "internal",
      }),
    ).toBe("internal");
    expect(consumptionAudience({ kind: "anonymous" })).toBe("external");
    expect(
      consumptionAudience({
        kind: "token",
        tokenId: "tok_agent",
        machinePrincipalType: "agent",
      }),
    ).toBe("external");
    expect(consumptionAudience({ kind: "token", tokenId: `${USER_API_KEY_PREFIX}x` })).toBe(
      "external",
    );
  });

  test("principalOwner segments owners without leaking ids", () => {
    expect(consumptionPrincipalOwner({ kind: "anonymous" })).toBeUndefined();
    expect(consumptionPrincipalOwner({ kind: "root" })).toBe("internal");
    expect(
      consumptionPrincipalOwner({
        kind: "token",
        tokenId: "tok_agent",
        machinePrincipalType: "agent",
      }),
    ).toBe("agent");
    expect(consumptionPrincipalOwner({ kind: "token", tokenId: `${USER_API_KEY_PREFIX}x` })).toBe(
      "user",
    );
  });
});

describe("buildConsumptionPayload", () => {
  test("includes audience and principalOwner on the wire shape", async () => {
    const payload = await buildConsumptionPayload({
      surface: "mcp",
      identity: {
        kind: "token",
        tokenId: "tok_agent",
        machinePrincipalType: "agent",
      },
      operation: "search",
    });
    expect(payload).toMatchObject({
      component: "consumption",
      surface: "mcp",
      principal: "machine_token",
      audience: "external",
      principalOwner: "agent",
      operation: "search",
    });
    expect(payload.consumerRef).toMatch(/^[0-9a-f]{64}$/);
    expect(consumptionRefIdentity({ kind: "root" })).toEqual({ kind: "root" });
  });
});
