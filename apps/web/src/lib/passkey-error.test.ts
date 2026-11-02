import { describe, expect, it } from "bun:test";
import { passkeySignInMessage } from "./passkey-error";

describe("passkeySignInMessage", () => {
  it("stays quiet when autofill is dismissed", () => {
    expect(
      passkeySignInMessage({ code: "AUTH_CANCELLED", message: "Auth cancelled" }, "autofill"),
    ).toBeNull();
  });

  it("shows a cancellation on the explicit button", () => {
    expect(
      passkeySignInMessage({ code: "AUTH_CANCELLED", message: "Auth cancelled" }, "button"),
    ).toBe("Auth cancelled");
  });

  it("shows a verification failure during autofill", () => {
    expect(
      passkeySignInMessage(
        { code: "FAILED_TO_VERIFY", message: "Could not verify the passkey." },
        "autofill",
      ),
    ).toBe("Could not verify the passkey.");
  });

  it("falls back when the plugin returns an empty message", () => {
    expect(passkeySignInMessage({ code: "UNKNOWN", message: "  " }, "button")).toBe(
      "Could not sign in with a passkey. Please try again.",
    );
  });
});
