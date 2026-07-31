"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import {
  startClaim,
  verifyClaim,
  listClaims,
  promoteListing,
  fetchListingCapabilities,
} from "@/lib/claim";
import {
  classifyReleaseLocations,
  partitionLocatorPreviews,
  KIND_LABEL,
  type LocatorPreview,
} from "@/lib/listing-locations";
import { InlineCopyCode } from "@/components/inline-copy-code";
import type {
  OrgClaim,
  ClaimVerifyResult,
  ClaimCheckOutcome,
  ListingPromoteResult,
  ListingCapabilities,
  ReleaseLocationItem,
} from "@buildinternet/releases-api-types";

/**
 * Signed-in "Own this domain?" affordance for stub org pages (#1947). Starts a
 * claim, shows both proof options (well-known file OR DNS TXT — either
 * passes), and checks them on demand. Once verified:
 *   - If self-serve promotion is on: preview locator eligibility + "Enable
 *     tracking" CTA.
 *   - If promotion is off: verified-but-waiting copy, no dead button (the
 *     API 404s promote when the kill switch is off).
 */

type PanelState =
  | { phase: "resolving" }
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "pending"; claim: OrgClaim }
  | { phase: "verifying"; claim: OrgClaim }
  | { phase: "verified"; claim: OrgClaim }
  | { phase: "promoting"; claim: OrgClaim }
  | { phase: "promoted"; claim: OrgClaim; result: ListingPromoteResult }
  | { phase: "error"; message: string; claim?: OrgClaim };

const BTN_CLASS =
  "inline-flex h-9 items-center justify-center rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--fg)] transition-colors hover:border-[var(--fg-4)]";

const FALLBACK_ERROR = "Something went sideways. Please try again.";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : FALLBACK_ERROR;
}

function promoteSummary(result: ListingPromoteResult): string {
  if (result.alreadyTracked) return "This org is already tracked.";
  const live = result.locators.filter((l) => l.outcome === "live").length;
  const queued = result.locators.filter((l) => l.outcome === "queued-for-review").length;
  const parts: string[] = [];
  if (live > 0) parts.push(`${live} source${live === 1 ? "" : "s"} live`);
  if (queued > 0) parts.push(`${queued} queued for curator review`);
  return parts.length > 0 ? `Tracking enabled — ${parts.join(", ")}.` : "Tracking enabled.";
}

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

function promoteCtaCopy(live: number, queued: number): string {
  if (live > 0 && queued === 0) {
    return "Enable tracking to start fetching these sources automatically.";
  }
  if (live > 0 && queued > 0) {
    return "Feeds, GitHub, and App Store sources go live now; pages and files stay paused until a curator reviews them.";
  }
  if (live === 0 && queued > 0) {
    return "These locations need curator review before anything is fetched. Enabling tracking queues them and marks this org as tracked.";
  }
  return "Add release locations to your releases.json before enabling tracking.";
}

function methodLabel(method: OrgClaim["method"]): string {
  return method === "dns-txt" ? "DNS TXT record" : "well-known file";
}

function LocatorGroup({
  title,
  tone,
  items,
  note,
}: {
  title: string;
  tone: "good" | "amber";
  items: LocatorPreview[];
  note: string;
}) {
  const titleClass = tone === "good" ? "text-[var(--good)]" : "text-amber-700 dark:text-amber-400";
  return (
    <div>
      <p className={`text-[13px] font-medium ${titleClass}`}>{title}</p>
      <ul className="mt-1.5 space-y-1">
        {items.map((item, i) => (
          <li
            key={`${item.kind}:${item.locator}:${i}`}
            className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--fg-2)]"
          >
            <span className="inline-flex shrink-0 items-center rounded-[6px] border border-[var(--line)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--fg-3)]">
              {KIND_LABEL[item.kind]}
            </span>
            <span className="min-w-0 truncate font-mono text-[12px]">
              {item.title ?? item.locator}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--fg-3)]">{note}</p>
    </div>
  );
}

function LocatorEligibilityPreview({
  live,
  queued,
}: {
  live: LocatorPreview[];
  queued: LocatorPreview[];
}) {
  if (live.length === 0 && queued.length === 0) return null;

  return (
    <div className="mt-3 space-y-3">
      <p className="text-[12px] font-medium uppercase tracking-wide text-[var(--fg-3)]">
        What enabling tracking will do
      </p>
      {live.length > 0 && (
        <LocatorGroup
          title="Goes live now"
          tone="good"
          items={live}
          note="RSS/Atom feeds, GitHub repos, and App Store listings fetch without AI extraction."
        />
      )}
      {queued.length > 0 && (
        <LocatorGroup
          title="Queued for curator review"
          tone="amber"
          items={queued}
          note="Bare pages and changelog files need scrape setup — nothing billable runs until a curator enables them."
        />
      )}
    </div>
  );
}

