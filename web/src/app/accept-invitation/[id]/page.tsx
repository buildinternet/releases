import type { Metadata } from "next";
import { Header } from "@/components/header";
import { AcceptInvitation } from "@/components/accept-invitation";

export const metadata: Metadata = {
  title: "Accept invitation",
  description: "Accept your workspace invitation on releases.sh.",
  robots: { index: false, follow: false },
};

export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-6 py-16">
        <AcceptInvitation invitationId={id} />
      </main>
    </div>
  );
}
