import { describe, expect, test } from "bun:test";
import { buildSourceDatasetJsonLd } from "./source-dataset";

const source = {
  id: "src_example",
  name: "Example release notes",
  url: "https://example.com/changelog",
  org: { name: "Example" },
};
const pageUrl = "https://releases.sh/example/release-notes";
const pilot = {
  name: "Example indexed release history",
  description:
    "Release notes indexed by Releases from Example's changelog, with publication dates and links to original announcements. Coverage may be incomplete.",
};

describe("source dataset graph", () => {
  test("distinguishes the landing page, indexed dataset, and original publisher", () => {
    const graph = buildSourceDatasetJsonLd(source, pageUrl, pilot);
    const page = graph.find((node) => node["@type"] === "CollectionPage");
    const dataset = graph.find((node) => node["@type"] === "Dataset");

    expect(page?.["@id"]).not.toBe(dataset?.["@id"]);
    expect(page?.mainEntity).toEqual({ "@id": dataset?.["@id"] });
    expect(dataset?.mainEntityOfPage).toEqual({ "@id": page?.["@id"] });
    expect(dataset).toMatchObject({
      url: pageUrl,
      name: pilot.name,
      description: pilot.description,
      identifier: "src_example",
      creator: { name: "Release Notes Index", url: "https://releases.sh" },
      publisher: { name: "Release Notes Index", url: "https://releases.sh" },
      isAccessibleForFree: true,
      isBasedOn: {
        url: "https://example.com/changelog",
        publisher: { name: "Example" },
      },
    });
    for (const field of [
      "sameAs",
      "license",
      "distribution",
      "temporalCoverage",
      "dateModified",
      "version",
    ]) {
      expect(dataset).not.toHaveProperty(field);
    }
  });

  test.each(["javascript:alert(1)", "data:text/html,hello", "/changelog", "invalid"])(
    "does not advertise unsafe or invalid provenance: %s",
    (url) => {
      const graph = buildSourceDatasetJsonLd({ ...source, url }, pageUrl, pilot);
      const dataset = graph.find((node) => node["@type"] === "Dataset");
      expect(dataset).toBeDefined();
      expect(dataset).not.toHaveProperty("isBasedOn");
    },
  );
});
