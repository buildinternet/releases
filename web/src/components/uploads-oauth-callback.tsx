"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { completeUploadsCallback } from "@/lib/uploads-oauth";

/**
 * Completes the uploads.sh authorization-code + PKCE handshake. The registered
 * redirect URI is this page (`/integrations/uploads/callback`); the API worker
 * holds the verifier and performs the token exchange.
 */
export function UploadsOAuthCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const oauthError = params.get("error");
    if (oauthError === "access_denied") {
      router.replace("/account/integrations?uploads=denied");
      return;
    }
    if (oauthError) {
      router.replace("/account/integrations?uploads=error");
      return;
    }

    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      router.replace("/account/integrations?uploads=error");
      return;
    }

    void completeUploadsCallback(code, state)
      .then(() => {
        router.replace("/account/integrations?uploads=connected");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "";
        if (/sign in/i.test(message)) {
          const next = `/integrations/uploads/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
          router.replace(`/login?redirect=${encodeURIComponent(next)}`);
          return;
        }
        router.replace("/account/integrations?uploads=error");
      });
  }, [params, router]);

  return (
    <main className="mx-auto flex min-h-[40vh] max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm text-stone-600 dark:text-stone-300">Connecting uploads.sh…</p>
    </main>
  );
}
