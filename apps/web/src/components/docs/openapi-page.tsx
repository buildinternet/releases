"use client";

import { createOpenAPIPage } from "fumadocs-openapi/ui";

/**
 * fumadocs-openapi's operation renderer (params, schemas, code samples, and the
 * "try it" playground). A client component; `APIPage` feeds it the spec.
 */
export const OpenAPIPage = createOpenAPIPage();
