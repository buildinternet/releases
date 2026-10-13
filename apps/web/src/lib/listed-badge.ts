/**
 * Release Notes Index badge for verified owners to place on their own site or
 * README. The badge images are static files in `public/badges/` (light and
 * dark), and every snippet links to the org's page.
 */
export type ListedBadgeTheme = "light" | "dark";

const BADGE_FILES: Record<ListedBadgeTheme, string> = {
  light: "/badges/listed.svg",
  dark: "/badges/listed-dark.svg",
};

/** Badge image path, or an absolute URL on the same origin as `orgUrl`. */
export function listedBadgeImageUrl(theme: ListedBadgeTheme, orgUrl?: string): string {
  return orgUrl ? new URL(BADGE_FILES[theme], orgUrl).toString() : BADGE_FILES[theme];
}

/** Markdown (README) and HTML (website) snippets linking `orgUrl`, the org's canonical page. */
export function listedBadgeSnippets(
  orgUrl: string,
  theme: ListedBadgeTheme,
): { html: string; markdown: string } {
  const src = listedBadgeImageUrl(theme, orgUrl);
  const alt = "Release Notes Index";
  return {
    html: `<a href="${orgUrl}"><img src="${src}" alt="${alt}" width="118" height="24"></a>`,
    markdown: `[![${alt}](${src})](${orgUrl})`,
  };
}
