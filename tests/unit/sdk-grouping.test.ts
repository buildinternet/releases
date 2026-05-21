import { describe, expect, test } from "bun:test";
import { partitionSdkSources, sdkPreview, SDK_GROUP_MIN } from "../../web/src/lib/sdk-grouping";

type S = {
  slug: string;
  name: string;
  releaseCount: number;
  kind?: "platform" | "sdk" | "tool" | null;
  productSlug?: string | null;
};
const s = (o: Partial<S> & { slug: string }): S => ({
  name: o.slug,
  releaseCount: 0,
  kind: null,
  productSlug: null,
  ...o,
});

describe("partitionSdkSources", () => {
  test("groups sources whose own kind is sdk (>= threshold)", () => {
    const { flat, sdk } = partitionSdkSources(
      [
        s({ slug: "a", kind: "sdk" }),
        s({ slug: "b", kind: "sdk" }),
        s({ slug: "p", kind: "platform" }),
      ],
      [],
    );
    expect(sdk.map((x) => x.slug)).toEqual(["a", "b"]);
    expect(flat.map((x) => x.slug)).toEqual(["p"]);
  });

  test("inherits sdk from parent product when source kind is null", () => {
    const { sdk } = partitionSdkSources(
      [s({ slug: "a", productSlug: "lib" }), s({ slug: "b", productSlug: "lib" })],
      [{ slug: "lib", kind: "sdk" }],
    );
    expect(sdk.map((x) => x.slug)).toEqual(["a", "b"]);
  });

  test("below threshold leaves everything flat", () => {
    const { flat, sdk } = partitionSdkSources(
      [s({ slug: "a", kind: "sdk" }), s({ slug: "p", kind: "platform" })],
      [],
    );
    expect(sdk).toEqual([]);
    expect(flat.map((x) => x.slug)).toEqual(["a", "p"]);
  });

  test("source's own kind wins over its product's kind", () => {
    const { sdk, flat } = partitionSdkSources(
      [
        s({ slug: "a", kind: "sdk", productSlug: "plat" }),
        s({ slug: "b", kind: "sdk", productSlug: "plat" }),
      ],
      [{ slug: "plat", kind: "platform" }],
    );
    expect(sdk.map((x) => x.slug)).toEqual(["a", "b"]);
    expect(flat).toEqual([]);
  });

  test("empty input returns empty flat and sdk", () => {
    const { flat, sdk } = partitionSdkSources([], []);
    expect(flat).toEqual([]);
    expect(sdk).toEqual([]);
  });

  test("SDK_GROUP_MIN is 2", () => {
    expect(SDK_GROUP_MIN).toBe(2);
  });
});

describe("sdkPreview", () => {
  test("orders members by release count desc, joined with ' · '", () => {
    expect(
      sdkPreview([
        { name: "py", releaseCount: 5 },
        { name: "js", releaseCount: 10 },
        { name: "go", releaseCount: 1 },
      ]),
    ).toBe("js · py · go");
  });
});
