import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { AuthCard, AuthCenter, AuthHeading } from "@/components/auth-flow";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Set a new password",
  description: "Set a new password for your releases.sh account.",
  alternates: { canonical: "/reset-password" },
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  if (!AUTH_CONFIGURED) notFound();
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : undefined;
  const hasError = Boolean(params.error) || !token;

  return (
    <div className="min-h-screen">
      <AuthCenter>
        {hasError ? (
          <AuthCard>
            <AuthHeading
              title="This reset link is invalid"
              subtitle={
                <>
                  This password reset link is invalid or has expired.{" "}
                  <Link
                    href="/forgot-password"
                    className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                  >
                    Request a new one
                  </Link>
                  .
                </>
              }
            />
          </AuthCard>
        ) : (
          <ResetPasswordForm token={token!} />
        )}
      </AuthCenter>
    </div>
  );
}
