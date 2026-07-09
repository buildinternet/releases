"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { apiBase } from "@/lib/user-api";
import type {
  ListingActivateResult,
  ListingLocation,
  ListingValidationResult,
} from "@buildinternet/releases-api-types";
import { buildAgentPrompt, SKILL_INSTALL_CMD } from "./agent-prompt";

type LaneState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "result"; domain: string; result: ListingValidationResult }
  | { phase: "activating"; domain: string; result: ListingValidationResult }
  | { phase: "activated"; result: ListingActivateResult }
  | { phase: "error"; message: string };

/** Normalize pasted domain noise: strip scheme, path, trailing slash, lowercase. */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

async function readErrorMessage(res: Response): Promise<string> {
  if (res.status === 429) return "Too many checks. Please try again in a minute.";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message || "Something went sideways. Please try again.";
  } catch {
    return "Something went sideways. Please try again.";
  }
}

const KIND_LABEL: Record<ListingLocation["kind"], string> = {
  feed: "Feed",
  github: "GitHub",
  appstore: "App Store",
  url: "Page",
  file: "File",
};

function tierLabel(classification: ListingLocation["classification"]): string {
  return classification === "tier1-live" ? "Goes live" : "Reviewed first";
}

function ManifestPreview({ result }: { result: ListingValidationResult }) {
  return (
    <div className="mt-4 space-y-4">
      {result.identity && (
        <div>
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {result.identity.name}
          </p>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            {result.identity.domain}
            <span className="text-stone-300 dark:text-stone-600"> · </span>
            will list as{" "}
            <code className="font-mono text-[0.9em] text-stone-600 dark:text-stone-300">
              /{result.identity.slug}
            </code>
          </p>
        </div>
      )}

      {result.products && result.products.length > 0 && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-400 dark:text-stone-500">
            Products
          </p>
          <ul className="mt-1.5 space-y-1 text-sm text-stone-600 dark:text-stone-400">
            {result.products.map((product) => (
              <li key={product.name} className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-stone-800 dark:text-stone-200">
                  {product.name}
                </span>
                <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">
                  {product.locationCount} {product.locationCount === 1 ? "location" : "locations"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.locations.length > 0 && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-400 dark:text-stone-500">
            Release locations
          </p>
          <ul className="mt-1.5 divide-y divide-stone-100 dark:divide-stone-800/80">
            {result.locations.map((location, index) => (
              <li
                key={`${location.kind}:${location.locator}:${index}`}
                className="flex flex-col gap-1 py-2.5 first:pt-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex shrink-0 items-center font-mono text-[10px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
                      {KIND_LABEL[location.kind]}
                    </span>
                    <span className="truncate font-mono text-[0.8em] text-stone-700 dark:text-stone-300">
                      {location.locator}
                    </span>
                  </div>
                  {location.productName && (
                    <p className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">
                      {location.productName}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs">
                  <span
                    className={
                      location.classification === "tier1-live"
                        ? "font-medium text-emerald-600 dark:text-emerald-400"
                        : "font-medium text-amber-700 dark:text-amber-400"
                    }
                  >
                    {tierLabel(location.classification)}
                  </span>
                  <span className="hidden text-stone-400 dark:text-stone-500 sm:inline">
                    {location.becomes}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Compact agent affordance — no nested card chrome. */
function AgentPromptRow({ domain }: { domain: string }) {
  const { copied, copy } = useCopyToClipboard();
  const { copied: skillCopied, copy: copySkill } = useCopyToClipboard();
  const prompt = useMemo(() => buildAgentPrompt(normalizeDomain(domain) || undefined), [domain]);

  return (
    <div className="mt-8 flex flex-col gap-2 border-t border-stone-100 pt-5 dark:border-stone-800/80 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Prefer an agent? Install{" "}
        <code className="font-mono text-[0.85em] text-stone-600 dark:text-stone-300">
          creating-releases-json
        </code>{" "}
        and paste a short prompt.
      </p>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => copySkill(SKILL_INSTALL_CMD)}
          className="inline-flex items-center gap-1.5 rounded border border-stone-200 px-2.5 py-1.5 font-mono text-[11px] text-stone-600 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-900"
          aria-label={skillCopied ? "Copied install command" : "Copy skill install command"}
          title={skillCopied ? "Copied" : "Copy install command"}
        >
          <span className="max-w-[14rem] truncate sm:max-w-[18rem]">{SKILL_INSTALL_CMD}</span>
          <CopyIcon copied={skillCopied} size={12} />
        </button>
        <button
          type="button"
          onClick={() => copy(prompt)}
          className="inline-flex items-center gap-1.5 rounded border border-stone-200 px-2.5 py-1.5 text-[12px] font-medium text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
        >
          <CopyIcon copied={copied} size={12} />
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
    </div>
  );
}

export function ListingFastLane() {
  const [state, setState] = useState<LaneState>({ phase: "idle" });
  const [domainInput, setDomainInput] = useState("");

  async function checkDomain(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = normalizeDomain(domainInput);
    if (!domain) return;

    setState({ phase: "checking" });
    try {
      const res = await fetch(`${apiBase()}/v1/listing/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (!res.ok) {
        setState({ phase: "error", message: await readErrorMessage(res) });
        return;
      }
      const result = (await res.json()) as ListingValidationResult;
      setState({ phase: "result", domain, result });
    } catch {
      setState({ phase: "error", message: "Something went sideways. Please try again." });
    }
  }

  async function activate(domain: string, result: ListingValidationResult) {
    setState({ phase: "activating", domain, result });
    try {
      const res = await fetch(`${apiBase()}/v1/listing/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, requestTracking: true }),
      });
      if (!res.ok) {
        setState({ phase: "error", message: await readErrorMessage(res) });
        return;
      }
      const activateResult = (await res.json()) as ListingActivateResult;
      setState({ phase: "activated", result: activateResult });
    } catch {
      setState({ phase: "error", message: "Something went sideways. Please try again." });
    }
  }

  function resetToIdle() {
    setState({ phase: "idle" });
  }

  const checking = state.phase === "checking";
  const activating = state.phase === "activating";
  const showForm =
    state.phase === "idle" ||
    state.phase === "checking" ||
    state.phase === "error" ||
    state.phase === "result" ||
    state.phase === "activating";

  return (
    <div>
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-400">
        Enter the domain that serves{" "}
        <code className="font-mono text-[0.85em] text-stone-700 dark:text-stone-300">
          /.well-known/releases.json
        </code>
        .{" "}
        <Link
          href="/docs/listing"
          className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
        >
          How to create one
        </Link>
      </p>

      {showForm && (
        <form onSubmit={checkDomain} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label htmlFor="listing-domain" className="sr-only">
            Domain
          </label>
          <input
            id="listing-domain"
            name="domain"
            type="text"
            required
            placeholder="example.com"
            value={domainInput}
            onChange={(event) => setDomainInput(event.target.value)}
            className="w-full border border-stone-300 bg-transparent px-3 py-2.5 text-sm text-stone-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-stone-700 dark:text-stone-100"
          />
          <button
            type="submit"
            disabled={checking || activating}
            className="inline-flex h-10 shrink-0 items-center justify-center bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
          >
            {checking ? "Checking..." : "Check my listing"}
          </button>
        </form>
      )}

      {state.phase === "error" && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {state.message}
        </p>
      )}

      {(state.phase === "result" || state.phase === "activating") && (
        <div className="mt-6">
          {!state.result.valid ? (
            <div>
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                That manifest has some issues:
              </p>
              <ul className="mt-2 space-y-1.5 text-sm">
                {state.result.errors.map((error, index) => (
                  <li key={`${error.path}-${index}`} className="text-stone-600 dark:text-stone-400">
                    {error.path && (
                      <>
                        <span className="font-mono text-[0.85em] text-stone-500 dark:text-stone-500">
                          {error.path}
                        </span>{" "}
                        &mdash;{" "}
                      </>
                    )}
                    {error.message}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-center gap-4">
                <Link
                  href="/docs/listing"
                  className="text-sm font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                >
                  Manifest docs
                </Link>
                <button
                  type="button"
                  onClick={resetToIdle}
                  className="text-sm font-medium text-stone-600 underline-offset-2 hover:underline dark:text-stone-400"
                >
                  Check again
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                Valid manifest found for {state.domain}.
              </p>
              <ManifestPreview result={state.result} />

              {state.result.domainStatus === "unlisted" ? (
                <button
                  type="button"
                  onClick={() => activate(state.domain, state.result)}
                  disabled={activating}
                  className="mt-4 inline-flex h-10 shrink-0 items-center justify-center bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
                >
                  {activating ? "Activating..." : "Activate listing"}
                </button>
              ) : (
                <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
                  This domain is already{" "}
                  {state.result.domainStatus === "stub" ? "listed as a stub" : "listed"}.{" "}
                  {state.result.org && (
                    <Link
                      href={state.result.org.webUrl}
                      className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                    >
                      View listing
                    </Link>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {state.phase === "activated" && (
        <div className="mt-6">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {state.result.org.name} is listed.
          </p>
          <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
            Your listing is live as a catalog entry. Live release tracking is enabled after a
            curator review.
          </p>
          <Link
            href={state.result.org.webUrl}
            className="mt-3 inline-block text-sm font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
          >
            View listing
          </Link>
        </div>
      )}

      {showForm && <AgentPromptRow domain={domainInput} />}
    </div>
  );
}
