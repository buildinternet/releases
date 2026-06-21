import { describe, expect, test } from "bun:test";
import {
  apiConsumptionPrincipal,
  apiConsumptionRefIdentity,
  apiRouteFamily,
} from "../src/middleware/auth";
import { consumptionConsumerRef } from "@releases/lib/consumption-ref";
import { USER_API_KEY_PREFIX } from "@buildinternet/releases-core/api-token";

// #1700 — the API consumption emit derives a PII-clean event from these two
// pure helpers (principal TYPE + coarse route family). These tests are the PII
// guard: the emitted fields are a fixed type label and a bounded route bucket,
// never a token value, user id, or id-bearing path.

describe("apiConsumptionPrincipal", () => {
  test("maps each authenticated principal to a coarse type", () => {
    expect(apiConsumptionPrincipal({ kind: "root", scopes: ["admin"] })).toBe("root");
    expect(
      apiConsumptionPrincipal({ kind: "token", tokenId: "relk_lookup_secret", scopes: ["read"] }),
    ).toBe("machine_token");
    expect(
      apiConsumptionPrincipal({
        kind: "token",
        tokenId: `${USER_API_KEY_PREFIX}abc`,
        scopes: ["read"],
      }),
    ).toBe("user_key");
    expect(
      apiConsumptionPrincipal({ kind: "token", tokenId: "oauth_subject-123", scopes: ["read"] }),
    ).toBe("oauth");
  });

  test("the label never carries the token id itself (PII guard)", () => {
    const label = apiConsumptionPrincipal({
      kind: "token",
      tokenId: "relk_supersecretlookup_topsecret",
      scopes: ["read"],
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

describe("apiConsumptionRefIdentity + consumerRef (#1719)", () => {
  test("maps principals to stable ref inputs without echoing secrets", async () => {
    expect(apiConsumptionRefIdentity({ kind: "root", scopes: ["admin"] })).toEqual({
      kind: "root",
    });
    const ref = await consumptionConsumerRef(
      apiConsumptionRefIdentity({
        kind: "token",
        tokenId: "relk_lookup_secret",
        scopes: ["read"],
      }),
    );
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(ref).not.toContain("secret");
  });
});
