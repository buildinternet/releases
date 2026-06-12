export type NavItem = {
  label: string;
  href: string;
  mobileOnly?: boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Search", href: "/search", mobileOnly: true },
  { label: "Catalog", href: "/catalog" },
  { label: "Collections", href: "/collections" },
  { label: "Submit", href: "/submit" },
  { label: "Docs", href: "/docs" },
] as const;

export const GITHUB_REPO_URL = "https://github.com/buildinternet/releases-cli";

export function visibleNavItems(options?: { mobile?: boolean }): readonly NavItem[] {
  const mobile = options?.mobile ?? false;
  return NAV_ITEMS.filter((item) => {
    if (item.mobileOnly && !mobile) return false;
    return true;
  });
}
