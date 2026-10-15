// Minimal ambient module so this package typechecks without depending on
// `@cloudflare/workers-types`. Worker apps resolve the real module; a missing
// `getActiveSpan` export is handled at runtime.
declare module "cloudflare:workers" {
  export const tracing: {
    getActiveSpan?: () => { setAttribute(key: string, value: string): void } | undefined;
  };
}
