// All logging goes to stderr — stdout is reserved for MCP JSON-RPC in serve mode

export const logger = {
  info: (...args: unknown[]) => console.error("[released]", ...args),
  warn: (...args: unknown[]) => console.error("[released] WARN:", ...args),
  error: (...args: unknown[]) => console.error("[released] ERROR:", ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.error("[released] DEBUG:", ...args);
  },
};
