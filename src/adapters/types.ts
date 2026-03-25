import type { Source } from "../db/schema.js";

export interface RawRelease {
  version?: string;
  title: string;
  content: string;
  url?: string;
  publishedAt?: Date;
  isBreaking?: boolean;
}

export interface Adapter {
  fetch(source: Source): Promise<RawRelease[]>;
}
