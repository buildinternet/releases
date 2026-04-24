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
  transpilePackages: ["@buildinternet/releases-core", "@releases/api-types", "@releases/rendering"],
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
      "@releases/api-types": "../packages/api-types/src/api-types.ts",
      "@releases/lib/*": "../packages/lib/src/*",
      "@releases/rendering/*": "../packages/rendering/src/*",
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@releases/api-types": path.resolve(__dirname, "../packages/api-types/src/api-types.ts"),
      "@releases/lib": path.resolve(__dirname, "../packages/lib/src"),
      "@releases/rendering": path.resolve(__dirname, "../packages/rendering/src"),
    };
    return config;
  },
  async redirects() {
    return [{ source: "/mcp", destination: "/docs/api/mcp", statusCode: 302 }];
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
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https:; font-src 'self' https:; connect-src 'self' https: wss:; frame-ancestors 'none'",
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
