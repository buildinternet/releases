import { describe, it, expect, afterEach } from "bun:test";
import {
  bundleIdFromAppId,
  playStoreUrl,
  parseAppSiteAssociation,
  parseAssetLinks,
} from "@releases/adapters/app-links";
import { resolveAppStoreByBundleId, type AppStoreListing } from "@releases/adapters/appstore";
import { restoreGlobalFetch } from "../global-fetch";

describe("bundleIdFromAppId", () => {
  it("strips the 10-char Team ID prefix", () => {
    expect(bundleIdFromAppId("9JA89QQLNQ.com.apple.wwdc")).toBe("com.apple.wwdc");
  });
  it("keeps a multi-segment bundle id intact", () => {
    expect(bundleIdFromAppId("ABCDE12345.com.example.app.ios")).toBe("com.example.app.ios");
  });
  it("returns null without a Team ID prefix", () => {
    expect(bundleIdFromAppId("com.example.app")).toBeNull();
  });
  it("returns null when the bundle part has no dot (not reverse-DNS)", () => {
    expect(bundleIdFromAppId("9JA89QQLNQ.app")).toBeNull();
  });
  it("returns null on a missing dot entirely", () => {
    expect(bundleIdFromAppId("9JA89QQLNQ")).toBeNull();
  });
});

describe("playStoreUrl", () => {
  it("builds a Play Store details URL", () => {
    expect(playStoreUrl("com.example.app")).toBe(
      "https://play.google.com/store/apps/details?id=com.example.app",
    );
  });
});

describe("parseAppSiteAssociation", () => {
  it("collects appID and appIDs from applinks.details, deduped", () => {
    const json = {
      applinks: {
        apps: [],
        details: [
          { appID: "9JA89QQLNQ.com.example.ios", paths: ["*"] },
          { appIDs: ["ABCDE12345.com.example.ios", "ABCDE12345.com.example.other"] },
        ],
      },
    };
    expect(parseAppSiteAssociation(json).bundleIds).toEqual([
      "com.example.ios",
      "com.example.other",
    ]);
  });
  it("also reads webcredentials.apps", () => {
    const json = { webcredentials: { apps: ["ABCDE12345.com.example.web"] } };
    expect(parseAppSiteAssociation(json).bundleIds).toEqual(["com.example.web"]);
  });
  it("drops malformed appIDs and returns empty on junk", () => {
    expect(
      parseAppSiteAssociation({ applinks: { details: [{ appID: "nope" }] } }).bundleIds,
    ).toEqual([]);
    expect(parseAppSiteAssociation(null).bundleIds).toEqual([]);
    expect(parseAppSiteAssociation("<html>challenge</html>").bundleIds).toEqual([]);
    expect(parseAppSiteAssociation([]).bundleIds).toEqual([]);
  });
});

describe("parseAssetLinks", () => {
  it("collects android_app package names, deduped, ignoring web targets", () => {
    const json = [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.example.android",
          sha256_cert_fingerprints: ["AA:BB"],
        },
      },
      { target: { namespace: "web", site: "https://example.com" } },
      { target: { namespace: "android_app", package_name: "com.example.android" } },
    ];
    expect(parseAssetLinks(json).packageNames).toEqual(["com.example.android"]);
  });
  it("returns empty on non-array / junk", () => {
    expect(parseAssetLinks({}).packageNames).toEqual([]);
    expect(parseAssetLinks(null).packageNames).toEqual([]);
    expect(parseAssetLinks("<html>").packageNames).toEqual([]);
  });
});

describe("resolveAppStoreByBundleId (network)", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  it("hits the iTunes lookup with bundleId= and returns the first result", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (input: string) => {
      calledUrl = input;
      return new Response(
        JSON.stringify({
          resultCount: 1,
          results: [{ trackId: 42, bundleId: "com.example.app", trackViewUrl: "u" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = (await resolveAppStoreByBundleId("com.example.app")) as AppStoreListing;
    expect(out.trackId).toBe(42);
    expect(calledUrl).toContain("bundleId=com.example.app");
    expect(calledUrl).toContain("country=us");
  });

  it("returns null on non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await resolveAppStoreByBundleId("com.example.app")).toBeNull();
  });

  it("returns null on an empty result set", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ resultCount: 0, results: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await resolveAppStoreByBundleId("com.example.app")).toBeNull();
  });

  it("adds the macSoftware entity for macos", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (input: string) => {
      calledUrl = input;
      return new Response(JSON.stringify({ resultCount: 1, results: [{ trackId: 1 }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await resolveAppStoreByBundleId("com.example.app", { platform: "macos", storefront: "gb" });
    expect(calledUrl).toContain("entity=macSoftware");
    expect(calledUrl).toContain("country=gb");
  });
});
