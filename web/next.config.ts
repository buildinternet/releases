import type { NextConfig } from "next";
import path from "path";

const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";
let apiHostname: string;
try {
  apiHostname = new URL(apiUrl).hostname;
} catch {
  apiHostname = "localhost";
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, ".."),
  experimental: {
    viewTransition: true,
  },
  transpilePackages: [
    "@buildinternet/releases-core",
    "@buildinternet/releases-api-types",
    "@releases/rendering",
  ],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "github.com", pathname: "/*.png" },
      { protocol: "https", hostname: "*.githubusercontent.com" },
      { protocol: apiHostname === "localhost" ? "http" : "https", hostname: apiHostname },
      { protocol: "https", hostname: "media.releases.sh" },
    ],
  },
  turbopack: {
    root: path.resolve(__dirname, ".."),
    resolveAlias: {
      "@buildinternet/releases-api-types": "../packages/api-types/src/api-types.ts",
      "@releases/lib/*": "../packages/lib/src/*",
      "@releases/rendering/*": "../packages/rendering/src/*",
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@buildinternet/releases-api-types": path.resolve(
        __dirname,
        "../packages/api-types/src/api-types.ts",
      ),
      "@releases/lib": path.resolve(__dirname, "../packages/lib/src"),
      "@releases/rendering": path.resolve(__dirname, "../packages/rendering/src"),
    };
    return config;
  },
  async redirects() {
    // Legacy `?tab=` handling for org/source pages lives in the page
    // components themselves — a config-level `:orgSlug` redirect would
    // greedy-match top-level routes like /status or /docs and dead-end them.
    return [
      { source: "/mcp", destination: "/docs/api/mcp", statusCode: 302 },
      { source: "/status", destination: "/admin/status", permanent: true },
      { source: "/status/:path*", destination: "/admin/status/:path*", permanent: true },
    ];
  },
  async rewrites() {
    // `/docs/*.md` and Accept-based markdown negotiation are handled by the
    // Vercel routing middleware in `src/proxy.ts`. We only need to map the
    // agent-discovery entry points here.
    return [
      { source: "/llms.txt", destination: "/api/llms" },
      { source: "/llms-full.txt", destination: "/api/llms-full" },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            // `cdn.jsdelivr.net` carries the pinned Scalar bundle mounted by
            // `/docs/api/rest`. The same origin is used by the API worker at
            // `workers/api/src/openapi.ts`. style-src adds it too because
            // Scalar injects its stylesheet from the same CDN.
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' https: data:; media-src 'self' https:; font-src 'self' https: data:; connect-src 'self' https: wss:; frame-ancestors 'none'",
          },
        ],
      },
      {
        source: "/((?!_next/).*)",
        headers: [{ key: "Vary", value: "Accept" }],
      },
      {
        source: "/",
        headers: [
          {
            key: "Link",
            value:
              '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json", </docs/api>; rel="service-doc"; type="text/html"',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
