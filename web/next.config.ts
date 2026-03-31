import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
  webpack: (config) => {
    // Allow importing shared code from the parent src/lib directory
    config.resolve.alias = {
      ...config.resolve.alias,
      "@shared": path.resolve(__dirname, "../src/lib"),
    };
    return config;
  },
};

export default nextConfig;
