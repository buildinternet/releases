import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { isSiteNoticeAdminEnabled } from "@/lib/site-notice-admin-flag";
import { getSiteNoticeAdminAction } from "@/app/actions/site-notice";
import { NoticeForm } from "./notice-form";

export const metadata: Metadata = { title: "Site notice" };

export default async function SiteNoticeAdminPage() {
  if (!isSiteNoticeAdminEnabled()) notFound();
  const current = await getSiteNoticeAdminAction();
  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-2xl mx-auto px-6 pt-8 pb-12">
        <h1 className="mb-6 text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
          Site notice
        </h1>
        <NoticeForm current={current} />
      </div>
    </div>
  );
}
