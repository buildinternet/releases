"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";
import { displayScopes, SCOPE_LABELS } from "@/lib/entitlement";
import type { OAuthClient } from "@better-auth/oauth-provider";

const buttonClass =
  "inline-flex h-10 items-center justify-center border px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";
const approveClass = `${buttonClass} border-green-600/40 bg-green-50 text-green-800 hover:bg-green-100 dark:border-green-500/40 dark:bg-green-950/40 dark:text-green-300 dark:hover:bg-green-950/60`;
const denyClass = `${buttonClass} border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900`;

/**
 * The oauthProvider server plugin is generic (`oauthProvider<O>(options)`) so
 * TypeScript cannot resolve `ReturnType<typeof oauthProvider>` → the plugin
 * endpoints don't land on the inferred `authClient` type. We declare the two
 * methods we actually call here and use a narrow cast so callers remain typed.
 */
type OAuthProviderMethods = {
  getOAuthClientPublic: (opts: {
    query: { client_id: string };
  }) => Promise<{ data: OAuthClient | null; error: { message?: string } | null }>;
  oauth2Consent: (opts: { accept: boolean; scope?: string; oauth_query?: string }) => Promise<{
    data: { redirect: boolean; url: string } | null;
    error: { message?: string } | null;
  }>;
};

// Narrow cast: only used for the two endpoints above. oauthProvider is a
// generic function so its return type doesn't propagate through
// InferPluginEndpoints — the methods exist at runtime but TypeScript can't
// infer them. Using `unknown` first prevents unsound widening.
const oauthClient = authClient as unknown as OAuthProviderMethods;

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
      const { data } = await oauthClient.getOAuthClientPublic({ query: { client_id: clientId } });
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
    const { data, error: err } = await oauthClient.oauth2Consent({
      accept: kind === "approve",
      scope: kind === "approve" ? grantable.join(" ") : undefined,
      // The oauthProviderClient fetch hook auto-injects the signed oauth_query;
      // this explicit value is a fallback in case the hook doesn't fire (e.g.
      // during SSR or when the plugin is not fully initialised).
      oauth_query:
        typeof window !== "undefined" ? window.location.search.replace(/^\?/, "") : undefined,
    });
    if (err) {
      setError(err.message ?? "Something went wrong. Please try again.");
      setBusy(null);
      return;
    }
    if (data?.url) {
      window.location.href = data.url;
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
      <p className="text-sm text-red-700 dark:text-red-400">
        No pending authorization request. Start again from the application you were using.
      </p>
    );
  }

  // No session → consent would be granted under no user, surfacing a confusing
  // submit error. Send them to sign in and resume this consent flow afterward,
  // preserving the signed OAuth params (mirrors device-approve-form's pattern).
  if (!user) {
    const ret = `/oauth/consent?${params.toString()}`;
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href={`/login?redirect=${encodeURIComponent(ret)}`} className="underline">
          sign in
        </Link>{" "}
        to continue.
      </p>
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {safeLogoUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={safeLogoUri} alt="" className="h-10 w-10 rounded" />
        ) : null}
        <div>
          <p className="text-base font-semibold text-stone-900 dark:text-stone-100">{appName}</p>
          {safeClientUri ? (
            <a
              href={safeClientUri}
              className="text-xs text-stone-500 underline dark:text-stone-400"
              target="_blank"
              rel="noreferrer"
            >
              {safeClientUri}
            </a>
          ) : null}
        </div>
      </div>

      <p className="text-sm text-stone-600 dark:text-stone-300">
        <span className="font-medium text-stone-900 dark:text-stone-100">{appName}</span> is
        requesting access to your Releases account:
      </p>

      <ul className="space-y-2">
        {grantable.map((scope) => {
          const label = SCOPE_LABELS[scope] ?? { title: scope, desc: "" };
          return (
            <li
              key={scope}
              className="border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-950"
            >
              <p className="font-medium text-stone-900 dark:text-stone-100">{label.title}</p>
              {label.desc ? (
                <p className="text-xs text-stone-500 dark:text-stone-400">{label.desc}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {grantable.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          No grantable scopes were requested, or none match your account permissions.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy !== null || grantable.length === 0}
          onClick={() => act("approve")}
          className={approveClass}
        >
          {busy === "approve" ? "Approving…" : "Allow access"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => act("deny")}
          className={denyClass}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
    </div>
  );
}
