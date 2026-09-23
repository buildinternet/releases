import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrgFetchLogView } from "@/components/org-fetch-log-view";
import { isAdminViewer } from "@/lib/server-session";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function OrgFetchLogPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (!(await isAdminViewer())) notFound();
  const { orgSlug } = await params;
  return <OrgFetchLogView orgSlug={orgSlug} />;
}
