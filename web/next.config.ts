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
  transpilePackages: ["@releases/core"],
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
      "@shared/api/*": "../src/api/*",
      "@shared/*": "../src/lib/*",
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@shared/api": path.resolve(__dirname, "../src/api"),
      "@shared": path.resolve(__dirname, "../src/lib"),
    };
    return config;
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
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https:; font-src 'self' https:; connect-src 'self' https:; frame-ancestors 'none'",
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
