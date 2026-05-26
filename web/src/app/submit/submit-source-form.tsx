"use client";

import { useState } from "react";

type SubmitState =
  | { status: "idle"; message: null }
  | { status: "submitting"; message: null }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

function errorMessage(error: string | undefined): string {
  switch (error) {
    case "url_required":
      return "Enter a valid release notes URL.";
    case "invalid_email":
      return "Enter a valid email address, or leave it blank.";
    case "rate_limited":
      return "Too many submissions. Please try again in a minute.";
    case "api_timeout":
      return "The submission timed out. Please try again.";
    case "api_unavailable":
      return "The API is unavailable right now. Please try again.";
    default:
      return "Something went sideways. Please try again.";
  }
}

function caughtErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Network error";
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
          note: data.get("note"),
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
    } catch (err) {
      setState({ status: "error", message: errorMessage(caughtErrorMessage(err)) });
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
          Release notes URL <span className="text-blue-500">*</span>
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          placeholder="https://example.com/releases"
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

      <div>
        <label
          htmlFor="note"
          className="block text-[11px] font-medium uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400"
        >
          Additional information{" "}
          <span className="text-stone-400 normal-case tracking-normal">(optional)</span>
        </label>
        <textarea
          id="note"
          name="note"
          rows={5}
          placeholder="Product name, GitHub repo, feed quirks, or anything useful."
          className="mt-2 w-full resize-y border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2.5 text-sm text-stone-900 dark:text-stone-100 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
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
          {state.message ?? "Index pages, changelogs, GitHub releases, and feed URLs are ideal."}
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
