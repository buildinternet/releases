import { describe, expect, test } from "bun:test";
import { clusterChangesets, type ClusterInput } from "./changesets-cluster";

// Real bodies pulled from the Vercel AI SDK and Vercel CLI sources on
// 2026-05-13. Two distinct changesets in one batch — cascade `e76a29a`
// (AI SDK) and cascade `d874af6` (Vercel CLI).

const VERCEL_AI_SDK_BATCH: ClusterInput[] = [
  {
    id: "rel_ai_open_responses",
    version: "@ai-sdk/open-responses@1.0.16",
    content:
      "### Patch Changes\n\n-   16a5de5: fix(open-responses): map non-image file parts to input_file\n",
  },
  {
    id: "rel_ai_vue",
    version: "@ai-sdk/vue@3.0.182",
    content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
  },
  {
    id: "rel_ai_svelte",
    version: "@ai-sdk/svelte@4.0.182",
    content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
  },
  {
    id: "rel_ai_rsc",
    version: "@ai-sdk/rsc@2.0.182",
    content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
  },
  {
    id: "rel_ai_react",
    version: "@ai-sdk/react@3.0.184",
    content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
  },
  {
    id: "rel_ai_llamaindex",
    version: "@ai-sdk/llamaindex@2.0.182",
    content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
  },
  {
    id: "rel_ai_langchain",
    version: "@ai-sdk/langchain@2.0.188",
    content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
  },
  {
    id: "rel_ai_angular",
    version: "@ai-sdk/angular@2.0.183",
    content: "### Patch Changes\n\n-   Updated dependencies [e76a29a]\n    -   ai@6.0.182\n",
  },
  {
    id: "rel_ai_core",
    version: "ai@6.0.182",
    content: "### Patch Changes\n\n-   e76a29a: fix(ai): download tool-result file URLs\n",
  },
];

const VERCEL_CLI_BATCH: ClusterInput[] = [
  {
    id: "rel_vc_static_build",
    version: "@vercel/static-build@2.9.26",
    content: "### Patch Changes\n\n-   @vercel/gatsby-plugin-vercel-builder@2.2.4\n",
  },
  {
    id: "rel_vc_python",
    version: "@vercel/python@6.41.0",
    content:
      "### Minor Changes\n\n-   bf42168: Provide better suggestion for how to fix entry point error\n\n### Patch Changes\n\n-   94a214c: Use copy link mode for injected uv pip installs to avoid cross-device cache clone failures.\n",
  },
  {
    id: "rel_vc_node",
    version: "@vercel/node@5.8.1",
    content:
      "### Patch Changes\n\n-   Updated dependencies [d874af6]\n    -   @vercel/build-utils@13.24.0\n",
  },
  {
    id: "rel_vc_nestjs",
    version: "@vercel/nestjs@0.2.81",
    content: "### Patch Changes\n\n-   @vercel/node@5.8.1\n",
  },
  {
    id: "rel_vc_koa",
    version: "@vercel/koa@0.1.60",
    content: "### Patch Changes\n\n-   @vercel/node@5.8.1\n",
  },
  {
    id: "rel_vc_hono",
    version: "@vercel/hono@0.2.80",
    content: "### Patch Changes\n\n-   @vercel/node@5.8.1\n",
  },
  {
    id: "rel_vc_h3",
    version: "@vercel/h3@0.1.86",
    content: "### Patch Changes\n\n-   @vercel/node@5.8.1\n",
  },
  {
    id: "rel_vc_gatsby",
    version: "@vercel/gatsby-plugin-vercel-builder@2.2.4",
    content:
      "### Patch Changes\n\n-   Updated dependencies [d874af6]\n    -   @vercel/build-utils@13.24.0\n",
  },
  {
    id: "rel_vc_fs_detectors",
    version: "@vercel/fs-detectors@6.3.0",
    content:
      "### Minor Changes\n\n-   d874af6: Add support for env vars injection that reference other services in `services` with an explicit `env` configuration.\n\n### Patch Changes\n\n-   Updated dependencies [d874af6]\n    -   @vercel/build-utils@13.24.0\n",
  },
  {
    id: "rel_vc_fastify",
    version: "@vercel/fastify@0.1.80",
    content: "### Patch Changes\n\n-   @vercel/node@5.8.1\n",
  },
  {
    id: "rel_vc_express",
    version: "@vercel/express@0.1.87",
    content: "### Patch Changes\n\n-   @vercel/node@5.8.1\n-   @vercel/cervel@0.1.4\n",
  },
  {
    id: "rel_vc_elysia",
    version: "@vercel/elysia@0.1.77",
    content: "### Patch Changes\n\n-   @vercel/node@5.8.1\n",
  },
  {
    id: "rel_vc_config",
    version: "@vercel/config@0.4.0",
    content:
      "### Minor Changes\n\n-   d874af6: Add support for env vars injection that reference other services in `services` with an explicit `env` configuration.\n",
  },
  {
    id: "rel_vc_client",
    version: "@vercel/client@17.5.0",
    content:
      "### Minor Changes\n\n-   d874af6: Add support for env vars injection that reference other services in `services` with an explicit `env` configuration.\n\n### Patch Changes\n\n-   Updated dependencies [d874af6]\n    -   @vercel/build-utils@13.24.0\n",
  },
  {
    id: "rel_vc_cli_main",
    version: "vercel@54.0.0",
    content:
      "### Major Changes\n\n-   db207b1: Require `--follow` for `vercel logs` to stream deployment logs.\n\n### Minor Changes\n\n-   d874af6: Add support for env vars injection that reference other services.\n",
  },
];

