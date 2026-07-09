import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DeviceVerifyForm } from "@/components/device-verify-form";
import { AuthCenter } from "@/components/auth-flow";
import { AUTH_CONFIGURED, DEVICE_AUTH_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Connect a device",
  description: "Authorize the Releases CLI to access your account.",
  alternates: { canonical: "/device" },
  robots: { index: false, follow: false },
};

export default function DevicePage() {
  // Dark unless the auth UI master switch AND the device-auth reveal flag are on,
  // and the Better Auth client base URL is configured (else the client 404s).
  if (!AUTH_CONFIGURED || !DEVICE_AUTH_ENABLED) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <AuthCenter>
        {/* useSearchParams in the form requires a Suspense boundary in the App Router. */}
        <Suspense fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}>
          <DeviceVerifyForm />
        </Suspense>
      </AuthCenter>
    </div>
  );
}
