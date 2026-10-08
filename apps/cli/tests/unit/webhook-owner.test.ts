import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { ApiError, CliError } from "../../src/lib/errors.js";

const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = "https://test.example.com";
  process.env.RELEASES_API_KEY = "test-key";
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

const { resolveWebhookOwner, assertWorkspaceScopeSupported, translateWebhookApiError } =
  await import("../../src/cli/commands/webhook-owner.js");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveWebhookOwner", () => {
  it("returns the user owner when no --workspace value is given", async () => {
    const { owner, workspace } = await resolveWebhookOwner(undefined);
    expect(owner).toEqual({ kind: "user" });
    expect(workspace).toBeUndefined();
  });

  describe("with a --workspace value", () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        json({
          workspaces: [
            {
              id: "ws_1",
              name: "Acme",
              slug: "acme",
              logo: null,
              role: "admin",
              active: true,
              createdAt: "",
            },
          ],
        })) as unknown as typeof globalThis.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("resolves a matching slug to a workspace owner", async () => {
      const { owner, workspace } = await resolveWebhookOwner("acme");
      expect(owner).toEqual({ kind: "workspace", id: "ws_1" });
      expect(workspace?.role).toBe("admin");
    });

    it("resolves a matching id to a workspace owner", async () => {
      const { owner } = await resolveWebhookOwner("ws_1");
      expect(owner).toEqual({ kind: "workspace", id: "ws_1" });
    });

    it("throws a CliError listing the caller's workspaces on no match", async () => {
      await expect(resolveWebhookOwner("nope")).rejects.toThrow(CliError);
      try {
        await resolveWebhookOwner("nope");
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as Error).message).toContain("Acme");
        expect((err as Error).message).toContain("acme");
        expect((err as Error).message).toContain("ws_1");
      }
    });
  });
});

describe("assertWorkspaceScopeSupported", () => {
  it("throws when --workspace is combined with --scope follows", () => {
    expect(() => assertWorkspaceScopeSupported("ws_1", "follows")).toThrow(CliError);
  });

  it("is a no-op for org scope", () => {
    expect(() => assertWorkspaceScopeSupported("ws_1", "org")).not.toThrow();
  });

  it("is a no-op without --workspace, regardless of scope", () => {
    expect(() => assertWorkspaceScopeSupported(undefined, "follows")).not.toThrow();
  });
});

describe("translateWebhookApiError", () => {
  const apiErr = (status: number) =>
    new ApiError({
      status,
      method: "PATCH",
      path: "/v1/workspaces/ws_1/webhooks/whk_1",
      serverMessage: "nope",
    });

  it("turns a workspace 403 into the owners/admins message", () => {
    expect(() => translateWebhookApiError(apiErr(403), { kind: "workspace", id: "ws_1" })).toThrow(
      "Only workspace owners and admins can change workspace webhooks.",
    );
  });

  it("turns a workspace 404 into the not-a-member message", () => {
    expect(() => translateWebhookApiError(apiErr(404), { kind: "workspace", id: "ws_1" })).toThrow(
      "Webhook not found in this workspace.",
    );
  });

  it("rethrows other statuses unchanged", () => {
    expect(() => translateWebhookApiError(apiErr(500), { kind: "workspace", id: "ws_1" })).toThrow(
      ApiError,
    );
  });

  it("rethrows unchanged for the user owner (never rewrites /v1/me/webhooks errors)", () => {
    expect(() => translateWebhookApiError(apiErr(403), { kind: "user" })).toThrow(ApiError);
  });
});
