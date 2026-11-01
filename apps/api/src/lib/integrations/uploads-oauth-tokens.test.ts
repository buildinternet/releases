import { describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../../../../../tests/db-helper.js";
import { workspaceIntegrations } from "../../db/schema-integrations.js";
import { persistUploadsTokenGrant } from "./uploads-oauth-tokens.js";

const ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

const tokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  tokenType: "Bearer",
  scope: "files:read",
  expiresAt: Date.now() + 3600_000,
};

async function seedPending() {
  const tdb = createTestDb();
  await tdb.db.run(
    sql`INSERT INTO organization (id, name, slug, created_at) VALUES ('ws_1', 'Workspace', 'ws-1', ${Date.now()})`,
  );
  await tdb.db.insert(workspaceIntegrations).values({
    id: "wsi_1",
    workspaceId: "ws_1",
    provider: "uploads",
    status: "pending",
    oauthState: "state-a",
    codeVerifierEnc: "verifier",
    redirectUri: "https://releases.sh/integrations/uploads/callback",
    pendingExpiresAt: Date.now() + 60_000,
    accessTokenEnc: "keep-me",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return tdb;
}

describe("uploads connect transition", () => {
  it("stores the grant only while the oauth state is still the one the callback read", async () => {
    const tdb = await seedPending();
    const db = tdb.db as never;

    const missed = await persistUploadsTokenGrant(db, {
      rowId: "wsi_1",
      workspaceId: "ws_1",
      tokens,
      encryptionKey: ENCRYPTION_KEY,
      mode: "connect",
      expectedOAuthState: "state-b",
    });
    expect(missed.persisted).toBe(false);

    const [untouched] = await tdb.db
      .select()
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.id, "wsi_1"));
    expect(untouched?.status).toBe("pending");
    expect(untouched?.oauthState).toBe("state-a");
    expect(untouched?.accessTokenEnc).toBe("keep-me");

    const stored = await persistUploadsTokenGrant(db, {
      rowId: "wsi_1",
      workspaceId: "ws_1",
      tokens,
      encryptionKey: ENCRYPTION_KEY,
      mode: "connect",
      expectedOAuthState: "state-a",
    });
    expect(stored.persisted).toBe(true);

    const [connected] = await tdb.db
      .select()
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.id, "wsi_1"));
    expect(connected?.status).toBe("connected");
    expect(connected?.oauthState).toBeNull();
    expect(connected?.accessTokenEnc).not.toBe("keep-me");
    expect(connected?.accessTokenEnc).toBeTruthy();
    tdb.cleanup();
  });

  it("does not let a refresh overwrite a grant that replaced its refresh token", async () => {
    const tdb = await seedPending();
    const missed = await persistUploadsTokenGrant(tdb.db as never, {
      rowId: "wsi_1",
      workspaceId: "ws_1",
      tokens,
      encryptionKey: ENCRYPTION_KEY,
      mode: "refresh",
      expectedRefreshTokenEnc: "someone-elses-ciphertext",
    });
    expect(missed.persisted).toBe(false);
    const [row] = await tdb.db
      .select({ accessTokenEnc: workspaceIntegrations.accessTokenEnc })
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.id, "wsi_1"));
    expect(row?.accessTokenEnc).toBe("keep-me");
    tdb.cleanup();
  });
});
