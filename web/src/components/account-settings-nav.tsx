"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut } from "@/lib/auth-client";
import { SOCIAL_PROVIDERS } from "@/lib/social-providers";
import { USER_API_KEYS_ENABLED } from "@/lib/auth-ui";

type NavItem = { label: string; href: string };

const BASE_ITEMS: NavItem[] = [
  { label: "Profile", href: "/account/profile" },
  { label: "Email", href: "/account/email" },
  { label: "Security", href: "/account/security" },
  { label: "Notifications", href: "/account/notifications" },
];

function navItems(): NavItem[] {
  const items = [...BASE_ITEMS];
  if (SOCIAL_PROVIDERS.length > 0) {
    items.splice(3, 0, { label: "Connections", href: "/account/connections" });
  }
  if (USER_API_KEYS_ENABLED) {
    items.push({ label: "API keys", href: "/account/api-keys" });
  }
  return items;
}

function NavList({
  items,
  pathname,
  onItemClick,
  onSignOut,
  signingOut,
}: {
  items: NavItem[];
  pathname: string;
  onItemClick?: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onItemClick}
                aria-current={active ? "page" : undefined}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-stone-100 font-medium text-stone-900 dark:bg-stone-800 dark:text-stone-100"
                    : "text-stone-600 hover:bg-stone-50 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-stone-100"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto border-t border-stone-200 pt-4 dark:border-stone-800">
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}

export function AccountSettingsNav() {
  const pathname = usePathname();
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [signingOut, setSigningOut] = useState(false);
  const items = navItems();
  const currentLabel = items.find((item) => item.href === pathname)?.label ?? "Account";

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
      router.push("/");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <details
        ref={detailsRef}
        className="group rounded-md border border-stone-200 dark:border-stone-800 md:hidden"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>{currentLabel}</span>
          <svg
            className="h-4 w-4 text-stone-500 transition-transform group-open:rotate-180"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </summary>
        <nav className="border-t border-stone-200 px-4 pb-4 pt-2 dark:border-stone-800">
          <NavList
            items={items}
            pathname={pathname}
            onItemClick={() => {
              if (detailsRef.current) detailsRef.current.open = false;
            }}
            onSignOut={() => void handleSignOut()}
            signingOut={signingOut}
          />
        </nav>
      </details>
      <nav className="hidden w-[200px] shrink-0 self-start md:block md:sticky md:top-6">
        <NavList
          items={items}
          pathname={pathname}
          onSignOut={() => void handleSignOut()}
          signingOut={signingOut}
        />
      </nav>
    </>
  );
}
