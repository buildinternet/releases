import { z } from "zod";
import { SITE_NOTICE_PLACEMENTS } from "@buildinternet/releases-core/site-notice";

/** Absolute http(s) URL or a site-relative path beginning with "/". */
const HrefSchema = z
  .string()
  .max(500)
  .refine((h) => /^https?:\/\//.test(h) || h.startsWith("/"), {
    message: "href must be an absolute http(s) URL or a site-relative path",
  });

/**
 * Editable site-notice payload. Kept structurally in sync with the
 * `SiteNotice` interface in `@buildinternet/releases-core/site-notice`.
 */
export const SiteNoticeSchema = z.object({
  active: z.boolean(),
  message: z.string().min(1).max(280),
  linkText: z.string().min(1).max(60).optional(),
  href: HrefSchema.optional(),
  placement: z.enum(SITE_NOTICE_PLACEMENTS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a 6-digit hex like #0081e7"),
  dismissible: z.boolean(),
});

/** GET /v1/site-notice response: the stored notice (+updatedAt) or null. */
export const SiteNoticeResponseSchema = z.object({
  notice: SiteNoticeSchema.extend({ updatedAt: z.string() }).nullable(),
});
