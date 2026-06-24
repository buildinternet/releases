import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import type { AuthEmailMessage } from "../src/auth/email.js";
import { authMember, authOrganization } from "../src/db/schema-auth.js";

const env = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;
const PASSWORD = "correct-horse-battery";

function setup() {
  const db = createTestDb();
  const emails: AuthEmailMessage[] = [];
  return {
    db,
    emails,
    auth: createAuth(env, undefined, {
      db,
      sendEmail: (m: AuthEmailMessage) => {
        emails.push(m);
      },
    }),
  };
}

describe("personal workspace provisioning through createAuth", () => {
  it("creates a personal workspace + owner membership when a user signs in", async () => {
    const { db, emails, auth } = setup();
    const a = await auth;
    const signUp = await a.api.signUpEmail({
      body: { email: "ann@example.com", password: PASSWORD, name: "Ann Smith" },
    });
    const userId = signUp.user.id;
    const token = /token=([^&\s]+)/.exec(emails[0]?.text ?? "")?.[1];
    expect(token).toBeTruthy();
    await a.api.verifyEmail({ query: { token: token as string } }); // auto sign-in → session.create

    const members = await db.select().from(authMember).where(eq(authMember.userId, userId));
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("owner");
    const orgs = await db
      .select()
      .from(authOrganization)
      .where(eq(authOrganization.id, members[0]!.organizationId));
    expect(orgs[0]?.name).toBe("Ann's Workspace");
  });
});
