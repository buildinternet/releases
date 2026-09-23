/**
 * Subtle platform cue for the lean mobile-app release card — muted "iOS app" /
 * "macOS app" text, not a chip (per the no-new-chips convention). Paired with
 * {@link AppStoreIcon} + the app name, it signals "this is an App Store update"
 * so the compact card can drop the version, body preview, and thumbnail that
 * carry little meaning for a routine app release. Shared by the related rail,
 * the homepage ticker, and the org "Latest releases" teaser so the treatment
 * reads identically across all three. #mobile-app-release-cards
 *
 * Renders in both server and client components (no hooks). The visible text is
 * self-describing; `aria-label` restates it in the app's established
 * "Available for {platform}" phrasing for screen readers.
 */
export function AppPlatformCue({
  label,
  className = "",
}: {
  label: "iOS" | "macOS";
  className?: string;
}) {
  return (
    <span
      className={`text-stone-400 dark:text-stone-500 ${className}`}
      aria-label={`Available for ${label}`}
    >
      {label} app
    </span>
  );
}
