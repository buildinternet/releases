import { describe, expect, it } from "bun:test";
import {
  intersectAdvertisedGrantTypes,
  rewriteClientMetadataGrantTypes,
} from "./oauth-grant-types.js";

const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

describe("intersectAdvertisedGrantTypes", () => {
  it("intersects MCPJam-shaped extras down to authorization_code + refresh_token", () => {
    expect(
      intersectAdvertisedGrantTypes(["authorization_code", "refresh_token", DEVICE_CODE]),
    ).toEqual(["authorization_code", "refresh_token"]);
  });

  it("also drops jwt-bearer extras", () => {
    expect(
      intersectAdvertisedGrantTypes(["authorization_code", "refresh_token", JWT_BEARER]),
    ).toEqual(["authorization_code", "refresh_token"]);
  });

  it("does not invent a supported grant when only device_code is advertised", () => {
    expect(intersectAdvertisedGrantTypes([DEVICE_CODE])).toBeUndefined();
  });

  it("returns undefined for a missing or non-array value", () => {
    expect(intersectAdvertisedGrantTypes(undefined)).toBeUndefined();
    expect(intersectAdvertisedGrantTypes("authorization_code")).toBeUndefined();
  });
});

describe("rewriteClientMetadataGrantTypes", () => {
  it("rewrites a DCR body that lists extra grants", () => {
    expect(
      rewriteClientMetadataGrantTypes({
        client_name: "MCPJam",
        grant_types: ["authorization_code", "refresh_token", DEVICE_CODE],
      }),
    ).toEqual({
      client_name: "MCPJam",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  it("leaves an already-supported list alone", () => {
    expect(
      rewriteClientMetadataGrantTypes({
        grant_types: ["authorization_code", "refresh_token"],
      }),
    ).toBeUndefined();
  });

  it("leaves a device-code-only document alone so ingest still rejects it", () => {
    expect(rewriteClientMetadataGrantTypes({ grant_types: [DEVICE_CODE] })).toBeUndefined();
  });
});
