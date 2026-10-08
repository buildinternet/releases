import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { keysRequest } from "../../src/cli/commands/keys.js";
import {
  printCreatedPublishToken,
  printPublishTokenList,
} from "../../src/cli/commands/publish-token.js";
import { ApiError } from "../../src/lib/errors.js";
import type {
  CreatedPublishToken,
  ListPublishTokensResponse,
} from "@buildinternet/releases-api-types";

const BASE = "https://test.example.com";

// Same rationale as keys.test.ts: keysRequest routes through the shared
// apiFetch transport, which resolves its base URL from RELEASES_API_URL.
const prevEnv: { url?: string; key?: string } = {};
beforeAll(() => {
  prevEnv.url = process.env.RELEASES_API_URL;
  prevEnv.key = process.env.RELEASES_API_KEY;
  process.env.RELEASES_API_URL = BASE;
  delete process.env.RELEASES_API_KEY;
});
afterAll(() => {
  if (prevEnv.url === undefined) delete process.env.RELEASES_API_URL;
  else process.env.RELEASES_API_URL = prevEnv.url;
  if (prevEnv.key === undefined) delete process.env.RELEASES_API_KEY;
  else process.env.RELEASES_API_KEY = prevEnv.key;
});

function envelope(code: string, message: string) {
  return { error: { code, type: "https://releases.sh/errors/" + code, message } };
}

describe("publish-token requests over the shared session transport", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the given session token as a Bearer credential on /v1/me/publish-tokens", async () => {
    let seenAuth = "";
    let seenPath = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      seenPath = String(url);
      return new Response(JSON.stringify({ publishTokens: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await keysRequest<ListPublishTokensResponse>(
      "/v1/me/publish-tokens",
      { method: "GET" },
      "sess_tok",
    );
    expect(seenAuth).toBe("Bearer sess_tok");
    expect(seenPath).toContain("/v1/me/publish-tokens");
  });

  it("surfaces the server's 403 message (no verified ownership claim)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(
          envelope(
            "forbidden",
            "Verify your domain first — see https://releases.sh/docs/integrations/github-actions",
          ),
        ),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await keysRequest(
        "/v1/me/publish-tokens",
        { method: "POST", body: JSON.stringify({ sourceId: "src_x", name: "n" }) },
        "sess_tok",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
    expect((caught as ApiError).serverMessage).toBe(
      "Verify your domain first — see https://releases.sh/docs/integrations/github-actions",
    );
  });

  it("surfaces the server's 409 message (api_key_limit)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(
          envelope(
            "api_key_limit",
            "This source already has 5 active publish tokens. Revoke one before minting another.",
          ),
        ),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await keysRequest(
        "/v1/me/publish-tokens",
        { method: "POST", body: JSON.stringify({ sourceId: "src_x", name: "n" }) },
        "sess_tok",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).serverMessage).toBe(
      "This source already has 5 active publish tokens. Revoke one before minting another.",
    );
  });
});

describe("printCreatedPublishToken", () => {
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalWrite: typeof process.stdout.write;
  let out: string[];
  let errOut: string[];

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
    originalWrite = process.stdout.write;
    out = [];
    errOut = [];
    console.log = (...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errOut.push(args.map(String).join(" "));
    };
    process.stdout.write = ((chunk: unknown) => {
      out.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  });

  const created: CreatedPublishToken = {
    token: "relk_src_abc123_secret",
    id: "pt_1",
    sourceId: "src_abc123",
    name: "GitHub Actions",
    createdAt: "2026-09-24T00:00:00.000Z",
  };

  it("prints only the token to stdout — nothing else", async () => {
    await printCreatedPublishToken(created, false);
    expect(out).toEqual(["relk_src_abc123_secret"]);
  });

  it("prints guidance (shown-once note + workflow snippet) to stderr", async () => {
    await printCreatedPublishToken(created, false);
    const joined = errOut.join("\n");
    expect(joined).toContain("won't be shown again");
    expect(joined).toContain("src_abc123");
    expect(joined).toContain("buildinternet/releases/actions/publish-changelog@main");
    expect(joined).toContain("source: src_abc123");
    expect(joined).toContain("api-token: ${{ secrets.RELEASES_API_TOKEN }}");
  });

  it("with --json, writes only the CreatedPublishToken payload to stdout", async () => {
    await printCreatedPublishToken(created, true);
    expect(errOut).toEqual([]);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual(created);
  });
});

describe("printPublishTokenList", () => {
  let originalLog: typeof console.log;
  let originalWrite: typeof process.stdout.write;
  let out: string[];

  beforeEach(() => {
    originalLog = console.log;
    originalWrite = process.stdout.write;
    out = [];
    console.log = (...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    };
    process.stdout.write = ((chunk: unknown) => {
      out.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  });

  it("shows an empty-state hint when there are no tokens", async () => {
    await printPublishTokenList({ publishTokens: [] }, false);
    expect(out.join("\n")).toContain("releases publish-token create --source");
  });

  it("renders a table row for an active token (org/slug source, never used)", async () => {
    await printPublishTokenList(
      {
        publishTokens: [
          {
            id: "pt_1",
            name: "GitHub Actions",
            sourceId: "src_1",
            sourceSlug: "changelog",
            orgSlug: "acme",
            createdAt: "2026-09-01T00:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null,
          },
        ],
      },
      false,
    );
    const rendered = out.join("\n");
    expect(rendered).toContain("pt_1");
    expect(rendered).toContain("GitHub Actions");
    expect(rendered).toContain("acme/changelog");
    expect(rendered).toContain("2026-09-01");
  });

  it("renders a revoked token's revoked date and falls back to raw sourceId without slugs", async () => {
    await printPublishTokenList(
      {
        publishTokens: [
          {
            id: "pt_2",
            name: "Old token",
            sourceId: "src_2",
            sourceSlug: null,
            orgSlug: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            lastUsedAt: "2026-08-15T00:00:00.000Z",
            revokedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
      false,
    );
    const rendered = out.join("\n");
    expect(rendered).toContain("pt_2");
    expect(rendered).toContain("src_2");
    expect(rendered).toContain("2026-08-15");
    expect(rendered).toContain("2026-09-01");
  });

  it("with --json, writes the full ListPublishTokensResponse payload", async () => {
    const data: ListPublishTokensResponse = {
      publishTokens: [
        {
          id: "pt_1",
          name: "n",
          sourceId: "src_1",
          sourceSlug: "changelog",
          orgSlug: "acme",
          createdAt: "2026-09-01T00:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    };
    await printPublishTokenList(data, true);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual(data);
  });
});
