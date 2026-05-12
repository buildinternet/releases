import type { Metadata } from "next";
import Script from "next/script";
import { getLoadedDoc } from "@/lib/docs-manifest";

const SLUG = "api/rest";
// `NEXT_PUBLIC_OPENAPI_URL` lets a developer iterating on spec annotations in
// `workers/api/` point Scalar at a local or staging spec instead of the prod
// host. Baked in at build time. Falls back to prod.
const OPENAPI_URL =
  process.env.NEXT_PUBLIC_OPENAPI_URL ?? "https://api.releases.sh/v1/openapi.json";
const SCALAR_CONFIG = JSON.stringify({ theme: "default", hideClientButton: true });

export function generateMetadata(): Metadata {
  const { frontmatter } = getLoadedDoc(SLUG);
  return { title: frontmatter.title, description: frontmatter.description };
}

// The page mounts Scalar against the live `/v1/openapi.json`. Hand-written
// markdown drifted from the spec as routes were added (issue #894); the
// auto-generated reference can never drift.
//
// Scalar is loaded via the same jsdelivr `<script>` tag that the API worker
// uses (`workers/api/src/openapi.ts`). Pinned to `@scalar/api-reference@1` so a
// breaking 2.x release doesn't silently swap in. The placeholder `<script
// id="api-reference">` element is a config carrier — Scalar reads its data
// attributes and mounts in its place.
export default function RestApiReferencePage() {
  return (
    <div className="not-prose">
      <script id="api-reference" data-url={OPENAPI_URL} data-configuration={SCALAR_CONFIG} />
      <Script
        src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"
        strategy="afterInteractive"
      />
    </div>
  );
}
