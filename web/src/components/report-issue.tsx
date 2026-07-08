"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { buildReportMessage, type ReportContext } from "@/lib/report-issue";

const FIELD =
  "mt-1.5 w-full border border-stone-300 bg-white px-2.5 py-2 text-sm text-stone-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

const TRIGGER =
  "text-[13px] text-stone-400 transition-colors hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300";

function errorMessage(code: string | undefined): string {
  if (code === "rate_limited") return "Too many reports — try again shortly.";
  if (code === "service_unavailable") return "Reporting is paused right now.";
  if (code === "bad_request" || code === "invalid_json") {
    return "Add a short note and try again.";
  }
  return "Couldn't send — try again.";
}

/**
 * Inline popover to report a problem with the entity currently on screen.
 * Reuses open `POST /v1/feedback` (via `/api/feedback`); page context is
 * baked into the message body so operators can jump back to the listing.
 */
export function ReportIssue({
  context,
  className,
}: {
  context: ReportContext;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const contactId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function close() {
    setOpen(false);
    setBusy(false);
    setError(null);
    setDone(false);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Auto-dismiss the success state so the user stays in context.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => {
      close();
      triggerRef.current?.focus();
    }, 1400);
    return () => clearTimeout(t);
  }, [done]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const note = String(data.get("message") ?? "");
    const contact = String(data.get("contact") ?? "").trim() || undefined;
    const message = buildReportMessage(
      note,
      context,
      typeof window !== "undefined" ? window.location.href : null,
    );

    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, contact, type: "bug", surface: "web" }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(errorMessage(json?.error));
        setBusy(false);
        return;
      }
      form.reset();
      setBusy(false);
      setDone(true);
    } catch {
      setError("Network error");
      setBusy(false);
    }
  }

  return (
    <div className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={className ?? TRIGGER}
      >
        Report
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className="absolute right-0 top-full z-50 mt-2 w-[min(100vw-2rem,22rem)] rounded-lg border border-stone-200 bg-white p-4 text-left shadow-lg dark:border-stone-700 dark:bg-stone-950"
        >
          {done ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
              Thanks — we got it.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <div>
                <h2
                  id={titleId}
                  className="text-sm font-semibold tracking-tight text-stone-900 dark:text-stone-100"
                >
                  Report an issue
                </h2>
                <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                  {context.name}
                </p>
              </div>

              <div>
                <label
                  htmlFor={messageId}
                  className="block text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400"
                >
                  What&apos;s wrong?
                </label>
                <textarea
                  id={messageId}
                  name="message"
                  required
                  minLength={5}
                  maxLength={3200}
                  rows={3}
                  autoFocus
                  placeholder="Wrong product, missing release, bad date…"
                  className={`${FIELD} resize-y`}
                />
              </div>

              <div>
                <label
                  htmlFor={contactId}
                  className="block text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400"
                >
                  Contact{" "}
                  <span className="normal-case tracking-normal text-stone-400">(optional)</span>
                </label>
                <input
                  id={contactId}
                  name="contact"
                  type="text"
                  maxLength={200}
                  autoComplete="email"
                  placeholder="email or handle"
                  className={FIELD}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <p
                  className={`min-w-0 text-xs ${error ? "text-red-600 dark:text-red-400" : "text-stone-400 dark:text-stone-500"}`}
                  role={error ? "alert" : "status"}
                >
                  {error ?? "Includes this page link."}
                </p>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-8 shrink-0 items-center justify-center bg-stone-950 px-3 text-xs font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
