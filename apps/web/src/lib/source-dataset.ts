type DatasetSource = {
  id?: string;
  name: string;
  url: string;
  org?: { name: string } | null;
};

/** Describe the indexed history separately from its landing page and upstream
 * release notes. Coverage, licensing, and exports require independent evidence
 * and deliberately aren't inferred from the latest page of release rows. */
export function buildSourceDatasetJsonLd(
  source: DatasetSource,
  pageUrl: string,
  pilot: { name: string; description: string },
): Record<string, unknown>[] {
  const pageId = `${pageUrl}#page`;
  const datasetId = `${pageUrl}#dataset`;
  let upstreamUrl: string | undefined;
  try {
    const parsed = new URL(source.url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      upstreamUrl = parsed.href;
    }
  } catch {
    // An invalid upstream URL must never become machine-readable provenance.
  }

  return [
    {
      "@type": "CollectionPage",
      "@id": pageId,
      url: pageUrl,
      name: pilot.name,
      description: pilot.description,
      mainEntity: { "@id": datasetId },
    },
    {
      "@type": "Dataset",
      "@id": datasetId,
      url: pageUrl,
      name: pilot.name,
      description: pilot.description,
      ...(source.id ? { identifier: source.id } : {}),
      // This is our assembled index; the original notes retain their own
      // publisher, credited separately by isBasedOn below.
      creator: {
        "@type": "Organization",
        name: "Release Notes Index",
        url: "https://releases.sh",
      },
      publisher: {
        "@type": "Organization",
        name: "Release Notes Index",
        url: "https://releases.sh",
      },
      isAccessibleForFree: true,
      ...(upstreamUrl
        ? {
            isBasedOn: {
              "@type": "CreativeWork",
              name: source.name,
              url: upstreamUrl,
              ...(source.org
                ? { publisher: { "@type": "Organization", name: source.org.name } }
                : {}),
            },
          }
        : {}),
      mainEntityOfPage: { "@id": pageId },
    },
  ];
}
