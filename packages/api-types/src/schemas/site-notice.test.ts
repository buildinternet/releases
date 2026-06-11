import { describe, expect, it } from "bun:test";
import { SiteNoticeSchema, SiteNoticeResponseSchema } from "./site-notice";

const valid = {
  active: true,
  message: "We shipped a new feed",
  linkText: "See it",
  href: "https://releases.sh/updates",
  placement: "banner" as const,
  color: "#0081e7",
  dismissible: false,
};

describe("SiteNoticeSchema", () => {
  it("accepts a fully-specified notice", () => {
    expect(SiteNoticeSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a site-relative href and omitted link", () => {
    const { href, linkText, ...rest } = valid;
    expect(SiteNoticeSchema.safeParse({ ...rest, href: "/updates" }).success).toBe(true);
    expect(SiteNoticeSchema.safeParse(rest).success).toBe(true);
  });
  it("rejects an over-length message", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, message: "x".repeat(281) }).success).toBe(false);
  });
  it("rejects an empty message", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, message: "" }).success).toBe(false);
  });
  it("rejects a bad placement", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, placement: "footer" }).success).toBe(false);
  });
  it("rejects a non-hex color", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, color: "blue" }).success).toBe(false);
    expect(SiteNoticeSchema.safeParse({ ...valid, color: "#fff" }).success).toBe(false);
  });
  it("rejects an href that is neither absolute http(s) nor root-relative", () => {
    expect(SiteNoticeSchema.safeParse({ ...valid, href: "ftp://x.y" }).success).toBe(false);
    expect(SiteNoticeSchema.safeParse({ ...valid, href: "updates" }).success).toBe(false);
  });
});

describe("SiteNoticeResponseSchema", () => {
  it("accepts null", () => {
    expect(SiteNoticeResponseSchema.safeParse({ notice: null }).success).toBe(true);
  });
  it("accepts a stored notice with updatedAt", () => {
    const r = SiteNoticeResponseSchema.safeParse({
      notice: { ...valid, updatedAt: "2026-06-11T00:00:00.000Z" },
    });
    expect(r.success).toBe(true);
  });
});
