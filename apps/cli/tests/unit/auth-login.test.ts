import { describe, it, expect } from "bun:test";
import { verifyToken, resolveTokenInput, runLogoutFlow } from "../../src/cli/commands/auth.js";
import type { StoredCredential } from "../../src/lib/credentials.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const unusedReader = async () => "should-not-be-used";
const promptReader = async () => "  relk_from_prompt ";
const nullReader = async () => null;

describe("verifyToken", () => {
  it("returns the identity on 200", async () => {
    const fetchFn = (async () =>
      jsonResponse({ kind: "token", name: "laptop", scopes: ["read", "write"] })) as typeof fetch;
    const id = await verifyToken("relk_x_y", "https://api.releases.sh", fetchFn);
    expect(id.name).toBe("laptop");
    expect(id.scopes).toEqual(["read", "write"]);
  });

  it("throws on 401", async () => {
    const fetchFn = (async () => jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
    await expect(verifyToken("relk_bad", "https://api.releases.sh", fetchFn)).rejects.toThrow(
      /rejected/i,
    );
  });

  it("throws on 500", async () => {
    const fetchFn = (async () => jsonResponse({}, 500)) as typeof fetch;
    await expect(verifyToken("relk_x_y", "https://api.releases.sh", fetchFn)).rejects.toThrow(
      /500/,
    );
  });
});

describe("resolveTokenInput", () => {
  it("returns a provided --token value (trimmed)", async () => {
    expect(await resolveTokenInput("  relk_a_b  ", unusedReader)).toBe("relk_a_b");
  });

  it("uses the reader when no --token and a value comes back", async () => {
    expect(await resolveTokenInput(undefined, promptReader)).toBe("relk_from_prompt");
  });

  it("throws when no --token and not a TTY (reader returns null)", async () => {
    await expect(resolveTokenInput(undefined, nullReader)).rejects.toThrow(/No token/i);
  });
});

describe("runLogoutFlow", () => {
  const cred: StoredCredential = {
    token: "relu_abc",
    apiUrl: "https://test.example.com",
    savedAt: "2026-01-01T00:00:00.000Z",
  };

  it("revokes the stored relu_ key via DELETE /v1/tokens/me, then deletes the local file", async () => {
    const order: string[] = [];
    let seenApiUrl: string | null = null;
    let seenKey: string | null = null;
    const { removed } = await runLogoutFlow({
      readCredential: () => cred,
      clearCredential: () => {
        order.push("clear");
        return true;
      },
      retireStoredSession: async () => {
        order.push("retire");
      },
      revokePresentedKey: async (apiUrl, key) => {
        order.push("revoke");
        seenApiUrl = apiUrl;
        seenKey = key;
        return { ok: true, alreadyRevoked: false };
      },
    });
    expect(removed).toBe(true);
    expect(order).toEqual(["retire", "revoke", "clear"]);
    expect(seenApiUrl).toBe("https://test.example.com");
    expect(seenKey).toBe("relu_abc");
  });

  it("still deletes the local file even when the server-side revoke fails", async () => {
    let cleared = false;
    const printed: string[] = [];
    const { removed } = await runLogoutFlow({
      readCredential: () => cred,
      clearCredential: () => {
        cleared = true;
        return true;
      },
      retireStoredSession: async () => {},
      revokePresentedKey: async () => ({ ok: false, error: "HTTP 500" }),
      print: (l) => printed.push(l),
    });
    expect(cleared).toBe(true);
    expect(removed).toBe(true);
    expect(printed.some((l) => l.includes("Could not revoke"))).toBe(true);
  });

  it("skips the server-side revoke for a non-relu_ credential (e.g. a manually-pasted token)", async () => {
    let revoked = false;
    await runLogoutFlow({
      readCredential: () => ({ ...cred, token: "relk_something" }),
      clearCredential: () => true,
      retireStoredSession: async () => {},
      revokePresentedKey: async () => {
        revoked = true;
        return { ok: true, alreadyRevoked: false };
      },
    });
    expect(revoked).toBe(false);
  });

  it("notes (but does not fail on) a 401 already-revoked key", async () => {
    const printed: string[] = [];
    const { removed } = await runLogoutFlow({
      readCredential: () => cred,
      clearCredential: () => true,
      retireStoredSession: async () => {},
      revokePresentedKey: async () => ({ ok: true, alreadyRevoked: true }),
      print: (l) => printed.push(l),
    });
    expect(removed).toBe(true);
    expect(printed.some((l) => l.includes("already revoked"))).toBe(true);
  });

  it("reports removed:false and skips revocation when there is nothing stored", async () => {
    const { removed } = await runLogoutFlow({
      readCredential: () => null,
      clearCredential: () => false,
      retireStoredSession: async () => {},
      revokePresentedKey: async () => {
        throw new Error("should not be called");
      },
    });
    expect(removed).toBe(false);
  });
});
