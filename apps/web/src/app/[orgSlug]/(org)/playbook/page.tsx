import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminApi, ApiSetupError } from "@/lib/api";
import { PlaybookView } from "@/components/playbook-view";
import { isAdminViewer } from "@/lib/server-session";

export const metadata: Metadata = {
  // Admin-only surface — keep it out of search indexes.
  robots: { index: false, follow: false },
};

export default async function OrgPlaybookPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (!(await isAdminViewer())) notFound();

  const { orgSlug } = await params;
  let playbook;
  try {
    playbook = await adminApi.orgPlaybook(orgSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }
  if (!playbook) notFound();

  return <PlaybookView playbook={{ content: playbook.content, updatedAt: playbook.updatedAt }} />;
}
