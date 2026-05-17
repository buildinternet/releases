import { AccountIcon } from "./account-link";

/**
 * Renders the GitHub logo for github-sourced rows; returns null for every
 * other source type. The generic globe and RSS-feed icons it used to render
 * carried no real signal — every non-GitHub source resolved to the same
 * globe glyph — so the icon was hiding a useful distinction (this row is a
 * repo) behind decoration. Callers that want a visual marker for non-GitHub
 * sources should use a labelled badge instead.
 */
export function SourceTypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  if (type !== "github") return null;
  return (
    <AccountIcon
      platform="github"
      size={size}
      className="text-stone-900 dark:text-stone-100 opacity-25"
    />
  );
}
