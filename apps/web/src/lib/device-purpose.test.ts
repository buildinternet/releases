import { describe, it, expect } from "bun:test";
import { DEVICE_AUTH_PURPOSES } from "@buildinternet/releases-core/api-token";
import { DEVICE_PURPOSE_COPY, devicePurpose } from "./device-purpose";

describe("devicePurpose", () => {
  it("passes known purposes through", () => {
    for (const p of DEVICE_AUTH_PURPOSES) expect(devicePurpose(p)).toBe(p);
  });

  it("treats a missing or unknown scope as an older CLI", () => {
    expect(devicePurpose(undefined)).toBeNull();
    expect(devicePurpose("")).toBeNull();
    expect(devicePurpose("admin")).toBeNull();
  });

  it("describes every purpose, with a permission row for account commands", () => {
    for (const p of DEVICE_AUTH_PURPOSES) expect(DEVICE_PURPOSE_COPY[p].title).toBeTruthy();
    expect(DEVICE_PURPOSE_COPY.login.permission).toBeUndefined();
    expect(DEVICE_PURPOSE_COPY.keys.permission).toBeDefined();
    expect(DEVICE_PURPOSE_COPY["publish-tokens"].permission).toBeDefined();
  });
});
