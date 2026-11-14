import {
  loadOpenAPISpec,
  operationsForTags,
  parseTagList,
  specForOperations,
} from "@/lib/openapi-spec";
import { OpenAPIPage } from "./openapi-page";

const DOCUMENT_ID = "releases";

/**
 * `<APIPage tags="Orgs" />` in a generated `docs/api/reference/*.mdx` page:
 * renders every public operation tagged with one of `tags`, from the
 * production spec snapshot (`src/content/openapi.json`). Each page ships only
 * its own operations to the client. The `.md` export swaps this for
 * `apiPageMarkdown` (`@/lib/docs`).
 */
export function APIPage({ tags }: { tags: string }) {
  const spec = loadOpenAPISpec();
  const operations = operationsForTags(spec, parseTagList(tags));
  const document = specForOperations(spec, operations);
  return (
    <div className="api-reference not-prose">
      <OpenAPIPage
        document={DOCUMENT_ID}
        // fumadocs-openapi's Document type is stricter than our snapshot's.
        preloaded={{ docs: { [DOCUMENT_ID]: document as never } }}
        operations={operations}
        showTitle
        showDescription
      />
    </div>
  );
}
