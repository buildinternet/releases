import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";
import { fetchFollowingFeed } from "@/lib/follows-server";
import { FollowingClient } from "./following-client";

export const metadata: Metadata = {
  title: "Following",
  description: "Your personalized release feed from organizations and products you follow.",
  alternates: { canonical: "/following" },
  robots: { index: false, follow: false },
};

export default async function FollowingPage() {
  if (!AUTH_CONFIGURED) {
    notFound();
  }

  const initialFeed = (await fetchFollowingFeed()) ?? undefined;

  return (
    <div className="min-h-screen">
      <div className="mx-auto w-full max-w-5xl px-6">
        <FollowingClient initialFeed={initialFeed} />
      </div>
    </div>
  );
}
