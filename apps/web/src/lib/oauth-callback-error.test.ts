import { describe, expect, it } from "bun:test";
import { oauthCallbackErrorCopy } from "./oauth-callback-error";

describe("oauthCallbackErrorCopy", () => {
  it("maps a cancelled provider redirect", () => {
    expect(oauthCallbackErrorCopy("access_denied").title).toBe("Sign-in was cancelled");
  });

  it("maps a state mismatch to a retry message", () => {
    expect(oauthCallbackErrorCopy("state_mismatch").message).toContain("this browser");
  });

  it("uses one generic message for a missing or unknown code", () => {
    const missing = oauthCallbackErrorCopy(undefined);
    const unknown = oauthCallbackErrorCopy("not_a_real_code<script>");
    expect(unknown).toEqual(missing);
    expect(unknown.message).not.toContain("not_a_real_code");
    expect(unknown.message).not.toContain("<script>");
  });

  it("does not echo a free-form description", () => {
    const copy = oauthCallbackErrorCopy("visit https://evil.example and sign in again");
    expect(copy).toEqual(oauthCallbackErrorCopy(undefined));
    expect(copy.message).not.toContain("evil.example");
  });

  it("names account creation, linking, and link-token failures", () => {
    expect(oauthCallbackErrorCopy("unable_to_create_user").title).toBe(
      "Couldn't create your account",
    );
    expect(oauthCallbackErrorCopy("account_not_linked").message).toContain("isn't connected");
    expect(oauthCallbackErrorCopy("INVALID_TOKEN").title).toBe("This link isn't valid");
    expect(oauthCallbackErrorCopy("TOKEN_EXPIRED").title).toBe("This link expired");
    expect(oauthCallbackErrorCopy("invalid_redirect").message).toContain("isn't allowed");
  });

  it("uses the generic message for an internal failure without echoing the code", () => {
    expect(oauthCallbackErrorCopy("internal_server_error")).toEqual(
      oauthCallbackErrorCopy(undefined),
    );
  });
});
