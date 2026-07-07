import { builder } from "../builder.js";

export const StatsType = builder.objectType("Stats", {
  description: "Flat registry rollup (the homepage banner shape). See REST `/v1/stats`.",
  fields: (t) => ({
    orgs: t.exposeInt("orgs"),
    sources: t.exposeInt("sources"),
    releases: t.exposeInt("releases"),
  }),
});
