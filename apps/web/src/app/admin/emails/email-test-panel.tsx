"use client";

import { useMemo, useState } from "react";
import { inputClass } from "@releases/design-system";

type EmailSample = {
  id: string;
  label: string;
  description: string;
  channel: "auth" | "operator";
};

type SendState =
  | { status: "idle" }
  | { status: "sending"; id: string }
  | { status: "ok"; id: string; message: string }
  | { status: "error"; id: string; message: string };

export function EmailTestPanel({
  samples,
  defaultEmail,
}: {
  samples: EmailSample[];
  defaultEmail: string;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [state, setState] = useState<SendState>({ status: "idle" });

  const [collectionSlug, setCollectionSlug] = useState("");
  const [weekStart, setWeekStart] = useState("");
  const [collectionState, setCollectionState] = useState<
    { status: "idle" | "sending" } | { status: "ok" | "error"; message: string }
  >({ status: "idle" });

  const grouped = useMemo(() => {
    const auth = samples.filter((s) => s.channel === "auth");
    const operator = samples.filter((s) => s.channel === "operator");
    return { auth, operator };
  }, [samples]);

  async function sendSample(id: string) {
    const to = email.trim();
    if (!to) {
      setState({ status: "error", id, message: "Enter a recipient email first." });
      return;
    }
    setState({ status: "sending", id });
    try {
      const res = await fetch("/api/proxy/admin/emails/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: id, to }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        reason?: string;
        message?: string;
      } | null;
      if (res.ok && body?.ok) {
        setState({ status: "ok", id, message: `Sent to ${to}.` });
        return;
      }
      const reason = body?.reason ?? body?.message ?? `Request failed (${res.status}).`;
      setState({ status: "error", id, message: reason });
    } catch {
      setState({ status: "error", id, message: "Network error — try again." });
    }
  }

  async function sendCollectionDigest() {
    const to = email.trim();
    const slug = collectionSlug.trim();
    if (!to || !slug) {
      setCollectionState({
        status: "error",
        message: "Enter a recipient email and collection slug.",
      });
      return;
    }
    setCollectionState({ status: "sending" });
    try {
      const res = await fetch("/api/proxy/admin/digest/collection-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionSlug: slug,
          email: to,
          ...(weekStart.trim() ? { weekStart: weekStart.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        sent?: boolean;
        weekStart?: string;
        releaseCount?: number;
        reason?: string;
        error?: { message?: string };
      } | null;
      if (res.ok && body?.sent) {
        setCollectionState({
          status: "ok",
          message: `Sent the ${body.weekStart} digest (${body.releaseCount} releases) to ${to}.`,
        });
        return;
      }
      setCollectionState({
        status: "error",
        message: body?.error?.message ?? body?.reason ?? `Request failed (${res.status}).`,
      });
    } catch {
      setCollectionState({ status: "error", message: "Network error — try again." });
    }
  }

  function renderGroup(title: string, blurb: string, items: EmailSample[]) {
    return (
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">{title}</h2>
          <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">{blurb}</p>
        </div>
        <ul className="divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {items.map((sample) => {
            const busy = state.status === "sending" && state.id === sample.id;
            const feedback =
              (state.status === "ok" || state.status === "error") && state.id === sample.id
                ? state.message
                : null;
            return (
              <li
                key={sample.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                    {sample.label}
                  </p>
                  <p className="text-[13px] text-stone-500 dark:text-stone-400">
                    {sample.description}
                  </p>
                  {feedback ? (
                    <p
                      className={`mt-1 text-[13px] ${state.status === "ok" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
                    >
                      {feedback}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendSample(sample.id)}
                  className="shrink-0 border border-stone-300 px-3 py-1.5 text-sm text-stone-800 transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
                >
                  {busy ? "Sending…" : "Send test"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <label
          htmlFor="email-test-recipient"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500"
        >
          Send samples to
        </label>
        <input
          id="email-test-recipient"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={`${inputClass} max-w-md`}
        />
        <p className="mt-2 text-[13px] text-stone-500 dark:text-stone-400">
          Subjects are prefixed with{" "}
          <code className="text-stone-700 dark:text-stone-300">[test]</code>. Auth and digest
          samples use the user-facing sender; operator samples use the internal notifications
          address.
        </p>
      </div>

      {renderGroup(
        "User-facing",
        "Delivered via AUTH_EMAIL (noreply@ or digests@). Links are fabricated and will not work.",
        grouped.auth,
      )}
      {renderGroup(
        "Operator / internal",
        "Delivered via SEND_EMAIL (notifications@). Same templates as production alerts.",
        grouped.operator,
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Live collection digest
          </h2>
          <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">
            Sends a real collection weekly digest to the address above. The week defaults to the
            collection&apos;s latest. Subscriptions and send history are not touched.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            value={collectionSlug}
            onChange={(e) => setCollectionSlug(e.target.value)}
            placeholder="collection-slug"
            aria-label="Collection slug"
            className={`${inputClass} max-w-xs`}
          />
          <input
            type="text"
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value)}
            placeholder="Week start (YYYY-MM-DD, optional)"
            aria-label="Week start"
            className={`${inputClass} max-w-xs`}
          />
          <button
            type="button"
            disabled={collectionState.status === "sending"}
            onClick={() => void sendCollectionDigest()}
            className="shrink-0 border border-stone-300 px-3 py-1.5 text-sm text-stone-800 transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
          >
            {collectionState.status === "sending" ? "Sending…" : "Send test"}
          </button>
        </div>
        {collectionState.status === "ok" || collectionState.status === "error" ? (
          <p
            className={`text-[13px] ${collectionState.status === "ok" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
          >
            {collectionState.message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
