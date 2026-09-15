import { describe, expect, it } from "bun:test";
import {
  orgWebhookCreatePath,
  parseWebhookCreatePrefill,
  webhookCreateInitialState,
  webhookCreateLoginPath,
} from "./webhook-create";

describe("orgWebhookCreatePath", () => {
  it("builds a Webhooks & API deep-link scoped to the org", () => {
    expect(orgWebhookCreatePath("vercel")).toBe(
      "/account/webhooks?scope=org&org=vercel#add-webhook",
    );
  });

  it("encodes unusual but valid slug characters", () => {
    expect(orgWebhookCreatePath("openai.com")).toBe(
      "/account/webhooks?scope=org&org=openai.com#add-webhook",
    );
  });
});

describe("parseWebhookCreatePrefill", () => {
  it("prefills org scope from org= alone", () => {
    expect(parseWebhookCreatePrefill({ org: "anthropic" })).toEqual({
      scope: "org",
      orgSlug: "anthropic",
    });
  });

  it("prefills when scope=org and org are both set", () => {
    expect(parseWebhookCreatePrefill({ scope: "org", org: "vercel" })).toEqual({
      scope: "org",
      orgSlug: "vercel",
    });
  });

  it("trims whitespace on the slug", () => {
    expect(parseWebhookCreatePrefill({ org: "  nextjs  " })).toEqual({
      scope: "org",
      orgSlug: "nextjs",
    });
  });

  it("takes the first value when a param is repeated", () => {
    expect(
      parseWebhookCreatePrefill({ scope: ["org", "follows"], org: ["acme", "other"] }),
    ).toEqual({
      scope: "org",
      orgSlug: "acme",
    });
  });

  it("ignores follows scope even when an org is present", () => {
    expect(parseWebhookCreatePrefill({ scope: "follows", org: "vercel" })).toBeNull();
  });

  it("ignores an unknown scope", () => {
    expect(parseWebhookCreatePrefill({ scope: "discord", org: "vercel" })).toBeNull();
  });

  it("ignores scope=org without a slug", () => {
    expect(parseWebhookCreatePrefill({ scope: "org" })).toBeNull();
    expect(parseWebhookCreatePrefill({ scope: "org", org: "   " })).toBeNull();
  });

  it("rejects path-like or empty slugs", () => {
    expect(parseWebhookCreatePrefill({ org: "../evil" })).toBeNull();
    expect(parseWebhookCreatePrefill({ org: "acme/extra" })).toBeNull();
    expect(parseWebhookCreatePrefill({ org: "" })).toBeNull();
    expect(parseWebhookCreatePrefill({})).toBeNull();
  });
});

describe("webhookCreateInitialState", () => {
  it("defaults to follows with an empty org slug", () => {
    expect(webhookCreateInitialState(null)).toEqual({ scope: "follows", orgSlug: "" });
  });

  it("applies an org prefill to the create-form state", () => {
    expect(webhookCreateInitialState({ scope: "org", orgSlug: "vercel" })).toEqual({
      scope: "org",
      orgSlug: "vercel",
    });
  });
});

describe("webhookCreateLoginPath", () => {
  it("preserves org prefill on the post-auth redirect (no hash)", () => {
    expect(webhookCreateLoginPath({ scope: "org", orgSlug: "vercel" })).toBe(
      `/login?redirect=${encodeURIComponent("/account/webhooks?scope=org&org=vercel")}`,
    );
  });

  it("falls back to the bare webhooks page without a prefill", () => {
    expect(webhookCreateLoginPath(null)).toBe(
      `/login?redirect=${encodeURIComponent("/account/webhooks")}`,
    );
  });
});
