import { describe, it, expect } from "bun:test";
import {
  IDENTITY_SCOPES as API_IDENTITY_SCOPES,
  ROLE_LADDER as API_ROLE_LADDER,
  entitledScopes as apiEntitledScopes,
} from "../../workers/api/src/auth/entitlement.js";
import {
  IDENTITY_SCOPES as WEB_IDENTITY_SCOPES,
  ROLE_LADDER as WEB_ROLE_LADDER,
  entitledScopes as webEntitledScopes,
} from "../../web/src/lib/entitlement";

// Drift gate (#1481). The OAuth scope entitlement map lives in two copies that
// must stay in sync: the authoritative worker boundary
// (workers/api/src/auth/entitlement.ts) and a display-only mirror the Next.js
// consent page uses (web/src/lib/entitlement.ts). The web app is a separate
// build and cannot import the worker module, so the constants + fail-closed
// logic are duplicated. Nothing else stops them silently diverging — drift
// can't escalate privilege (the worker copy gates every token) but it makes the
// consent UI offer scopes the AS refuses, or hide ones it allows. This asserts
// the two copies agree on their shared surface; it is GREEN while in sync and
// RED the moment either copy changes IDENTITY_SCOPES, ROLE_LADDER, or the
// entitledScopes logic. Mirrors the well-known (#1441) and workflow-inline
// (#1458) drift gates.
describe("OAuth entitlement drift gate (worker ↔ web)", () => {
  it("IDENTITY_SCOPES are identical", () => {
    expect([...WEB_IDENTITY_SCOPES]).toEqual([...API_IDENTITY_SCOPES]);
  });

  it("ROLE_LADDER is identical", () => {
    expect(WEB_ROLE_LADDER).toEqual(API_ROLE_LADDER);
  });

  // Behavioral equivalence: the duplicated entitledScopes bodies must agree
  // across the full input matrix the consent flow can throw at them — known
  // roles, null/undefined/unknown (fail-closed), multi-role unions, and the
  // whitespace/comma-only edge cases the second fail-closed branch guards.
  it("entitledScopes agrees across every role shape", () => {
    const roles: Array<string | null | undefined> = [
      "user",
      "curator",
      "admin",
      "operator",
      null,
      undefined,
      "",
      " ",
      ",",
      "wizard",
      "user,curator",
      "user,wizard",
      "admin,curator,user",
      " curator , admin ",
    ];
    for (const role of roles) {
      expect(
        webEntitledScopes(role),
        `entitledScopes drifted for role ${JSON.stringify(role)}`,
      ).toEqual(apiEntitledScopes(role));
    }
  });
});
