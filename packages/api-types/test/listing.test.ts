import { describe, it, expect } from "bun:test";
import {
  ListingValidateBodySchema,
  ListingActivateBodySchema,
  ListingValidationResultSchema,
  ListingActivateResultSchema,
} from "../src/api-types.js";

describe("listing schemas", () => {
  it("accepts a bare domain body and rejects extras", () => {
    expect(ListingValidateBodySchema.safeParse({ domain: "acme.com" }).success).toBe(true);
    expect(ListingValidateBodySchema.safeParse({ domain: "" }).success).toBe(false);
    expect(ListingValidateBodySchema.safeParse({ domain: "acme.com", x: 1 }).success).toBe(false);
  });

  it("activate body defaults requestTracking to undefined and stays strict", () => {
    const ok = ListingActivateBodySchema.safeParse({ domain: "acme.com" });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.requestTracking).toBeUndefined();
    expect(
      ListingActivateBodySchema.safeParse({ domain: "acme.com", requestTracking: true }).success,
    ).toBe(true);
  });

  it("validation result round-trips an unlisted preview", () => {
    const parsed = ListingValidationResultSchema.safeParse({
      valid: true,
      errors: [],
      domainStatus: "unlisted",
      identity: { name: "Acme", slug: "acme", domain: "acme.com" },
      products: [{ name: "Widget", locationCount: 1 }],
      locations: [
        {
          locator: "https://acme.com/feed.xml",
          kind: "feed",
          classification: "tier1-live",
          becomes: "Live source when tracked",
          productName: "Widget",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("validation result carries errors + org pointer for a listed domain", () => {
    const parsed = ListingValidationResultSchema.safeParse({
      valid: false,
      errors: [{ path: "products.0.releases.0", message: "must declare exactly one locator" }],
      domainStatus: "listed",
      org: { slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" },
      locations: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("activate result covers created and existing shapes", () => {
    expect(
      ListingActivateResultSchema.safeParse({
        activated: true,
        org: { slug: "acme", name: "Acme", status: "stub", webUrl: "https://releases.sh/acme" },
        trackingRequested: false,
      }).success,
    ).toBe(true);
    expect(
      ListingActivateResultSchema.safeParse({
        activated: false,
        org: { slug: "acme", name: "Acme", status: "stub", webUrl: "https://releases.sh/acme" },
        trackingRequested: true,
      }).success,
    ).toBe(true);
  });
});
