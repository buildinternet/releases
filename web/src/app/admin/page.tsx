import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

export const metadata: Metadata = { title: "Admin" };

const TOOLS = [
  {
    href: "/admin/site-notice",
    title: "Site notice",
    desc: "Publish a site-wide banner or home-page card.",
  },
  { href: "/admin/status", title: "Status", desc: "Live fetch-log + system status dashboard." },
  { href: "/admin/api-tokens", title: "API tokens", desc: "Mint and revoke scoped API tokens." },
];

export default function AdminHubPage() {
  if (!isLocalAdminEnabled()) notFound();
  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-12">
        <h1 className="mb-6 text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
          Admin
        </h1>
        <ul className="grid gap-3 sm:grid-cols-2">
          {TOOLS.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                className="block border border-stone-200 p-4 transition hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"
              >
                <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">
                  {t.title}
                </span>
                <span className="mt-1 block text-[13px] text-stone-500 dark:text-stone-400">
                  {t.desc}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
