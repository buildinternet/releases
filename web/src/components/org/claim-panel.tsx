"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { startClaim, verifyClaim, listClaims } from "@/lib/claim";
import { InlineCopyCode } from "@/components/inline-copy-code";
import type {
  OrgClaim,
  ClaimVerifyResult,
  ClaimCheckOutcome,
} from "@buildinternet/releases-api-types";

/**
 * Signed-in "Own this domain?" affordance for stub org pages (#1947). Starts a
 * claim, shows both proof options (well-known file OR DNS TXT — either
 * passes), and checks them on demand. Self-serve Tier-1 promotion for a
 * verified claim lands in a follow-up PR.
 */

type PanelState =
  | { phase: "resolving" }
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "pending"; claim: OrgClaim }
  | { phase: "verifying"; claim: OrgClaim }
  | { phase: "verified"; claim: OrgClaim }
  | { phase: "error"; message: string; claim?: OrgClaim };

function outcomeMessage(
  mechanism: "wellKnown" | "dnsTxt",
  outcome: ClaimCheckOutcome,
): string | null {
  if (outcome === "ok") return null;
  const label = mechanism === "wellKnown" ? "That file" : "That record";
  return outcome === "unreachable"
    ? `${label} wasn't reachable.`
    : `${label} was found, but didn't match.`;
}

export function ClaimPanel({ orgSlug, domain }: { orgSlug: string; domain: string | null }) {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const [state, setState] = useState<PanelState>({ phase: "resolving" });
  const [checked, setChecked] = useState<ClaimVerifyResult["checked"] | null>(null);

  useEffect(() => {
    if (isPending || !domain) return;
    if (!user) {
      setState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const claims = await listClaims();
        if (cancelled) return;
        const existing = claims.find((claim) => claim.org.slug === orgSlug);
        if (existing?.status === "verified") setState({ phase: "verified", claim: existing });
        else if (existing?.status === "pending") setState({ phase: "pending", claim: existing });
        else setState({ phase: "idle" });
      } catch {
        if (!cancelled) setState({ phase: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPending, user, domain, orgSlug]);

  async function onStart() {
    if (!domain) return;
    setState({ phase: "starting" });
    try {
      const claim = await startClaim(domain);
      setState(
        claim.status === "verified" ? { phase: "verified", claim } : { phase: "pending", claim },
      );
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Something went sideways. Please try again.",
      });
    }
  }

  async function onVerify(claim: OrgClaim) {
    setState({ phase: "verifying", claim });
    setChecked(null);
    try {
      const result = await verifyClaim(claim.id);
      setChecked(result.checked);
      setState(
        result.verified
          ? { phase: "verified", claim: result.claim }
          : { phase: "pending", claim: result.claim },
      );
    } catch (err) {
      setState({
        phase: "error",
        claim,
        message: err instanceof Error ? err.message : "Something went sideways. Please try again.",
      });
    }
  }

  if (!domain || isPending || state.phase === "resolving") return null;

  if (!user) {
    return (
      <section className="mt-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] p-5">
        <h2 className="text-[15px] font-semibold text-[var(--fg)]">Own this domain?</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--fg-3)]">
          <Link
            href={`/login?redirect=%2F${encodeURIComponent(orgSlug)}`}
            className="font-medium underline underline-offset-2"
          >
            Sign in
          </Link>{" "}
          to prove you control {domain} and unlock self-serve tracking.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] p-5">
      <h2 className="text-[15px] font-semibold text-[var(--fg)]">Own this domain?</h2>

      {state.phase === "idle" && (
        <>
          <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--fg-3)]">
            Prove you control {domain} to unlock self-serve tracking.
          </p>
          <button
            type="button"
            onClick={onStart}
            className="mt-3 inline-flex h-9 items-center justify-center rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--fg)] transition-colors hover:border-[var(--fg-4)]"
          >
            Start a claim
          </button>
        </>
      )}

      {state.phase === "starting" && (
        <p className="mt-1 text-[13.5px] text-[var(--fg-3)]">Starting a claim…</p>
      )}

      {(state.phase === "pending" || state.phase === "verifying") && (
        <ClaimInstructions
          claim={state.claim}
          verifying={state.phase === "verifying"}
          checked={checked}
          onVerify={() => onVerify(state.claim)}
        />
      )}

      {state.phase === "verified" && (
        <p className="mt-2 text-[13.5px] text-[var(--good)]">
          Verified via {state.claim.method === "dns-txt" ? "DNS TXT record" : "well-known file"}.
        </p>
      )}

      {state.phase === "error" && (
        <div>
          <p role="alert" className="mt-2 text-[13.5px] text-red-600 dark:text-red-400">
            {state.message}
          </p>
          {state.claim && (
            <ClaimInstructions
              claim={state.claim}
              verifying={false}
              checked={checked}
              onVerify={() => onVerify(state.claim as OrgClaim)}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ClaimInstructions({
  claim,
  verifying,
  checked,
  onVerify,
}: {
  claim: OrgClaim;
  verifying: boolean;
  checked: ClaimVerifyResult["checked"] | null;
  onVerify: () => void;
}) {
  if (!claim.token || !claim.instructions) return null;
  const wellKnownMessage = checked ? outcomeMessage("wellKnown", checked.wellKnown) : null;
  const dnsTxtMessage = checked ? outcomeMessage("dnsTxt", checked.dnsTxt) : null;

  return (
    <div className="mt-3 space-y-3 text-[13.5px] text-[var(--fg-3)]">
      <p>Prove control via either of the following, then verify:</p>

      <div>
        <p className="font-medium text-[var(--fg-2)]">Well-known file</p>
        <p className="mt-1">
          URL: <InlineCopyCode code={claim.instructions.wellKnownUrl} />
        </p>
        <p className="mt-1">
          Body (exact token): <InlineCopyCode code={claim.token} />
        </p>
        {wellKnownMessage && (
          <p className="mt-1 text-red-600 dark:text-red-400">{wellKnownMessage}</p>
        )}
      </div>

      <div>
        <p className="font-medium text-[var(--fg-2)]">DNS TXT record</p>
        <p className="mt-1">
          Name: <InlineCopyCode code={claim.instructions.dnsRecordName} />
        </p>
        <p className="mt-1">
          Value (exact token): <InlineCopyCode code={claim.token} />
        </p>
        {dnsTxtMessage && <p className="mt-1 text-red-600 dark:text-red-400">{dnsTxtMessage}</p>}
      </div>

      <button
        type="button"
        onClick={onVerify}
        disabled={verifying}
        className="inline-flex h-9 items-center justify-center rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--fg)] transition-colors hover:border-[var(--fg-4)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {verifying ? "Verifying…" : "Verify"}
      </button>
    </div>
  );
}
