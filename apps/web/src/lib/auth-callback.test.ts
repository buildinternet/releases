import { describe, expect, it } from "bun:test";
import { authContinueCallbackURL, authContinueTarget, authErrorCallbackURL } from "./auth-callback";

describe("auth callback URLs", () => {
  it("builds an absolute error page on the web origin", () => {
    expect(authErrorCallbackURL("https://releases.sh")).toBe("https://releases.sh/auth/error");
  });

  it("keeps the post-verify destination on a same-origin path", () => {
    expect(authContinueCallbackURL("https://releases.sh", "/following")).toBe(
      "https://releases.sh/auth/continue?next=%2Ffollowing",
    );
  });

  it("drops an off-site next path", () => {
    const url = new URL(
      authContinueCallbackURL("https://releases.sh", "https://evil.example/phish"),
    );
    expect(url.searchParams.get("next")).toBe("/");
  });

  it("sends a known error code to the error page", () => {
    expect(authContinueTarget({ error: "TOKEN_EXPIRED", next: "/account" })).toBe(
      "/auth/error?error=TOKEN_EXPIRED",
    );
  });

  it("sends an unsafe error code to the generic error page", () => {
    expect(authContinueTarget({ error: "user@example.com", next: "/account" })).toBe("/auth/error");
    expect(authContinueTarget({ error: ["<script>"], next: "/account" })).toBe("/auth/error");
  });

  it("continues when there is no error", () => {
    expect(authContinueTarget({ next: "/following" })).toBe("/following");
    expect(authContinueTarget({ next: "https://evil.example" })).toBe("/");
    expect(authContinueTarget({})).toBe("/");
  });
});
