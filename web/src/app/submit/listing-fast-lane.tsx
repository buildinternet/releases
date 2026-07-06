"use client";

import Link from "next/link";
import { useState } from "react";
import { apiBase } from "@/lib/user-api";
import type {
  ListingActivateResult,
  ListingValidationResult,
} from "@buildinternet/releases-api-types";

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

function classificationLabel(classification: "tier1-live" | "tier2-paused-review"): string {
  return classification === "tier1-live" ? "goes live" : "reviewed first";
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300">
      {children}
    </span>
  );
}

function LocationsPreview({ result }: { result: ListingValidationResult }) {
  return (
    <div className="mt-4 space-y-4">
      {result.identity && (
        <div className="text-sm text-stone-700 dark:text-stone-300">
          <span className="font-semibold text-stone-900 dark:text-stone-100">
            {result.identity.name}
          </span>{" "}
          <span className="font-mono text-[0.85em] text-stone-500 dark:text-stone-400">
            ({result.identity.slug})
          </span>{" "}
          &middot; {result.identity.domain}
        </div>
      )}

      {result.products && result.products.length > 0 && (
        <ul className="space-y-1 text-sm text-stone-600 dark:text-stone-400">
          {result.products.map((product) => (
            <li key={product.name}>
              {product.name} &middot; {product.locationCount}{" "}
              {product.locationCount === 1 ? "location" : "locations"}
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-x-auto border border-stone-200 dark:border-stone-800">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-[11px] uppercase tracking-[0.14em] text-stone-400 dark:border-stone-800 dark:text-stone-500">
              <th className="px-3 py-2 font-medium">Locator</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Becomes</th>
            </tr>
          </thead>
          <tbody>
            {result.locations.map((location, index) => (
              <tr
                key={`${location.locator}-${index}`}
                className="border-b border-stone-100 last:border-0 dark:border-stone-900"
              >
                <td className="max-w-xs truncate px-3 py-2 font-mono text-[0.85em] text-stone-700 dark:text-stone-300">
                  {location.locator}
                </td>
                <td className="px-3 py-2">
                  <Chip>{location.kind}</Chip>
                </td>
                <td className="px-3 py-2 text-stone-600 dark:text-stone-400">
                  {location.becomes}{" "}
                  <span className="text-stone-400 dark:text-stone-500">
                    ({classificationLabel(location.classification)})
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ListingFastLane() {
  const [state, setState] = useState<LaneState>({ phase: "idle" });
  const [domainInput, setDomainInput] = useState("");

  async function checkDomain(event: React.FormEvent<HTMLFormElement>) {
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

  return (
    <div>
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-400">
        A{" "}
        <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[0.85em] text-stone-700 dark:bg-stone-800 dark:text-stone-200">
          releases.json
        </code>{" "}
        file on your domain tells the registry where your changelog, feed, and product releases
        live.{" "}
        <Link
          href="/docs/listing"
          className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
        >
          Learn how to create one
        </Link>{" "}
        &mdash; by hand, or by handing the prompt to your coding agent.
      </p>

      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Already publish one? Enter your domain to check and activate your listing.
      </p>

      {(state.phase === "idle" ||
        state.phase === "checking" ||
        state.phase === "error" ||
        state.phase === "result" ||
        state.phase === "activating") && (
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
            className="w-full border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2.5 text-sm text-stone-900 dark:text-stone-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
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
        <div className="mt-5 border-t border-stone-200 pt-5 dark:border-stone-800">
          {!state.result.valid ? (
            <div>
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                That manifest has some issues:
              </p>
              <ul className="mt-2 space-y-1.5 text-sm">
                {state.result.errors.map((error, index) => (
                  <li key={`${error.path}-${index}`} className="text-stone-600 dark:text-stone-400">
                    <span className="font-mono text-[0.85em] text-stone-500 dark:text-stone-500">
                      {error.path}
                    </span>{" "}
                    &mdash; {error.message}
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
              <LocationsPreview result={state.result} />

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
                  This domain is already listed.{" "}
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
        <div className="mt-5 border-t border-stone-200 pt-5 dark:border-stone-800">
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
    </div>
  );
}
