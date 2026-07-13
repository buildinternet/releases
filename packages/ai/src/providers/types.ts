// Provider-detection type definitions. See ./detect.ts for the pipeline and
// ./definitions.ts for the provider table.

export interface ProviderHints {
  /** Known feed path relative to the changelog page */
  feedPaths?: string[];
  /** Whether pages are available as raw markdown via .md suffix */
  markdownSuffix?: boolean;
  /** Suggested crawl pattern (relative to changelog root) */
  crawlPattern?: string;
  /** Preferred source type for this provider */
  preferredType?: "feed" | "scrape";
  /** Additional well-known changelog paths for this provider */
  changelogPaths?: string[];
  /** Whether this provider serves pre-rendered HTML (no JS needed for content) */
  staticContent?: boolean;
}

export interface DetectedProvider {
  id: string;
  name: string;
  hints: ProviderHints;
}

export interface ProviderDef {
  id: string;
  name: string;
  hints: ProviderHints;
  /** CNAME targets that identify this provider */
  cnames?: string[];
  /** Strings to match in HTTP response headers (header name → substring) */
  headers?: Record<string, string>;
  /** Strings to match in HTML <head> content */
  htmlPatterns?: string[];
  /** URL hostname patterns */
  hostPatterns?: RegExp[];
}