/** Body for the verified phase — promotion on vs waiting. */
function VerifiedBody({
  claim,
  promotionEnabled,
  live,
  queued,
  onPromote,
}: {
  claim: OrgClaim;
  promotionEnabled: boolean;
  live: LocatorPreview[];
  queued: LocatorPreview[];
  onPromote: (claim: OrgClaim) => void;
}) {
  const verifiedLine = (
    <p className="mt-2 text-[13.5px] text-[var(--good)]">
      Verified via {methodLabel(claim.method)}.
    </p>
  );

  if (!promotionEnabled) {
    return (
      <div>
        {verifiedLine}
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--fg-3)]">
          Self-serve tracking isn&apos;t available yet. Your ownership is verified and we&apos;ve
          recorded your request — a curator can enable tracking, or check back when self-serve rolls
          out.
        </p>
      </div>
    );
  }

  const hasLocations = live.length + queued.length > 0;
  return (
    <div>
      {verifiedLine}
      <LocatorEligibilityPreview live={live} queued={queued} />
      <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--fg-3)]">
        {promoteCtaCopy(live.length, queued.length)}
      </p>
      {hasLocations ? (
        <button type="button" onClick={() => onPromote(claim)} className={`mt-3 ${BTN_CLASS}`}>
          Enable tracking
        </button>
      ) : (
        <p className="mt-2 text-[13px] text-[var(--fg-3)]">
          Publish a{" "}
          <Link href="/docs/listing" className="font-medium underline underline-offset-2">
            releases.json
          </Link>{" "}
          with at least one release location, then return here.
        </p>
      )}
    </div>
  );
}

function ErrorPhase({
  message,
  claim,
  canPromote,
  checked,
  onPromote,
  onVerify,
}: {
  message: string;
  claim?: OrgClaim;
  canPromote: boolean;
  checked: ClaimVerifyResult["checked"] | null;
  onPromote: (claim: OrgClaim) => void;
  onVerify: (claim: OrgClaim) => void;
}) {
  return (
    <div>
      <p role="alert" className="mt-2 text-[13.5px] text-red-600 dark:text-red-400">
        {message}
      </p>
      {claim?.status === "verified" && canPromote && (
        <button type="button" onClick={() => onPromote(claim)} className={`mt-3 ${BTN_CLASS}`}>
          Try again
        </button>
      )}
      {claim && claim.status !== "verified" && (
        <ClaimInstructions
          claim={claim}
          verifying={false}
          checked={checked}
          onVerify={() => onVerify(claim)}
        />
      )}
    </div>
  );
}

export function ClaimPanel({
  orgSlug,
  domain,
  locations = [],
}: {
  orgSlug: string;
  domain: string | null;
  /** Declared release locations — used for the promote eligibility preview. */
  locations?: ReleaseLocationItem[];
}) {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const [state, setState] = useState<PanelState>({ phase: "resolving" });
  const [checked, setChecked] = useState<ClaimVerifyResult["checked"] | null>(null);
  const [capabilities, setCapabilities] = useState<ListingCapabilities | null>(null);

  const { live, queued } = useMemo(() => {
    const previews = classifyReleaseLocations(locations);
    return partitionLocatorPreviews(previews);
  }, [locations]);

  useEffect(() => {
    if (isPending || !domain) return;
    let cancelled = false;
    (async () => {
      // Capabilities are public and always loaded so we can hide a dead
      // promote CTA even for signed-out visitors who later sign in mid-session.
      const caps = await fetchListingCapabilities();
      if (cancelled) return;
      setCapabilities(caps);

      if (!user) {
        setState({ phase: "idle" });
        return;
      }
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
      setState({ phase: "error", message: errorMessage(err) });
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
      setState({ phase: "error", claim, message: errorMessage(err) });
    }
  }

  async function onPromote(claim: OrgClaim) {
    if (!domain) return;
    setState({ phase: "promoting", claim });
    try {
      const result = await promoteListing(domain);
      setState({ phase: "promoted", claim, result });
    } catch (err) {
      setState({ phase: "error", claim, message: errorMessage(err) });
    }
  }

  if (!domain || isPending || state.phase === "resolving") return null;

  // Caps load before we leave "resolving", so this is always set when we render.
  const promotionEnabled = capabilities?.promotionEnabled === true;
  const canPromote = promotionEnabled && live.length + queued.length > 0;

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
          {promotionEnabled
            ? `to prove you control ${domain} and unlock self-serve tracking.`
            : `to prove you control ${domain}.`}
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
            {promotionEnabled
              ? `Prove you control ${domain} to unlock self-serve tracking.`
              : `Prove you control ${domain}. Verified ownership helps prioritize tracking.`}
          </p>
          <button type="button" onClick={onStart} className={`mt-3 ${BTN_CLASS}`}>
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
        <VerifiedBody
          claim={state.claim}
          promotionEnabled={promotionEnabled}
          live={live}
          queued={queued}
          onPromote={onPromote}
        />
      )}

      {state.phase === "promoting" && (
        <p className="mt-2 text-[13.5px] text-[var(--fg-3)]">Enabling tracking…</p>
      )}

      {state.phase === "promoted" && (
        <div>
          <p className="mt-2 text-[13.5px] text-[var(--good)]">{promoteSummary(state.result)}</p>
          <Link
            href={`/${state.claim.org.slug}`}
            className="mt-2 inline-block text-[13px] font-medium underline underline-offset-2"
          >
            View {state.claim.org.name}
          </Link>
        </div>
      )}

      {state.phase === "error" && (
        <ErrorPhase
          message={state.message}
          claim={state.claim}
          canPromote={canPromote}
          checked={checked}
          onPromote={onPromote}
          onVerify={onVerify}
        />
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
        className={`${BTN_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {verifying ? "Verifying…" : "Verify"}
      </button>
    </div>
  );
}
