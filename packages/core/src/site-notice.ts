/**
 * Site-wide notice — a single, ad-hoc announcement shown to all visitors,
 * either as a home-page card or a thin top banner. Stored as a JSON blob under
 * the `site_notice` key of the generic `site_settings` table (worker-local).
 * Pure / runtime-neutral (no zod, no DB) so the API worker, the web reader, and
 * the admin form can share the type + helpers. The zod validation schema lives
 * in `@buildinternet/releases-api-types` (`SiteNoticeSchema`) and must stay
 * structurally in sync with `SiteNotice` below.
 */

export const SITE_NOTICE_KEY = "site_notice";

/** Brand blue — the "reasonable default" color for a new notice. */
export const DEFAULT_SITE_NOTICE_COLOR = "#0081e7";

/** The two placements a notice can take. Values double as the web slot names. */
export const SITE_NOTICE_PLACEMENTS = ["home", "banner"] as const;
export type SiteNoticePlacement = (typeof SITE_NOTICE_PLACEMENTS)[number];

export interface SiteNotice {
  /** When false the notice is stored but not shown publicly. */
  active: boolean;
  /** Short human message. ≤280 chars (enforced by SiteNoticeSchema on write). */
  message: string;
  /** Optional CTA label for the link. */
  linkText?: string;
  /** Absolute http(s) URL or a site-relative "/path". */
  href?: string;
  placement: SiteNoticePlacement;
  /** Background color as a 6-digit hex (#rrggbb). */
  color: string;
  /** When true, visitors may dismiss the notice (persisted per-version). */
  dismissible: boolean;
}

/** A notice as returned by the API, stamped with the row's last-write time (ISO). */
export type StoredSiteNotice = SiteNotice & { updatedAt: string };

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** True for a strict 6-digit hex color with a leading `#`. */
export function isHexColor(value: string): boolean {
  return HEX6.test(value);
}

/**
 * Pick a readable foreground (near-black `#0c0a09` = stone-950, or `#ffffff`)
 * for a solid hex background using the WCAG relative-luminance threshold. An
 * invalid color falls back to light text (safe on the brand-blue default).
 */
export function readableTextColor(background: string): "#0c0a09" | "#ffffff" {
  if (!isHexColor(background)) return "#ffffff";
  const r = parseInt(background.slice(1, 3), 16) / 255;
  const g = parseInt(background.slice(3, 5), 16) / 255;
  const b = parseInt(background.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Threshold 0.5 keeps mid-tones (amber/green) on dark text; deep blues on light.
  return luminance > 0.5 ? "#0c0a09" : "#ffffff";
}
