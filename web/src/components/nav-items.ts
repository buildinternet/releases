export type NavItem = {
  label: string;
  href: string;
  devOnly?: boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Search", href: "/search" },
  { label: "Docs", href: "/docs" },
  { label: "Status", href: "/status", devOnly: true },
] as const;

export const GITHUB_REPO_URL = "https://github.com/buildinternet/releases-cli";

export function visibleNavItems(): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => !item.devOnly || process.env.NODE_ENV === "development");
}
