import { describe, expect, test } from "bun:test";
import {
  ProductRowSchema,
  ProductListItemSchema,
  SourceWithOrgSchema,
} from "@buildinternet/releases-api-types";

describe("api-types kind field", () => {
  test("ProductRowSchema accepts kind", () => {
    const parsed = ProductRowSchema.parse({
      id: "prod_x",
      name: "X",
      slug: "x",
      orgId: "org_x",
      url: null,
      description: null,
      category: null,
      createdAt: "2024-01-01T00:00:00Z",
      embeddedAt: null,
      deletedAt: null,
      kind: "sdk",
    });
    expect(parsed.kind).toBe("sdk");
  });

  test("ProductRowSchema accepts null kind", () => {
    const parsed = ProductRowSchema.parse({
      id: "prod_x",
      name: "X",
      slug: "x",
      orgId: "org_x",
      url: null,
      description: null,
      category: null,
      createdAt: "2024-01-01T00:00:00Z",
      embeddedAt: null,
      deletedAt: null,
      kind: null,
    });
    expect(parsed.kind).toBe(null);
  });

  test("ProductListItemSchema accepts kind", () => {
    const parsed = ProductListItemSchema.parse({
      id: "prod_x",
      name: "X",
      slug: "x",
      orgId: "org_x",
      url: null,
      description: null,
      category: null,
      createdAt: "2024-01-01T00:00:00Z",
      sourceCount: 0,
      kind: "platform",
    });
    expect(parsed.kind).toBe("platform");
  });

  test("ProductRowSchema rejects an unknown kind value", () => {
    expect(() =>
      ProductRowSchema.parse({
        id: "prod_x",
        name: "X",
        slug: "x",
        orgId: "org_x",
        url: null,
        description: null,
        category: null,
        createdAt: "2024-01-01T00:00:00Z",
        embeddedAt: null,
        deletedAt: null,
        kind: "framework",
      }),
    ).toThrow();
  });

  test("SourceWithOrgSchema accepts kind", () => {
    const parsed = SourceWithOrgSchema.parse({
      id: "src_x",
      name: "X",
      slug: "x",
      type: "feed",
      url: "https://example.com",
      orgName: null,
      orgSlug: null,
      productName: null,
      productSlug: null,
      isPrimary: true,
      isHidden: null,
      metadata: null,
      releaseCount: 0,
      latestVersion: null,
      latestDate: null,
      lastFetchedAt: null,
      lastPolledAt: null,
      fetchPriority: null,
      changeDetectedAt: null,
      consecutiveNoChange: null,
      consecutiveErrors: null,
      nextFetchAfter: null,
      medianGapDays: null,
      lastRetieredAt: null,
      kind: "tool",
    });
    expect(parsed.kind).toBe("tool");
  });

  test("SourceWithOrgSchema rejects an unknown kind value", () => {
    expect(() =>
      SourceWithOrgSchema.parse({
        id: "src_x",
        name: "X",
        slug: "x",
        type: "feed",
        url: "https://example.com",
        orgName: null,
        orgSlug: null,
        productName: null,
        productSlug: null,
        isPrimary: true,
        isHidden: null,
        metadata: null,
        releaseCount: 0,
        latestVersion: null,
        latestDate: null,
        lastFetchedAt: null,
        lastPolledAt: null,
        fetchPriority: null,
        changeDetectedAt: null,
        consecutiveNoChange: null,
        consecutiveErrors: null,
        nextFetchAfter: null,
        medianGapDays: null,
        lastRetieredAt: null,
        kind: "framework",
      }),
    ).toThrow();
  });
});
