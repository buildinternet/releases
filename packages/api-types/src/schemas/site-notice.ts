import { z } from "zod";
import { SITE_NOTICE_PLACEMENTS } from "@buildinternet/releases-core/site-notice";

/**
 * Absolute http(s) URL or a site-relative path beginning with a single "/".
 * Rejects other schemes (javascript:, data:, …) and protocol-relative "//host"
 * so a stored href can never become an unexpected-scheme or off-site link.
 */
const HrefSchema = z
  .string()
  .max(500)
  .refine((h) => /^https?:\/\//.test(h) || (h.startsWith("/") && !h.startsWith("//")), {
    message: "href must be an absolute http(s) URL or a site-relative path",
  });

/**
 * Editable site-notice fields. Kept structurally in sync with the
 * `SiteNotice` interface in `@buildinternet/releases-core/site-notice`. Split
 * from the refined `SiteNoticeSchema` below so the response schema can `.extend()`
 * it (a `.refine()` returns a non-extendable effect).
 */
const SiteNoticeFieldsSchema = z.object({
  active: z.boolean(),
  message: z.string().min(1).max(280),
  linkText: z.string().min(1).max(60).optional(),
  href: HrefSchema.optional(),
  placement: z.enum(SITE_NOTICE_PLACEMENTS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a 6-digit hex like #0081e7"),
  dismissible: z.boolean(),
});

/**
 * Editable site-notice payload. A bare `linkText` with no `href` renders nothing
 * (the view only draws a link when there's a target), so require `href` whenever
 * `linkText` is set.
 */
export const SiteNoticeSchema = SiteNoticeFieldsSchema.refine((n) => !(n.linkText && !n.href), {
  message: "href is required when linkText is set",
  path: ["href"],
});

/** GET /v1/site-notice response: the stored notice (+updatedAt) or null. */
export const SiteNoticeResponseSchema = z.object({
  notice: SiteNoticeFieldsSchema.extend({ updatedAt: z.iso.datetime() }).nullable(),
});
