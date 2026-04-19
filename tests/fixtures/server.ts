import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";

const FEEDS_DIR = join(import.meta.dirname, "feeds");

export interface FixtureRoute {
  body: string;
  contentType: string;
  status?: number;
  headers?: Record<string, string>;
}

/** Create a Bun.serve fetch handler from a route map. */
export function createRouteHandler(routes: Record<string, FixtureRoute>) {
  return function fetch(req: Request): Response {
    const url = new URL(req.url);
    const route = routes[url.pathname];
    if (route) {
      return new Response(route.body, {
        status: route.status ?? 200,
        headers: {
          "Content-Type": route.contentType,
          ...route.headers,
        },
      });
    }
    return new Response("Not Found", { status: 404 });
  };
}

export interface FixtureServer {
  url: string;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
}

/**
 * Start a local HTTP server for test fixtures.
 * Only works with async tests — spawnSync will deadlock this server.
 */
export function startFixtureServer(options?: {
  routes?: Record<string, FixtureRoute>;
}): FixtureServer {
  const routes = options?.routes ?? {};

  const server = Bun.serve({
    port: 0,
    fetch: createRouteHandler(routes),
  });

  const port = server.port!;
  return {
    url: `http://localhost:${port}`,
    port,
    server,
    stop: () => server.stop(),
  };
}

/** Read a feed fixture file from tests/fixtures/feeds/ */
export function readFeedFixture(name: string): string {
  return readFileSync(join(FEEDS_DIR, name), "utf-8");
}

export interface SubprocessFixtureServer {
  url: string;
  port: number;
  stop: () => void;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Start a fixture server in a separate subprocess so that spawnSync-based
 * CLI helpers don't deadlock the server's event loop.
 */
export function startSubprocessFixtureServer(options?: {
  routes?: Record<string, FixtureRoute>;
}): SubprocessFixtureServer {
  const routes = options?.routes ?? {};
  const tmpDir = mkdtempSync(join(tmpdir(), "releases-fixture-server-"));
  const configPath = join(tmpDir, "routes.json");
  const portFilePath = join(tmpDir, "port.txt");
  writeFileSync(configPath, JSON.stringify(routes));

  const runnerPath = join(import.meta.dirname, "server-runner.ts");
  const proc = Bun.spawn(["bun", runnerPath, configPath, portFilePath], {
    stdout: "ignore",
    stderr: "ignore",
  });

  // Poll for the port file (written by the runner once the server is listening)
  let port: number | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const contents = readFileSync(portFilePath, "utf-8").trim();
      port = parseInt(contents, 10);
      if (!isNaN(port) && port > 0) break;
    } catch {
      // file not yet written — keep polling
    }
    sleepMs(50);
  }

  if (!port) {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error("startSubprocessFixtureServer: timed out waiting for port file");
  }

  return {
    url: `http://localhost:${port}`,
    port,
    stop() {
      proc.kill();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
