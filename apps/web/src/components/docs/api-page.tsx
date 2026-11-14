import {
  loadOpenAPISpec,
  operationsByIds,
  parseIdList,
  specForOperations,
} from "@/lib/openapi-spec";
import { OpenAPIPage } from "./openapi-page";

const DOCUMENT_ID = "releases";

/**
 * `<APIPage operations="getOrgs" />` in a generated
 * `docs/api/reference/<group>/<endpoint>.mdx` page: renders those operations
 * (usually one; dual-registered routes share a page) from the production spec
 * snapshot (`src/content/openapi.json`), shipping only them to the client. The
 * page's h1 is the title, so the renderer's own title is off. The `.md` export
 * swaps this for `apiPageMarkdown` (`@/lib/docs`).
 */
export function APIPage({ operations: ids }: { operations: string }) {
  const spec = loadOpenAPISpec();
  const operations = operationsByIds(spec, parseIdList(ids));
  const document = specForOperations(spec, operations);
  return (
    <div className="api-reference not-prose">
      <OpenAPIPage
        document={DOCUMENT_ID}
        // fumadocs-openapi's Document type is stricter than our snapshot's.
        preloaded={{ docs: { [DOCUMENT_ID]: document as never } }}
        operations={operations}
        showTitle={false}
        showDescription
      />
    </div>
  );
}