describe("clusterChangesets — AI SDK cascade", () => {
  test("groups the e76a29a cascade with ai@6.0.182 as canonical", () => {
    const clusters = clusterChangesets(VERCEL_AI_SDK_BATCH);
    expect(clusters).toHaveLength(1);
    const [c] = clusters;
    expect(c.hash).toBe("e76a29a");
    expect(c.canonicalId).toBe("rel_ai_core");
    expect(c.coverageIds.toSorted()).toEqual(
      [
        "rel_ai_angular",
        "rel_ai_langchain",
        "rel_ai_llamaindex",
        "rel_ai_react",
        "rel_ai_rsc",
        "rel_ai_svelte",
        "rel_ai_vue",
      ].toSorted(),
    );
  });

  test("does not pull in the unrelated open-responses release", () => {
    const clusters = clusterChangesets(VERCEL_AI_SDK_BATCH);
    const allCovered = new Set(clusters.flatMap((c) => c.coverageIds));
    expect(allCovered.has("rel_ai_open_responses")).toBe(false);
  });
});

describe("clusterChangesets — Vercel CLI cascade", () => {
  test("groups d874af6 with sibling-reference resolution", () => {
    const clusters = clusterChangesets(VERCEL_CLI_BATCH);
    expect(clusters).toHaveLength(1);
    const [c] = clusters;
    expect(c.hash).toBe("d874af6");

    // Substantive bodies: fs-detectors, config, client, cli_main. Canonical
    // should be whichever has the longest content — vercel@54.0.0 has the
    // Major + Minor sections, so it wins on length.
    expect(c.canonicalId).toBe("rel_vc_cli_main");

    // All other releases that ultimately roll up to d874af6 (directly via
    // "Updated dependencies [d874af6]" or transitively via sibling refs to
    // @vercel/node or @vercel/gatsby-plugin-vercel-builder) become coverage.
    const expectedCoverage = [
      "rel_vc_static_build", // refs gatsby → d874af6
      "rel_vc_node", // direct hash
      "rel_vc_nestjs", // refs @vercel/node → d874af6
      "rel_vc_koa",
      "rel_vc_hono",
      "rel_vc_h3",
      "rel_vc_gatsby",
      "rel_vc_fs_detectors",
      "rel_vc_fastify",
      "rel_vc_express",
      "rel_vc_elysia",
      "rel_vc_config",
      "rel_vc_client",
    ];
    expect(c.coverageIds.toSorted()).toEqual(expectedCoverage.toSorted());
  });

  test("leaves the standalone python release out of the cluster", () => {
    const clusters = clusterChangesets(VERCEL_CLI_BATCH);
    const allCovered = new Set(clusters.flatMap((c) => c.coverageIds));
    expect(allCovered.has("rel_vc_python")).toBe(false);
  });
});

