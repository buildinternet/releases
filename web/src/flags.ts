import { flag } from "flags/next";
import { vercelAdapter } from "@flags-sdk/vercel";

export const publicDocs = flag<boolean>({
  key: "public-docs",
  description: "Controls whether public documentation pages are accessible",
  adapter: vercelAdapter(),
  defaultValue: process.env.NODE_ENV === "development",
});

export const statusDashboard = flag<boolean>({
  key: "status-dashboard",
  description: "Controls access to the internal status dashboard",
  adapter: vercelAdapter(),
  defaultValue: process.env.NODE_ENV === "development",
});
