"use client";

import { useState } from "react";
import { sendVerificationEmail } from "@/lib/auth-client";

/**
 * Quiet nudge for a signed-in user whose email isn't verified (digest sends skip
 * unverified addresses), with a one-click resend. The callback is an absolute
 * URL on this web origin, same as the sign-in form's verification resend.
 */
export function VerifyEmailHint({
  email,
  message = "Verify your email to start getting this digest.",
  className = "",
}: {
  email: string;
  message?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function resend() {
    if (state === "sending") return;
    setState("sending");
    try {
      const result = await sendVerificationEmail({
        email,
        callbackURL: window.location.href,
      });
      setState(result.error ? "error" : "sent");
    } catch {
      setState("error");
    }
  }

  return (
    <span className={`text-[12px] text-[var(--fg-3)] ${className}`}>
      {message}{" "}
      {state === "sent" ? (
        "Sent. Check your inbox."
      ) : (
        <>
          <button
            type="button"
            disabled={state === "sending"}
            onClick={() => void resend()}
            className="underline underline-offset-2 hover:text-[var(--fg-2)] disabled:opacity-60"
          >
            Resend link
          </button>
          {state === "error" && <span role="alert"> Couldn&apos;t send. Try again.</span>}
        </>
      )}
    </span>
  );
}
