import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { AuthCenter } from "@/components/auth-flow";
import { safeRedirect } from "@/lib/auth-redirect";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Create a releases.sh account.",
  alternates: { canonical: "/signup" },
  robots: { index: false, follow: false },
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  if (!AUTH_CONFIGURED) notFound();
  const { redirect } = await searchParams;
  const redirectTo = safeRedirect(redirect);

  return (
    <div className="min-h-screen">
      <AuthCenter>
        <AuthForm mode="signup" redirectTo={redirectTo} />
      </AuthCenter>
    </div>
  );
}
