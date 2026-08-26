import { describe, expect, it } from "bun:test";
import { OAUTH_SCOPES } from "./entitlement.js";
import {
  oauthClientIdFromAuthorizationCode,
  oauthClientIdFromConsentBody,
  oauthClientIdFromQuery,
  oauthUserIdFromAuthorizationCode,
  restrictAuthorizationCodeValue,
  restrictOAuthConsentBody,
  restrictOAuthQueryScopes,
} from "./oauth-grant-scopes.js";

const SELF_REGISTERED = [...OAUTH_SCOPES];
const KITCHEN_SINK = "openid profile email offline_access read write admin extra";

describe("restrictOAuthQueryScopes", () => {
  it("drops unknown scope ids rather than failing the request", () => {
    expect(
      restrictOAuthQueryScopes({ client_id: "c1", scope: KITCHEN_SINK }, SELF_REGISTERED),
    ).toEqual({
      client_id: "c1",
      scope: "openid profile email offline_access read write admin",
    });
  });

  it("downscopes to the client's registered list", () => {
    expect(restrictOAuthQueryScopes({ scope: KITCHEN_SINK }, ["openid", "read"])).toEqual({
      scope: "openid read",
    });
  });

  it("leaves the query alone when every requested id is already allowed", () => {
    expect(restrictOAuthQueryScopes({ scope: "openid read" }, SELF_REGISTERED)).toBeUndefined();
  });

  it("does not strip admin at authorize (no role): a later admin login can grant it", () => {
    expect(
      restrictOAuthQueryScopes({ scope: "read write admin" }, SELF_REGISTERED),
    ).toBeUndefined();
  });

  it("returns undefined when there is no scope to rewrite", () => {
    expect(restrictOAuthQueryScopes({ client_id: "c1" }, SELF_REGISTERED)).toBeUndefined();
    expect(restrictOAuthQueryScopes(undefined, SELF_REGISTERED)).toBeUndefined();
  });

  it("rewrites to empty when nothing grantable remains", () => {
    expect(restrictOAuthQueryScopes({ scope: "not-a-scope" }, SELF_REGISTERED)).toEqual({
      scope: "",
    });
  });
});

describe("restrictOAuthConsentBody", () => {
  it("strips unknown ids from an explicit body.scope", () => {
    expect(
      restrictOAuthConsentBody({ accept: true, scope: KITCHEN_SINK }, SELF_REGISTERED),
    ).toEqual({
      accept: true,
      scope: "openid profile email offline_access read write admin",
    });
  });

  it("strips admin for a non-admin role so consent does not fail entitlement", () => {
    expect(
      restrictOAuthConsentBody(
        { accept: true, scope: "openid read write admin" },
        SELF_REGISTERED,
        "user",
      ),
    ).toEqual({
      accept: true,
      scope: "openid read",
    });
  });

  it("keeps admin for an admin role", () => {
    expect(
      restrictOAuthConsentBody(
        { accept: true, scope: "openid read write admin" },
        SELF_REGISTERED,
        "admin",
      ),
    ).toBeUndefined();
  });

  it("injects a filtered scope from oauth_query when the body omitted one", () => {
    const oauth_query = "client_id=c1&scope=openid+read+extra&sig=abc";
    expect(restrictOAuthConsentBody({ accept: true, oauth_query }, ["openid", "read"])).toEqual({
      accept: true,
      oauth_query,
      scope: "openid read",
    });
  });

  it("does not invent a scope when oauth_query has none", () => {
    expect(
      restrictOAuthConsentBody(
        { accept: true, oauth_query: "client_id=c1&sig=abc" },
        SELF_REGISTERED,
      ),
    ).toBeUndefined();
  });
});

describe("restrictAuthorizationCodeValue", () => {
  it("rewrites query.scope inside an authorization_code blob", () => {
    const value = JSON.stringify({
      type: "authorization_code",
      userId: "u1",
      query: { client_id: "c1", scope: KITCHEN_SINK },
    });
    const next = restrictAuthorizationCodeValue(value, SELF_REGISTERED);
    expect(JSON.parse(next ?? "")).toEqual({
      type: "authorization_code",
      userId: "u1",
      query: {
        client_id: "c1",
        scope: "openid profile email offline_access read write admin",
      },
    });
  });

  it("strips admin from the blob for a non-admin user", () => {
    const value = JSON.stringify({
      type: "authorization_code",
      userId: "u1",
      query: { client_id: "c1", scope: "openid read admin" },
    });
    const next = restrictAuthorizationCodeValue(value, SELF_REGISTERED, "user");
    expect(JSON.parse(next ?? "").query.scope).toBe("openid read");
  });

  it("leaves non-authorization_code values alone", () => {
    expect(
      restrictAuthorizationCodeValue(
        JSON.stringify({ type: "email", value: "x" }),
        SELF_REGISTERED,
      ),
    ).toBeUndefined();
    expect(restrictAuthorizationCodeValue("not-json", SELF_REGISTERED)).toBeUndefined();
    expect(restrictAuthorizationCodeValue(undefined, SELF_REGISTERED)).toBeUndefined();
  });
});

describe("client_id extractors", () => {
  it("reads client_id from an authorize query", () => {
    expect(oauthClientIdFromQuery({ client_id: "https://client.example/meta.json" })).toBe(
      "https://client.example/meta.json",
    );
    expect(oauthClientIdFromQuery({})).toBeUndefined();
  });

  it("reads client_id from a consent body or signed oauth_query", () => {
    expect(oauthClientIdFromConsentBody({ client_id: "direct" })).toBe("direct");
    expect(oauthClientIdFromConsentBody({ oauth_query: "client_id=from-query&scope=openid" })).toBe(
      "from-query",
    );
  });

  it("reads client_id and userId from an authorization_code blob", () => {
    const value = JSON.stringify({
      type: "authorization_code",
      userId: "u1",
      query: { client_id: "c1", scope: "read" },
    });
    expect(oauthClientIdFromAuthorizationCode(value)).toBe("c1");
    expect(oauthUserIdFromAuthorizationCode(value)).toBe("u1");
    expect(oauthClientIdFromAuthorizationCode("nope")).toBeUndefined();
  });
});
