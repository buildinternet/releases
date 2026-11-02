import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { authContinueTarget } from "@/lib/auth-callback";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Continuing sign-in",
  robots: { index: false, follow: false },
};

/**
 * Splitter for Better Auth flows that put success and failure on one
 * `callbackURL` (email verification). Always redirects: an `error` query goes
 * to `/auth/error`, anything else continues to the safe `next` path.
 */
export default async function AuthContinuePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; next?: string | string[] }>;
}) {
  if (!AUTH_CONFIGURED) notFound();
  const params = await searchParams;
  redirect(authContinueTarget(params));
}
