import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createTestDb } from "./setup";
import { oauthClient } from "../src/db/schema-auth.js";
import { createAuth } from "../src/auth/index.js";

/**
 * Regression coverage for the double-JSON-encoding defect on the Better Auth
 * OAuth tables (#2257 follow-up).
 *
 * The Better Auth adapter factory serializes `json` / `string[]` fields itself
 * for any backend reporting `supportsJSON: false` / `supportsArrays: false` —
 * which the drizzle adapter does for SQLite/D1. Our schema then declared the
 * same columns `text(..., { mode: "json" })`, which stringified a second time,
 * so every prod row landed as a JSON *string* containing JSON.
 */

const baseEnv = {
  BETTER_AUTH_SECRET: "test-secret-value-at-least-32-characters-long",
  BETTER_AUTH_URL: "https://api.releases.localhost",
  WEB_BASE_URL: "https://releases.localhost",
} as never;

const MIGRATION = "workers/api/migrations/20260901000000_oauth_json_double_encoded.sql";

/** Strip comments and split the migration into executable statements. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("oauth_client JSON encoding", () => {
  // Writer pin: a freshly DCR-registered client must land SINGLE-encoded. If
  // `mode: "json"` (or any other second serialization) comes back, json_type
  // flips to 'text' and this fails.
  it("DCR registration writes single-encoded JSON arrays", async () => {
    const db = createTestDb();
    const auth = await createAuth(baseEnv, undefined, { db, sendEmail: () => {} });
    const res = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "MCP Inspector",
          redirect_uris: ["https://app.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(res.ok).toBe(true);

    const [raw] = await db.all<{ st: string; rt: string }>(
      sql`SELECT json_type(scopes) AS st, json_type(redirect_uris) AS rt FROM oauth_client`,
    );
    expect(raw?.st).toBe("array");
    expect(raw?.rt).toBe("array");

    // And the direct drizzle read (the shape `registeredScopesForClientId`
    // relies on) is a real array, not a string.
    const [row] = await db.select().from(oauthClient);
    expect(Array.isArray(row?.scopes)).toBe(true);
    expect(row?.scopes).toContain("offline_access");
    expect(row?.redirectUris).toEqual(["https://app.example.com/callback"]);
  });

  // Read-path tolerance: a legacy double-encoded row (every prod row before the
  // migration) still reads back as an array, so deploy order does not matter.
  it("reads a legacy double-encoded row back as an array", async () => {
    const db = createTestDb();
    await db.run(sql`
      INSERT INTO oauth_client (id, client_id, redirect_uris, scopes, created_at, updated_at)
      VALUES ('oc_legacy', 'legacy-client',
              json_quote('["https://legacy.example.com/cb"]'),
              json_quote('["read","write"]'),
              0, 0)
    `);
    const [rawBefore] = await db.all<{ st: string }>(
      sql`SELECT json_type(scopes) AS st FROM oauth_client WHERE client_id = 'legacy-client'`,
    );
    expect(rawBefore?.st).toBe("text");

    const [row] = await db.select().from(oauthClient);
    expect(row?.scopes).toEqual(["read", "write"]);
    expect(row?.redirectUris).toEqual(["https://legacy.example.com/cb"]);
  });

  it("migration normalizes double-encoded rows and appends offline_access", async () => {
    const db = createTestDb();
    await db.run(sql`
      INSERT INTO oauth_client (id, client_id, redirect_uris, scopes, grant_types, created_at, updated_at)
      VALUES ('oc_legacy', 'legacy-client',
              json_quote('["https://legacy.example.com/cb"]'),
              json_quote('["read","write"]'),
              json_quote('["authorization_code"]'),
              0, 0)
    `);
    // A healthy row must be left exactly as-is.
    await db.run(sql`
      INSERT INTO oauth_client (id, client_id, redirect_uris, scopes, created_at, updated_at)
      VALUES ('oc_ok', 'healthy-client', '["https://ok.example.com/cb"]',
              '["read","offline_access"]', 0, 0)
    `);

    for (const statement of migrationStatements()) {
      // oxlint-disable-next-line no-await-in-loop -- migration statements are ordered
      await db.run(sql.raw(statement));
    }

    const rows = await db.all<{ client_id: string; st: string; rt: string; scopes: string }>(
      sql`SELECT client_id, json_type(scopes) AS st, json_type(redirect_uris) AS rt, scopes FROM oauth_client ORDER BY client_id`,
    );
    for (const row of rows) {
      expect(row.st).toBe("array");
      expect(row.rt).toBe("array");
      expect(JSON.parse(row.scopes)).toContain("offline_access");
    }
    // offline_access is appended exactly once — the healthy row already had it.
    const healthy = rows.find((r) => r.client_id === "healthy-client");
    expect(JSON.parse(healthy?.scopes ?? "[]")).toEqual(["read", "offline_access"]);

    // Idempotent: a second run changes nothing.
    for (const statement of migrationStatements()) {
      // oxlint-disable-next-line no-await-in-loop -- migration statements are ordered
      await db.run(sql.raw(statement));
    }
    const after = await db.all<{ scopes: string }>(
      sql`SELECT scopes FROM oauth_client ORDER BY client_id`,
    );
    expect(after.map((r) => r.scopes)).toEqual(rows.map((r) => r.scopes));
  });

  // The consequence the defect had in prod: with a string where an array was
  // declared, the authorize scope rewrite emitted an empty `scope=`.
  it("authorize keeps a non-empty scope for a registered client", async () => {
    const db = createTestDb();
    const auth = await createAuth(baseEnv, undefined, { db, sendEmail: () => {} });
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const regRes = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      // Kitchen-sink scope, as generic MCP clients send: downscoped to the
      // client's registered list, which must not come out empty.
      scope: "read write openid profile email offline_access mcp:tools",
      state: "xyz",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const res = await auth.handler(
      new Request(`https://api.releases.localhost/api/auth/oauth2/authorize?${params}`, {
        redirect: "manual",
      }),
    );
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("error=");
    // Unauthenticated → login redirect carrying the (rewritten) authorize query.
    const scopes = [...location.matchAll(/scope(?:=|%3D)([^&]*)/g)].map((m) =>
      decodeURIComponent(decodeURIComponent(m[1] ?? "")),
    );
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(scope.trim()).not.toBe("");
  });
});
