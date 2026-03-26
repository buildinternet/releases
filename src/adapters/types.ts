import type { Source } from "../db/schema.js";

export interface RawRelease {
  version?: string;
  title: string;
  content: string;
  url?: string;
  publishedAt?: Date;
  isBreaking?: boolean;
}

export interface FetchOptions {
  /** Only fetch releases published after this date */
  since?: Date;
  /** Maximum number of releases to fetch */
  maxEntries?: number;
}

export interface Adapter {
  fetch(source: Source, options?: FetchOptions): Promise<RawRelease[]>;
}
