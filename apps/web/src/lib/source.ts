import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";

/**
 * Fumadocs content source for `/docs`: compiled MDX pages from
 * `src/content/docs/`, ordered by its `meta.json`. See `source.config.ts`.
 *
 * Imports the compiled MDX, so only page routes use it. Anything that needs
 * just frontmatter or raw text (sitemap, llms.txt, `.md` exports, tests) goes
 * through `@/lib/docs-manifest`, which reads the same files from disk.
 */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
