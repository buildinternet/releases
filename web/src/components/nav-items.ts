export type NavItem = {
  label: string;
  href: string;
  mobileOnly?: boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Search", href: "/search", mobileOnly: true },
  { label: "Catalog", href: "/catalog" },
  // `/updates` is our own changelog, not a primary destination — it stays
  // linked from the footer rather than the header nav.
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
