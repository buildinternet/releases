export type NavItem = {
  label: string;
  href: string;
  devOnly?: boolean;
  mobileOnly?: boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Search", href: "/search", mobileOnly: true },
  { label: "Collections", href: "/collections" },
  { label: "Docs", href: "/docs" },
  { label: "Status", href: "/admin/status", devOnly: true },
] as const;

export const GITHUB_REPO_URL = "https://github.com/buildinternet/releases-cli";

export function visibleNavItems(options?: { mobile?: boolean }): readonly NavItem[] {
  const mobile = options?.mobile ?? false;
  return NAV_ITEMS.filter((item) => {
    if (item.devOnly && process.env.NODE_ENV !== "development") return false;
    if (item.mobileOnly && !mobile) return false;
    return true;
  });
}
