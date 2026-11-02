const SILENT_AUTOFILL = new Set([
  "AUTH_CANCELLED",
  "ERROR_CEREMONY_ABORTED",
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
]);

/**
 * Copy for a passkey sign-in that returned `{ error }` instead of throwing.
 * Conditional-UI dismissal resolves with a cancellation code and must stay
 * quiet — the user never chose the prompt. The explicit button surfaces the
 * same cancellation, because they did.
 */
export function passkeySignInMessage(
  error: { code?: string | null; message?: string | null } | null | undefined,
  mode: "button" | "autofill",
): string | null {
  if (!error) return null;
  if (mode === "autofill" && error.code && SILENT_AUTOFILL.has(error.code)) return null;
  const message = error.message?.trim();
  return message || "Could not sign in with a passkey. Please try again.";
}
