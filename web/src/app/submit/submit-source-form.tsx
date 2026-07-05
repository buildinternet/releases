"use client";

import Link from "next/link";
import { useState } from "react";

type SubmitState =
  | { status: "idle"; message: null }
  | { status: "submitting"; message: null }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

// Keys are the flat codes the /api/recommendations proxy emits: the worker's
// standardized error codes (bad_request / payload_too_large / rate_limited /
// service_unavailable / invalid_json), flattened from the nested envelope by the
// proxy, plus the proxy's own transport codes (api_timeout / api_unavailable /
// upstream_error).
function errorMessage(error: string | undefined): string {
  switch (error) {
    case "bad_request":
    case "invalid_json":
      return "Check the URL (and email, if given) and try again.";
    case "payload_too_large":
      return "That submission is too large. Please shorten it and try again.";
    case "rate_limited":
      return "Too many submissions. Please try again in a minute.";
    case "service_unavailable":
      return "Submissions are paused right now. Please try again later.";
    case "api_timeout":
      return "The submission timed out. Please try again.";
    case "api_unavailable":
      return "The API is unavailable right now. Please try again.";
    default:
      return "Something went sideways. Please try again.";
  }
}

export function SubmitSourceForm() {
  const [state, setState] = useState<SubmitState>({ status: "idle", message: null });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setState({ status: "submitting", message: null });

    try {
      const res = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: data.get("url"),
          contactEmail: data.get("contactEmail"),
          type: "source",
          surface: "web",
        }),
      });

      const json = (await res.json().catch(() => null)) as { error?: string; id?: string } | null;
      if (!res.ok) {
        setState({ status: "error", message: errorMessage(json?.error) });
        return;
      }

      form.reset();
      setState({
        status: "success",
        message: "Thanks. The URL is in the review queue.",
      });
    } catch {
      setState({ status: "error", message: "Network error" });
    }
  }

  const submitting = state.status === "submitting";

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate={false}>
      <div>
        <label
          htmlFor="url"
          className="block text-[11px] font-medium uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400"
        >
          Product or releases.json URL <span className="text-blue-500">*</span>
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          placeholder="https://example.com/.well-known/releases.json"
          className="mt-2 w-full border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2.5 text-sm text-stone-900 dark:text-stone-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
      </div>

      <div>
        <label
          htmlFor="contactEmail"
          className="block text-[11px] font-medium uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400"
        >
          Email to notify{" "}
          <span className="text-stone-400 normal-case tracking-normal">(optional)</span>
        </label>
        <input
          id="contactEmail"
          name="contactEmail"
          type="email"
          placeholder="you@example.com"
          className="mt-2 w-full border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2.5 text-sm text-stone-900 dark:text-stone-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          className={`text-sm ${
            state.status === "success"
              ? "text-emerald-600 dark:text-emerald-400"
              : state.status === "error"
                ? "text-red-600 dark:text-red-400"
                : "text-stone-500 dark:text-stone-400"
          }`}
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message ?? (
            <>
              Prefer{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[0.85em] text-stone-700 dark:bg-stone-800 dark:text-stone-200">
                releases.json
              </code>{" "}
              on your domain?{" "}
              <Link
                href="/docs/listing"
                className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
              >
                How to get listed
              </Link>
            </>
          )}
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-10 shrink-0 items-center justify-center bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
        >
          {submitting ? "Submitting..." : "Submit URL"}
        </button>
      </div>
    </form>
  );
}
