/**
 * Account settings navigation config — the single source of truth for the
 * sidebar groups (and the panel header eyebrow group label). Each item carries
 * the icon it renders and a `ready` flag: panels whose backend doesn't exist yet
 * (Collections, Members, Billing, Integrations, Danger) are built but withheld
 * from the nav until {@link SHOW_WIP_PANELS} is flipped on. Their routes still
 * exist, so a direct visit renders the (static) preview.
 */
import type { ComponentType } from "react";
import {
  ProfileIcon,
  SecurityIcon,
  BellIcon,
  CollectionsIcon,
  GeneralIcon,
  MembersIcon,
  BillingIcon,
  IntegrationsIcon,
  WebhooksIcon,
  DangerIcon,
} from "@/components/account/icons";

/** Reveal not-yet-wired panels in the sidebar. Flip to true once their backends land. */
export const SHOW_WIP_PANELS = false;

export type AccountNavItem = {
  key: string;
  /** Sidebar label and panel `<h1>` (identical for every item). */
  label: string;
  href: string;
  /** Parent group label — also the panel header eyebrow. */
  group: string;
  /** Panel sub-heading + SEO description (single source for the route page). */
  description: string;
  Icon: ComponentType<{ className?: string }>;
  /** Whether the panel is wired to a real backend (shown in nav by default). */
  ready: boolean;
  /** Small trailing badge, e.g. "Soon" for preview features. */
  badge?: string;
};

export type AccountNavGroup = { label: string; items: AccountNavItem[] };

export const ACCOUNT_NAV: AccountNavGroup[] = [
  {
    label: "Personal",
    items: [
      {
        key: "profile",
        label: "Profile",
        href: "/account/profile",
        group: "Personal",
        description:
          "Your name, avatar, and how you appear across releases.sh and your public following page.",
        Icon: ProfileIcon,
        ready: true,
      },
      {
        key: "security",
        label: "Security",
        href: "/account/security",
        group: "Personal",
        description: "Passwords, passkeys, connected sign-in providers, and your active devices.",
        Icon: SecurityIcon,
        ready: true,
      },
      {
        key: "notifications",
        label: "Notifications",
        href: "/account/notifications",
        group: "Personal",
        description: "Choose what reaches your inbox and your personal feed.",
        Icon: BellIcon,
        ready: true,
      },
      {
        key: "collections",
        label: "Collections",
        href: "/account/collections",
        group: "Personal",
        description:
          "Track companies and keywords, and get a private feed of only the releases that mention them.",
        Icon: CollectionsIcon,
        ready: false,
        badge: "Soon",
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        key: "general",
        label: "General",
        href: "/account/general",
        group: "Workspace",
        description: "Name, URL, and defaults for this workspace. Visible to every member.",
        Icon: GeneralIcon,
        ready: true,
      },
      {
        key: "members",
        label: "Members",
        href: "/account/members",
        group: "Workspace",
        description: "Invite teammates to this workspace and manage their roles.",
        Icon: MembersIcon,
        ready: false,
      },
      {
        key: "billing",
        label: "Billing",
        href: "/account/billing",
        group: "Workspace",
        description: "Plan, usage, and payment for this workspace.",
        Icon: BillingIcon,
        ready: false,
      },
      {
        key: "integrations",
        label: "Integrations",
        href: "/account/integrations",
        group: "Workspace",
        description: "Connect the tools your team already works in.",
        Icon: IntegrationsIcon,
        ready: false,
      },
      {
        key: "webhooks",
        label: "Webhooks & API",
        href: "/account/webhooks",
        group: "Workspace",
        description:
          "Programmatic access and event delivery — API keys for the REST API and MCP server, plus signed release webhooks.",
        Icon: WebhooksIcon,
        ready: true,
      },
      {
        key: "danger",
        label: "Danger zone",
        href: "/account/danger",
        group: "Workspace",
        description: "Irreversible actions for the entire workspace.",
        Icon: DangerIcon,
        ready: false,
      },
    ],
  },
];

/** Groups with their visible items (WIP filtered unless SHOW_WIP_PANELS), empty groups dropped. */
export function visibleNavGroups(): AccountNavGroup[] {
  return ACCOUNT_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => SHOW_WIP_PANELS || i.ready),
  })).filter((g) => g.items.length > 0);
}

export function allNavItems(): AccountNavItem[] {
  return ACCOUNT_NAV.flatMap((g) => g.items);
}

/** Look up a nav item by key — the single source for a route page's header + metadata. */
export function navItem(key: string): AccountNavItem {
  const item = allNavItems().find((i) => i.key === key);
  if (!item) throw new Error(`Unknown account nav key: ${key}`);
  return item;
}
