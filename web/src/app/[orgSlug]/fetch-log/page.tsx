import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrgFetchLogView } from "@/components/org-fetch-log-view";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function OrgFetchLogPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { orgSlug } = await params;
  return <OrgFetchLogView orgSlug={orgSlug} />;
}
