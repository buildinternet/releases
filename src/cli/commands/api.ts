import { Command } from "commander";
import { startApiServer } from "../../api/server.js";

export function registerApiCommand(
  program: Command,
  opts?: { commandName?: string },
) {
  program
    .command(opts?.commandName ?? "api")
    .description("Start the read-only JSON API server")
    .option("--port <port>", "Port to listen on", "3456")
    .addHelpText("after", `
Examples:
  releases admin api serve
  releases admin api serve --port 8080`)
    .action((opts: { port: string }) => {
      const port = parseInt(opts.port, 10) || parseInt(process.env.RELEASED_API_PORT ?? "3456", 10);
      startApiServer(port);
    });
}
