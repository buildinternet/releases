export type NavItem = {
  label: string;
  href: string;
  mobileOnly?: boolean;
  /** Extra classes for the desktop-nav link (e.g. hide at tight widths). */
  desktopClassName?: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Search", href: "/search", mobileOnly: true },
  { label: "Catalog", href: "/catalog" },
  // The 640–1024px desktop nav is already at capacity with the search
  // trigger + GitHub star; below lg this item lives in the mobile menu,
  // the footer, and the homepage links instead of overflowing the bar.
  { label: "What's new", href: "/updates", desktopClassName: "hidden lg:inline-block" },
  { label: "Collections", href: "/collections" },
  { label: "Submit", href: "/submit" },
  { label: "Docs", href: "/docs" },
] as const;

// Primary project repo — the open-source backend monorepo (API worker, MCP
// server, web frontend, ingest pipeline). The user-facing CLI has its own repo
// (buildinternet/releases-cli), linked from the docs.
export const GITHUB_REPO_URL = "https://github.com/buildinternet/releases";

export function visibleNavItems(options?: { mobile?: boolean }): readonly NavItem[] {
  const mobile = options?.mobile ?? false;
  return NAV_ITEMS.filter((item) => {
    if (item.mobileOnly && !mobile) return false;
    return true;
  });
}
