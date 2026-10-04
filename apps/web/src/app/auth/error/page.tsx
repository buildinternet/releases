import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuthCard, AuthCenter, AuthHeading } from "@/components/auth-flow";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";
import { oauthCallbackErrorCopy } from "@/lib/oauth-callback-error";

export const metadata: Metadata = {
  title: "Sign-in didn't complete",
  description: "Something went wrong while signing in to Releases Index.",
  alternates: { canonical: "/auth/error" },
  robots: { index: false, follow: false },
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (!AUTH_CONFIGURED) notFound();
  const params = await searchParams;
  const copy = oauthCallbackErrorCopy(firstParam(params.error));

  return (
    <div className="min-h-screen">
      <AuthCenter>
        <AuthCard>
          <AuthHeading
            title={copy.title}
            subtitle={
              <>
                {copy.message}{" "}
                <Link
                  href="/login"
                  className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  Try signing in again
                </Link>
                .
              </>
            }
          />
        </AuthCard>
      </AuthCenter>
    </div>
  );
}
