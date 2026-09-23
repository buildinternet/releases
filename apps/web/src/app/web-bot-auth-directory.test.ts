import { describe, it, expect } from "bun:test";
import { GET } from "./.well-known/http-message-signatures-directory/route";
import { isWebBotAuthProvisioned } from "@buildinternet/releases-core/web-bot-auth";

// This test lives one level up from the route it covers: `bun test` skips
// dot-directories, so a test co-located inside `.well-known/` is never
// discovered by the suite (it would only run when invoked by explicit path).
// Keeping it in `app/` and importing the route by path keeps it in CI.
describe("GET /.well-known/http-message-signatures-directory", () => {
  it("returns 404 until a key is provisioned, else a JWKS", async () => {
    const res = GET();
    if (isWebBotAuthProvisioned()) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/http-message-signatures-directory+json",
      );
      const json = (await res.json()) as { keys: Array<{ crv: string }> };
      expect(json.keys[0].crv).toBe("Ed25519");
    } else {
      expect(res.status).toBe(404);
    }
  });
});
