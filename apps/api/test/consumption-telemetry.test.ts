import { describe, expect, test } from "bun:test";
import { apiRouteFamily } from "../src/middleware/auth";
import {
  buildConsumptionPayload,
  consumptionPrincipal,
  OAUTH_JWT_TOKEN_PREFIX,
} from "@releases/lib/consumption-ref";
import { USER_API_KEY_PREFIX } from "@buildinternet/releases-core/api-token";

// #1700 — the API consumption emit derives a PII-clean event from these helpers.
// These tests are the PII guard: emitted fields are fixed type labels and bounded
// route buckets, never a token value, user id, or id-bearing path.

describe("consumptionPrincipal (shared)", () => {
  test("maps each authenticated principal to a coarse type", () => {
    expect(consumptionPrincipal({ kind: "root" })).toBe("root");
    expect(consumptionPrincipal({ kind: "token", tokenId: "relk_lookup_secret" })).toBe(
      "machine_token",
    );
    expect(consumptionPrincipal({ kind: "token", tokenId: `${USER_API_KEY_PREFIX}abc` })).toBe(
      "user_key",
    );
    expect(
      consumptionPrincipal({ kind: "token", tokenId: `${OAUTH_JWT_TOKEN_PREFIX}subject-123` }),
    ).toBe("oauth");
  });

  test("the label never carries the token id itself (PII guard)", () => {
    const label = consumptionPrincipal({
      kind: "token",
      tokenId: "relk_supersecretlookup_topsecret",
    });
    expect(label).toBe("machine_token");
    expect(label).not.toContain("supersecret");
    expect(label).not.toContain("topsecret");
  });
});

describe("apiRouteFamily (PII guard)", () => {
  test("returns the coarse family after /v1", () => {
    expect(apiRouteFamily("/v1/orgs/vercel/releases")).toBe("orgs");
    expect(apiRouteFamily("/v1/search")).toBe("search");
    expect(apiRouteFamily("/v1/releases/rel_abc123")).toBe("releases");
    expect(apiRouteFamily("/v1/tokens/me")).toBe("tokens");
  });

  test("identifying path segments never leak into the label", () => {
    const fam = apiRouteFamily("/v1/orgs/some-private-org/sources/secret-source");
    expect(fam).toBe("orgs");
    expect(fam).not.toContain("some-private-org");
    expect(fam).not.toContain("secret-source");
  });

  test("degrades to the first segment / 'root' without a v1 prefix", () => {
    expect(apiRouteFamily("/health")).toBe("health");
    expect(apiRouteFamily("/")).toBe("root");
  });
});

describe("buildConsumptionPayload (API surface)", () => {
  test("hashes consumerRef without echoing secrets", async () => {
    const payload = await buildConsumptionPayload({
      surface: "api",
      identity: { kind: "token", tokenId: "relk_lookup_secret", machinePrincipalType: "agent" },
      operation: "GET orgs",
    });
    expect(payload.consumerRef).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.consumerRef).not.toContain("secret");
    expect(payload.audience).toBe("external");
    expect(payload.principalOwner).toBe("agent");
  });
});
