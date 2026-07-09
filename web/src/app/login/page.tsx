import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { AuthCenter } from "@/components/auth-flow";
import { safeRedirect } from "@/lib/auth-redirect";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your releases.sh account.",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[]; reset?: string | string[] }>;
}) {
  if (!AUTH_CONFIGURED) notFound();
  const { redirect, reset } = await searchParams;
  const redirectTo = safeRedirect(redirect);
  const passwordReset = reset === "1";

  return (
    <div className="min-h-screen">
      <AuthCenter>
        {passwordReset && (
          <p
            role="status"
            className="mb-5 w-full max-w-[460px] rounded-[12px] border border-green-200 bg-green-50 px-4 py-3 text-[13px] leading-[1.5] text-green-800 dark:border-green-500/30 dark:bg-green-950/30 dark:text-green-300"
          >
            Your password has been updated. Sign in with your new password.
          </p>
        )}
        <AuthForm mode="login" redirectTo={redirectTo} />
      </AuthCenter>
    </div>
  );
}
