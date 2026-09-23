import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DeviceApproveForm } from "@/components/device-approve-form";
import { AuthCenter } from "@/components/auth-flow";
import { AUTH_CONFIGURED, DEVICE_AUTH_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Approve device",
  description: "Approve or deny a Releases CLI device authorization request.",
  alternates: { canonical: "/device/approve" },
  robots: { index: false, follow: false },
};

export default function DeviceApprovePage() {
  if (!AUTH_CONFIGURED || !DEVICE_AUTH_ENABLED) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <AuthCenter>
        {/* useSearchParams in the form requires a Suspense boundary in the App Router. */}
        <Suspense fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}>
          <DeviceApproveForm />
        </Suspense>
      </AuthCenter>
    </div>
  );
}
