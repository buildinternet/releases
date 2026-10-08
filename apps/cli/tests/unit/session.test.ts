import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rel-sess-"));
process.env.RELEASED_DATA_DIR = dir;

const { readCredential, writeCredential, clearCredential } =
  await import("../../src/lib/credentials.js");
const { withSession, retireStoredSession } = await import("../../src/lib/session.js");

afterEach(() => clearCredential());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("withSession", () => {
  it("runs the device flow for the given purpose, then calls fn with the session token", async () => {
    let seenPurpose: string | null = null;
    const result = await withSession(
      "https://test.example.com",
      "keys",
      async (sessionToken) => {
        expect(sessionToken).toBe("sess_tok");
        return "ok";
      },
      {
        deviceAuth: async (_apiUrl, purpose) => {
          seenPurpose = purpose;
          return "sess_tok";
        },
        signOut: async () => null,
      },
    );
    expect(result).toBe("ok");
    expect(seenPurpose).toBe("keys");
  });

  it("signs the session out after fn resolves", async () => {
    const order: string[] = [];
    await withSession(
      "https://test.example.com",
      "publish-tokens",
      async () => {
        order.push("fn");
      },
      {
        deviceAuth: async () => "sess_tok",
        signOut: async () => {
          order.push("signout");
          return null;
        },
      },
    );
    expect(order).toEqual(["fn", "signout"]);
  });

  it("signs the session out even when fn throws (finally always runs)", async () => {
    let signedOut = false;
    await expect(
      withSession(
        "https://test.example.com",
        "keys",
        async () => {
          throw new Error("boom");
        },
        {
          deviceAuth: async () => "sess_tok",
          signOut: async () => {
            signedOut = true;
            return null;
          },
        },
      ),
    ).rejects.toThrow(/boom/);
    expect(signedOut).toBe(true);
  });

  it("prints a note (not a throw) when sign-out itself fails", async () => {
    const printed: string[] = [];
    const result = await withSession("https://test.example.com", "keys", async () => "ok", {
      deviceAuth: async () => "sess_tok",
      signOut: async () => "network down",
      print: (l) => printed.push(l),
    });
    expect(result).toBe("ok");
    expect(printed.some((l) => l.includes("Could not sign out"))).toBe(true);
  });

  it("defaults to printing sign-out failures to stderr, never stdout", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await withSession("https://test.example.com", "keys", async () => "ok", {
        deviceAuth: async () => "sess_tok",
        signOut: async () => "network down",
        // no `print` override: exercise the real default
      });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }

    expect(stdoutChunks.join("")).toBe("");
    expect(stderrChunks.join("")).toContain("Could not sign out");
  });

  it("retires a legacy stored session before running (best-effort, quiet on success)", async () => {
    writeCredential({
      token: "relu_x",
      sessionToken: "legacy_sess",
      apiUrl: "https://test.example.com",
      savedAt: "2026-06-06T00:00:00.000Z",
    });
    let retiredSignOutCalled = false;
    await withSession("https://test.example.com", "keys", async () => "ok", {
      deviceAuth: async () => "sess_new",
      signOut: async (_apiUrl, sessionToken) => {
        if (sessionToken === "legacy_sess") retiredSignOutCalled = true;
        return null;
      },
    });
    expect(retiredSignOutCalled).toBe(true);
    expect(readCredential()?.sessionToken).toBeUndefined();
    expect(readCredential()?.token).toBe("relu_x");
  });
});

describe("retireStoredSession", () => {
  it("does nothing when there is no stored session token", async () => {
    writeCredential({
      token: "relu_x",
      apiUrl: "https://test.example.com",
      savedAt: "2026-06-06T00:00:00.000Z",
    });
    let called = false;
    await retireStoredSession({ signOut: async () => (called = true) && null });
    expect(called).toBe(false);
  });

  it("signs the legacy session out and strips it, keeping everything else", async () => {
    writeCredential({
      token: "relu_keep",
      sessionToken: "sess_drop",
      keyId: "ak_1",
      apiUrl: "https://test.example.com",
      savedAt: "2026-06-06T00:00:00.000Z",
    });
    let seenApiUrl: string | null = null;
    let seenToken: string | null = null;
    await retireStoredSession({
      signOut: async (apiUrl, sessionToken) => {
        seenApiUrl = apiUrl;
        seenToken = sessionToken;
        return null;
      },
    });
    expect(seenApiUrl).toBe("https://test.example.com");
    expect(seenToken).toBe("sess_drop");
    const cred = readCredential();
    expect(cred?.token).toBe("relu_keep");
    expect(cred?.keyId).toBe("ak_1");
    expect(cred?.sessionToken).toBeUndefined();
  });

  it("prints a note only when the sign-out itself fails", async () => {
    writeCredential({
      token: "relu_x",
      sessionToken: "sess_drop",
      apiUrl: "https://test.example.com",
      savedAt: "2026-06-06T00:00:00.000Z",
    });
    const printed: string[] = [];
    await retireStoredSession({
      signOut: async () => "server unreachable",
      print: (l) => printed.push(l),
    });
    expect(printed.some((l) => l.includes("Could not sign out"))).toBe(true);
    // Even on a sign-out failure, the local credential is still stripped —
    // we never want a legacy session token lingering on disk.
    expect(readCredential()?.sessionToken).toBeUndefined();
  });

  it("uses injected readCredential/writeCredential when given (so callers with their own storage don't touch disk)", async () => {
    clearCredential();
    let written: unknown = null;
    await retireStoredSession({
      readCredential: () => ({
        token: "relu_injected",
        sessionToken: "sess_injected",
        apiUrl: "https://test.example.com",
        savedAt: "2026-06-06T00:00:00.000Z",
      }),
      writeCredential: (c) => {
        written = c;
      },
      signOut: async () => null,
    });
    expect(written).not.toBeNull();
    expect((written as { sessionToken?: string }).sessionToken).toBeUndefined();
    // The real on-disk credential file was never touched.
    expect(readCredential()).toBeNull();
  });
});
