import { createHash } from "crypto";
import type { Adapter, RawRelease } from "@releases/adapters/types";
import { github } from "./github.js";
import { scrape } from "./scrape.js";
import { feed } from "./feed.js";
import { agent } from "./agent.js";

export function getAdapter(type: string): Adapter | null {
  switch (type) {
    case "github": return github;
    case "scrape": return scrape;
    case "feed": return feed;
    case "agent": return agent;
    default: return null;
  }
}

export function contentHash(raw: RawRelease): string {
  const input = raw.title + (raw.version || "") + (raw.publishedAt?.toISOString() || "") + raw.content;
  return createHash("sha256").update(input).digest("hex");
}
