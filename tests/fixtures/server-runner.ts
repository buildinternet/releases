/**
 * Standalone subprocess HTTP server for test fixtures.
 * Reads routes from argv[2], serves on auto-assigned port, writes port to argv[3].
 */

import { readFileSync, writeFileSync } from "fs";
import { createRouteHandler, type FixtureRoute } from "./server.js";

const configPath = process.argv[2];
const portFilePath = process.argv[3];

if (!configPath || !portFilePath) {
  process.stderr.write("Usage: server-runner.ts <config-file> <port-file>\n");
  process.exit(1);
}

const routes: Record<string, FixtureRoute> = JSON.parse(readFileSync(configPath, "utf-8"));

const server = Bun.serve({
  port: 0,
  fetch: createRouteHandler(routes),
});

writeFileSync(portFilePath, String(server.port));
