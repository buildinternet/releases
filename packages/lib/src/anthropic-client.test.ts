import { describe, test, expect } from "bun:test";
import { buildAnthropicClient } from "./anthropic-client";

describe("buildAnthropicClient", () => {
  test("applies apiKey", () => {
    const client = buildAnthropicClient({ apiKey: "sk-test" });
    expect((client as unknown as { apiKey: string }).apiKey).toBe("sk-test");
  });

  test("passes baseURL through when provided", () => {
    const url = "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic";
    const client = buildAnthropicClient({ apiKey: "sk-test", baseURL: url });
    expect((client as unknown as { baseURL: string }).baseURL).toBe(url);
  });

  test("omits baseURL when not provided (SDK default applies)", () => {
    const client = buildAnthropicClient({ apiKey: "sk-test" });
    // SDK assigns its own default when caller omits baseURL — only assert
    // that we didn't explicitly override to undefined/empty.
    const baseURL = (client as unknown as { baseURL: string }).baseURL;
    expect(baseURL).toContain("anthropic.com");
  });

  test("attaches cf-aig-authorization header when gatewayToken set", () => {
    const client = buildAnthropicClient({
      apiKey: "sk-test",
      gatewayToken: "tkn_abc",
    });
    const headers = (client as unknown as { _options: { defaultHeaders: Record<string, string> } })
      ._options.defaultHeaders;
    expect(headers["cf-aig-authorization"]).toBe("Bearer tkn_abc");
  });

  test("omits cf-aig-authorization header when gatewayToken absent", () => {
    const client = buildAnthropicClient({ apiKey: "sk-test" });
    const headers =
      (client as unknown as { _options?: { defaultHeaders?: Record<string, string> } })._options
        ?.defaultHeaders ?? {};
    expect(headers["cf-aig-authorization"]).toBeUndefined();
  });

  test("applies timeoutMs when provided", () => {
    const client = buildAnthropicClient({ apiKey: "sk-test", timeoutMs: 3000 });
    expect((client as unknown as { timeout: number }).timeout).toBe(3000);
  });
});
