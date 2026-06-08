import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";
import { FollowingClient } from "./following-client";

export const metadata: Metadata = {
  title: "Following",
  description: "Your personalized release feed from organizations and products you follow.",
  alternates: { canonical: "/following" },
  robots: { index: false, follow: false },
};

export default function FollowingPage() {
  if (!AUTH_UI_ENABLED || !process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    notFound();
  }
  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto w-full max-w-4xl px-6 py-12">
        <FollowingClient />
      </div>
    </div>
  );
}
