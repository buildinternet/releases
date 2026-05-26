import { describe, it, expect } from "bun:test";
import {
  buildSignaturesDirectory,
  isWebBotAuthProvisioned,
  WEB_BOT_AUTH_SIGNATURE_AGENT,
  WEB_BOT_AUTH_DIRECTORY_URL,
  WEB_BOT_AUTH_USER_AGENT,
  type Ed25519PublicJwk,
} from "./web-bot-auth";

const SAMPLE: Ed25519PublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
  kid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
};

describe("buildSignaturesDirectory", () => {
  it("serves a JWKS with the directory content type", () => {
    const { body, contentType } = buildSignaturesDirectory(SAMPLE);
    expect(contentType).toBe("application/http-message-signatures-directory+json");
    const parsed = JSON.parse(body) as { keys: Ed25519PublicJwk[] };
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0].kid).toBe(SAMPLE.kid);
    expect(parsed.keys[0].crv).toBe("Ed25519");
  });

  it("exposes the canonical agent + directory URLs", () => {
    expect(WEB_BOT_AUTH_SIGNATURE_AGENT).toBe("https://releases.sh");
    expect(WEB_BOT_AUTH_DIRECTORY_URL).toBe(
      "https://releases.sh/.well-known/http-message-signatures-directory",
    );
  });

  it("reports provisioned only when x and kid are non-empty", () => {
    expect(isWebBotAuthProvisioned(SAMPLE)).toBe(true);
    expect(isWebBotAuthProvisioned({ ...SAMPLE, x: "" })).toBe(false);
    expect(isWebBotAuthProvisioned({ ...SAMPLE, kid: "" })).toBe(false);
  });

  it("pins the canonical crawler User-Agent", () => {
    expect(WEB_BOT_AUTH_USER_AGENT).toBe("releases/0.1 (+https://releases.sh)");
  });
});
