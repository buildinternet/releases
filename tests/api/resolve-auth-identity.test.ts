import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

type AuthIdentity =
  | { kind: "root"; scopes: string[] }
  | { kind: "token"; tokenId: string; scopes: string[] }
  | null;

const { resolveAuthIdentity } =
  (await import("../../workers/api/src/middleware/auth.js")) as unknown as {
    resolveAuthIdentity: (c: unknown) => Promise<AuthIdentity>;
  };

function mockSecret(value: string) {
  return { get: () => Promise.resolve(value) };
}

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

async function seedToken(db: TestDatabase["db"], scopes: string[]) {
  const { token, lookupId, secret } = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "t",
      scopes: JSON.stringify(scopes),
    })
    .run();
  return { token, tokenId: `tok_${lookupId}` };
}

/** Run resolveAuthIdentity through a one-route app and return its result. */
function probe(db?: TestDatabase["db"], extraEnv: Record<string, unknown> = {}) {
  const app = new Hono();
  app.get("/p", async (c) => c.json({ id: await resolveAuthIdentity(c) }));
  return async (token?: string) => {
    const res = await app.request(
      "/p",
      token ? { headers: { Authorization: `Bearer ${token}` } } : {},
      { DB: db, RELEASES_API_KEY: mockSecret("root-secret"), ...extraEnv },
    );
    return (await res.json()) as { id: AuthIdentity };
  };
}

describe("resolveAuthIdentity", () => {
  it("returns the root identity for the static key", async () => {
    const { id } = await probe()("root-secret");
    expect(id).toEqual({ kind: "root", scopes: ["*"] });
  });

  it("returns a token identity (tokenId + scopes) for a valid relk_ token", async () => {
    h = createTestDb();
    const { token, tokenId } = await seedToken(h.db, ["read", "write"]);
    const { id } = await probe(h.db)(token);
    expect(id).toEqual({ kind: "token", tokenId, scopes: ["read", "write"] });
  });

  it("returns null for an anonymous request", async () => {
    const { id } = await probe()();
    expect(id).toBeNull();
  });

  it("returns null for an invalid token", async () => {
    const { id } = await probe()("wrong-secret");
    expect(id).toBeNull();
  });

  it("returns null for a relk_ token when API_TOKENS_DISABLED", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, ["read"]);
    const { id } = await probe(h.db, { API_TOKENS_DISABLED: "true" })(token);
    expect(id).toBeNull();
  });
});
