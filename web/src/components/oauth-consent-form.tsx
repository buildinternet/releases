"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";
import { displayScopes } from "@/lib/entitlement";
import {
  AuthCard,
  AuthError,
  CardTitle,
  Code,
  ConnVisual,
  Divider,
  IdentityRow,
  outlineButtonClass,
  primaryButtonClass,
  RevokeNote,
  ScopeGroups,
} from "@/components/auth-flow";
import type { OAuthClient } from "@better-auth/oauth-provider";

// IMPORTANT: call the oauth-provider endpoints by their LITERAL paths via
// `authClient.$fetch`, NOT as named methods. The client half of the plugin
// (`oauthProviderClient`) registers only a fetch hook (it injects the signed
// `oauth_query`) — it does NOT register typed action methods. So a call like
// `authClient.oauth2Consent(...)` falls through to Better Auth's generic proxy,
// which maps the camelCase name to `/oauth2-consent` (hyphen) and 404s; the real
// route is `/oauth2/consent` (slash). `$fetch` with the exact path sidesteps the
// name→path mangling, and the oauth_query hook still wraps the request.

/** Consent endpoint response — the redirect target (auth code or error). */
type ConsentResult = { redirect_uri?: string };
/** OAuth error body shape returned by the AS on a rejected request. */
type OAuthError = { error_description?: string; message?: string };

/**
 * OAuth consent form rendered on /oauth/consent. Reads the signed OAuth params
 * from URL search params, fetches the public client info, filters the requested
 * scopes to the signed-in user's entitlement, and submits accept/deny through
 * the Better Auth oauthProviderClient.
 *
 * The oauthProviderClient fetch hook auto-injects the signed `oauth_query` into
 * consent POSTs, so passing it explicitly is a belt-and-suspenders fallback only.
 */
export function OauthConsentForm() {
  const params = useSearchParams();
  const clientId = params.get("client_id") ?? "";
  const requestedScopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);

  const { data: sessionData, isPending: sessionPending } = useSession();
  const user = sessionData?.user;
  const role = (user as { role?: string } | undefined)?.role ?? null;

  const [client, setClient] = useState<OAuthClient | null>(null);
  const [clientLoading, setClientLoading] = useState(true);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) {
      setClientLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      // GET /api/auth/oauth2/public-client?client_id=… (session-gated; the
      // credentialed auth client sends the cookie). Returns OAuth metadata-named
      // fields (client_name / client_uri / logo_uri).
      const { data } = await authClient.$fetch<OAuthClient>("/oauth2/public-client", {
        method: "GET",
        query: { client_id: clientId },
      });
      if (!cancelled) {
        if (data) setClient(data);
        setClientLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const grantable = displayScopes(role, requestedScopes);

  async function act(kind: "approve" | "deny") {
    if (busy) return;
    setBusy(kind);
    setError(null);
    // POST /api/auth/oauth2/consent → { redirect_uri }. The oauthProviderClient
    // fetch hook injects the signed oauth_query; we also pass it explicitly so the
    // request is self-contained regardless of whether the hook fires.
    const { data, error: err } = await authClient.$fetch<ConsentResult>("/oauth2/consent", {
      method: "POST",
      body: {
        accept: kind === "approve",
        scope: kind === "approve" ? grantable.join(" ") : undefined,
        oauth_query:
          typeof window !== "undefined" ? window.location.search.replace(/^\?/, "") : undefined,
      },
    });
    if (err) {
      const e = err as OAuthError;
      setError(e.error_description ?? e.message ?? "Something went wrong. Please try again.");
      setBusy(null);
      return;
    }
    if (data?.redirect_uri) {
      window.location.href = data.redirect_uri;
    } else {
      setBusy(null);
    }
  }

  const isLoading = sessionPending || clientLoading;

  if (isLoading) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!clientId) {
    return (
      <AuthCard>
        <p className="py-2 text-center text-sm leading-6 text-stone-600 dark:text-stone-300">
          No pending authorization request. Start again from the application you were using.
        </p>
      </AuthCard>
    );
  }

  // No session → consent would be granted under no user, surfacing a confusing
  // submit error. Send them to sign in and resume this consent flow afterward,
  // preserving the signed OAuth params (mirrors device-approve-form's pattern).
  if (!user) {
    const ret = `/oauth/consent?${params.toString()}`;
    return (
      <AuthCard>
        <p className="py-2 text-center text-sm leading-6 text-stone-600 dark:text-stone-300">
          Please{" "}
          <Link
            href={`/login?redirect=${encodeURIComponent(ret)}`}
            className="font-medium text-[var(--accent)] underline underline-offset-2"
          >
            sign in
          </Link>{" "}
          to continue.
        </p>
      </AuthCard>
    );
  }

  const appName = client?.client_name ?? clientId;
  // Validate URL schemes before rendering — a registered client could set a
  // javascript:/vbscript:/etc. URI, which would execute on click/load. Drop any
  // URI that isn't an http(s) link (or an inline data:image for the logo).
  const safeClientUri =
    client?.client_uri && /^https?:\/\//i.test(client.client_uri) ? client.client_uri : null;
  const safeLogoUri =
    client?.logo_uri && /^(https?:\/\/|data:image\/)/i.test(client.logo_uri)
      ? client.logo_uri
      : null;
  let clientHost: string | null = null;
  if (safeClientUri) {
    try {
      clientHost = new URL(safeClientUri).host;
    } catch {
      clientHost = null;
    }
  }

  const noScopes = grantable.length === 0;

  return (
    <AuthCard
      footer={
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => act("deny")}
            className={outlineButtonClass}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <button
            type="button"
            disabled={busy !== null || noScopes}
            onClick={() => act("approve")}
            className={primaryButtonClass}
          >
            {busy === "approve" ? "Approving…" : "Allow access"}
          </button>
        </>
      }
    >
      <ConnVisual node="lock" letter={appName} logo={safeLogoUri} />
      <CardTitle>
        <span className="font-semibold">{appName}</span> wants to access your Releases account
      </CardTitle>
      {clientHost ? (
        <IdentityRow verified>
          <a
            href={safeClientUri ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {clientHost}
          </a>
        </IdentityRow>
      ) : null}

      <Divider />

      {noScopes ? (
        <p className="text-center text-sm text-stone-500 dark:text-stone-400">
          No grantable scopes were requested, or none match your account permissions.
        </p>
      ) : (
        <ScopeGroups appName={appName} scopes={grantable} />
      )}

      {error ? <AuthError>{error}</AuthError> : null}

      <RevokeNote>
        You can revoke this access anytime from <Code>/account</Code>.
      </RevokeNote>
    </AuthCard>
  );
}
