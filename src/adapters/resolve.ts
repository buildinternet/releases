import type { Adapter } from "@releases/adapters/types";
import { github } from "@releases/adapters/github";
import { scrape } from "./scrape.js";
import { feed } from "./feed.js";
import { agent } from "./agent.js";

export function getAdapter(type: string): Adapter | null {
  switch (type) {
    case "github":
      return github;
    case "scrape":
      return scrape;
    case "feed":
      return feed;
    case "agent":
      return agent;
    default:
      return null;
  }
}
