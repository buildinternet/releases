import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceDatasetPanel } from "./source-dataset-panel";

test.each([1, 64])("labels the REST resolver's non-prerelease count accurately (%i)", (count) => {
  // The resolver calls buildSourceDetailPayload with includePrereleases:false.
  // Next.js canary records remain indexed, so this must not claim to be the
  // total index size (PR #2536 review).
  const html = renderToStaticMarkup(
    <SourceDatasetPanel
      pilot={{ name: "Next.js release history", description: "Searchable release records." }}
      basePath="/vercel/next-js"
      sourceUrl="https://github.com/vercel/next.js"
      releaseCount={count}
    />,
  );
  expect(html).toContain(count === 1 ? ">stable release<" : ">stable releases<");
  expect(html).not.toContain("indexed releases");
});
