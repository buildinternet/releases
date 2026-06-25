import { describe, it, expect, afterEach, beforeEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];

function mockFetch(response: unknown, ok = true, status = 200) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

describe("account-profile-api avatar uploads", () => {
  it("posts user avatars through the same-origin proxy", async () => {
    mockFetch({ avatarUrl: "https://media.test/users/u.png", key: "users/u.png" });
    const { uploadUserAvatar } = await import("./account-profile-api.js");
    const file = new File([new Uint8Array(128)], "a.png", { type: "image/png" });
    const res = await uploadUserAvatar(file);
    expect(res.avatarUrl).toContain("media.test");
    expect(calls[0]!.url).toBe("/api/account/me/avatar");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("posts workspace avatars through the same-origin proxy", async () => {
    mockFetch({ avatarUrl: "https://media.test/workspaces/o.png", key: "workspaces/o.png" });
    const { uploadWorkspaceAvatar } = await import("./account-profile-api.js");
    const file = new File([new Uint8Array(128)], "a.png", { type: "image/png" });
    await uploadWorkspaceAvatar("org_abc12345", file);
    expect(calls[0]!.url).toBe("/api/workspaces/org_abc12345/avatar");
  });

  it("rejects files over the proxy upload cap before fetch", async () => {
    mockFetch({ avatarUrl: "https://media.test/users/u.png" });
    const { uploadUserAvatar } = await import("./account-profile-api.js");
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await expect(uploadUserAvatar(big)).rejects.toThrow(/upload cap/);
    expect(calls).toHaveLength(0);
  });
});
