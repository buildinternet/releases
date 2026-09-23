// web/src/lib/invitation-state.test.ts
import { describe, expect, test } from "bun:test";
import { deriveAcceptState, type GetInvitationData } from "./invitation-state";

const data: GetInvitationData = {
  id: "inv_1",
  email: "invitee@example.com",
  role: "member",
  status: "pending",
  organizationId: "org_1",
  organizationName: "Acme",
  organizationSlug: "acme",
  inviterEmail: "owner@example.com",
  expiresAt: "2999-01-01T00:00:00.000Z",
};
const base = { invitationId: "inv_1", invitation: null, error: null };

describe("deriveAcceptState", () => {
  test("loading while session is undefined", () => {
    expect(deriveAcceptState({ ...base, sessionEmail: undefined }).kind).toBe("loading");
  });
  test("signed-out when session is null", () => {
    expect(deriveAcceptState({ ...base, sessionEmail: null }).kind).toBe("signed-out");
  });
  test("loading when signed in but fetch still in flight", () => {
    expect(deriveAcceptState({ ...base, sessionEmail: "a@b.com" }).kind).toBe("loading");
  });
  test("ready carries workspace details when invitation loads", () => {
    const s = deriveAcceptState({ ...base, sessionEmail: "invitee@example.com", invitation: data });
    expect(s).toEqual({
      kind: "ready",
      workspaceId: "org_1",
      workspaceName: "Acme",
      invitationId: "inv_1",
      inviterEmail: "owner@example.com",
    });
  });
  test("email-mismatch on recipient code", () => {
    const s = deriveAcceptState({
      ...base,
      sessionEmail: "other@example.com",
      error: { code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION", status: 403 },
    });
    expect(s).toEqual({ kind: "email-mismatch", sessionEmail: "other@example.com" });
  });
  test("email-mismatch on bare 403", () => {
    expect(
      deriveAcceptState({ ...base, sessionEmail: "x@y.com", error: { status: 403 } }).kind,
    ).toBe("email-mismatch");
  });
  test("invalid on 400 (missing / canceled / accepted / expired collapse here)", () => {
    expect(
      deriveAcceptState({
        ...base,
        sessionEmail: "x@y.com",
        error: { status: 400, message: "Invitation not found!" },
      }).kind,
    ).toBe("invalid");
  });
  test("error surfaces the server message otherwise", () => {
    const s = deriveAcceptState({
      ...base,
      sessionEmail: "x@y.com",
      error: { status: 500, message: "boom" },
    });
    expect(s).toEqual({ kind: "error", message: "boom" });
  });
  test("error falls back to a default message when none given", () => {
    const s = deriveAcceptState({ ...base, sessionEmail: "x@y.com", error: { status: 500 } });
    expect(s.kind).toBe("error");
  });
});
