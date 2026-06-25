// web/src/lib/invitation-state.ts
/**
 * Pure load-time state for the /accept-invitation page, derived from the session + the
 * better-auth `getInvitation` result. Endpoint contract (better-auth 1.6.20):
 *   - requires a session (the component only fetches once signed in)
 *   - success → invitation flattened with organizationName/organizationId/inviterEmail
 *   - HTTP 403 "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION" on email mismatch (no org data)
 *   - HTTP 400 "Invitation not found!" when missing / non-pending / expired (collapsed)
 * See docs/architecture/workspaces.md and the design spec.
 */
export type GetInvitationData = {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  inviterEmail: string;
  expiresAt: string | Date;
};

export type InvitationFetchError = {
  status?: number;
  code?: string;
  message?: string;
};

export type AcceptState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | {
      kind: "ready";
      organizationId: string;
      organizationName: string;
      invitationId: string;
      inviterEmail: string;
    }
  | { kind: "email-mismatch"; sessionEmail: string }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

const RECIPIENT_MISMATCH_CODE = "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";

export function deriveAcceptState(input: {
  invitationId: string;
  sessionEmail: string | null | undefined;
  invitation: GetInvitationData | null;
  error: InvitationFetchError | null;
}): AcceptState {
  const { sessionEmail, invitation, error, invitationId } = input;
  if (sessionEmail === undefined) return { kind: "loading" };
  if (sessionEmail === null) return { kind: "signed-out" };
  if (invitation) {
    return {
      kind: "ready",
      organizationId: invitation.organizationId,
      organizationName: invitation.organizationName,
      invitationId,
      inviterEmail: invitation.inviterEmail,
    };
  }
  if (error) {
    if (error.code === RECIPIENT_MISMATCH_CODE || error.status === 403) {
      return { kind: "email-mismatch", sessionEmail };
    }
    if (error.status === 400) return { kind: "invalid" };
    return {
      kind: "error",
      message: error.message ?? "Something went wrong loading this invitation.",
    };
  }
  return { kind: "loading" }; // signed in, invitation request still in flight
}