describe("clusterChangesets — edge cases", () => {
  test("returns no clusters when nothing cascades", () => {
    const clusters = clusterChangesets([
      {
        id: "rel_a",
        version: "pkg@1.0.0",
        content: "### Minor Changes\n\n-   abc1234: brand new feature\n",
      },
      {
        id: "rel_b",
        version: "pkg2@2.0.0",
        content: "### Patch Changes\n\n-   def5678: bug fix\n",
      },
    ]);
    expect(clusters).toEqual([]);
  });

  test("returns no clusters for a single-release batch", () => {
    expect(
      clusterChangesets([
        {
          id: "rel_solo",
          version: "ai@6.0.182",
          content: "### Patch Changes\n\n-   e76a29a: fix(ai): download tool-result file URLs\n",
        },
      ]),
    ).toEqual([]);
  });

  test("ignores non-changesets bodies", () => {
    // GitHub release notes, blog posts — anything not in changesets shape.
    const clusters = clusterChangesets([
      { id: "a", version: null, content: "We shipped a new feature today." },
      { id: "b", version: null, content: "Another announcement about pricing." },
      { id: "c", version: null, content: "Bug fixes and improvements." },
    ]);
    expect(clusters).toEqual([]);
  });

  test("only-Updated-deps cascade (no substantive sibling in batch) still groups", () => {
    // Pathological case: every release in the batch is a cascade row;
    // none carries the substantive `HASH: description` bullet. Cluster
    // them anyway with the longest body as canonical — better than letting
    // 5 noise rows dominate the feed.
    const clusters = clusterChangesets([
      {
        id: "a",
        version: "@scope/a@1.0.0",
        content: "### Patch Changes\n\n-   Updated dependencies [abc1234]\n    -   root@1.0.0\n",
      },
      {
        id: "b",
        version: "@scope/b@1.0.0",
        content: "### Patch Changes\n\n-   Updated dependencies [abc1234]\n    -   root@1.0.0\n",
      },
      {
        id: "c",
        version: "@scope/c@1.0.0",
        content:
          "### Patch Changes\n\n-   Updated dependencies [abc1234]\n    -   root@1.0.0\n    -   extra note that makes this longer\n",
      },
    ]);
    expect(clusters).toHaveLength(1);
    const [cl] = clusters;
    expect(cl.hash).toBe("abc1234");
    expect(cl.canonicalId).toBe("c");
    expect(cl.coverageIds.toSorted()).toEqual(["a", "b"]);
  });

  test("overlapping-hash batch: largest cluster wins, shared release is its canonical", () => {
    // Release `root` is substantive for both hashes — aaa111 (3 members
    // total) and bbb222 (2 members total). aaa111 is the bigger cluster
    // so it claims `root` as canonical and bbb222 cannot form (root is
    // already assigned). `solo` (the leftover bbb222 cascade) still gets
    // attached to aaa111 via Pass 2's sibling-reference resolution
    // because its sub-bullet points at `root@1.0.0`.
    const clusters = clusterChangesets([
      {
        id: "root",
        version: "root@1.0.0",
        content:
          "### Minor Changes\n\n-   aaa111: feature A in the root package\n-   bbb222: feature B in the root package\n",
      },
      {
        id: "a1",
        version: "@scope/a1@1.0.0",
        content: "### Patch Changes\n\n-   Updated dependencies [aaa111]\n    -   root@1.0.0\n",
      },
      {
        id: "a2",
        version: "@scope/a2@1.0.0",
        content: "### Patch Changes\n\n-   Updated dependencies [aaa111]\n    -   root@1.0.0\n",
      },
      {
        id: "solo",
        version: "@scope/solo@1.0.0",
        content: "### Patch Changes\n\n-   Updated dependencies [bbb222]\n    -   root@1.0.0\n",
      },
    ]);

    expect(clusters).toHaveLength(1);
    const [cl] = clusters;
    expect(cl.hash).toBe("aaa111");
    expect(cl.canonicalId).toBe("root");
    expect(cl.coverageIds.toSorted()).toEqual(["a1", "a2", "solo"]);
  });
});
