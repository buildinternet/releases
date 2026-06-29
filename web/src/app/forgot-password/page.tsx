import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { AuthCenter } from "@/components/auth-flow";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Reset password",
  description: "Reset your releases.sh account password.",
  alternates: { canonical: "/forgot-password" },
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  if (!AUTH_CONFIGURED) notFound();

  return (
    <div className="min-h-screen">
      <Header />
      <AuthCenter>
        <ForgotPasswordForm />
      </AuthCenter>
    </div>
  );
}
