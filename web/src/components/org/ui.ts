import { eyebrowClass } from "@/components/account/ui";

/**
 * Accent mono eyebrow used by the org-page section kickers ("Products",
 * "Activity", "Latest releases", "Recently shipped"). Builds on the shared
 * {@link eyebrowClass} so size/tracking stay single-sourced; only the accent
 * color is org-specific. The rail uses a smaller muted variant inline.
 */
export const orgEyebrowClass = `${eyebrowClass} text-[var(--accent)]`;
