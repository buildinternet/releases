/**
 * Web-side re-export of the shared formatters.
 *
 * The canonical formatting logic lives in src/lib/formatters.ts (project root)
 * so the CLI and web produce identical output.
 */
export {
  sourceToMarkdown,
  orgToMarkdown,
} from "@shared/formatters";

export type {
  FormatSourceDetail,
  FormatOrgDetail,
  FormatOptions,
} from "@shared/formatters";
