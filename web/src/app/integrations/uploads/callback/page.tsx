import type { Metadata } from "next";
import { Suspense } from "react";
import { UploadsOAuthCallback } from "@/components/uploads-oauth-callback";

export const metadata: Metadata = {
  title: "Connect uploads",
  robots: { index: false, follow: false },
};

export default function UploadsOAuthCallbackPage() {
  return (
    <Suspense
      fallback={<p className="p-8 text-sm text-stone-500 dark:text-stone-400">Connecting…</p>}
    >
      <UploadsOAuthCallback />
    </Suspense>
  );
}
