export const meta = {
  name: "eval-marketing-subagents",
  description:
    "Key-free marketing-classifier eval: one Haiku sub-agent per fixture, schema-validated verdicts, false-positive-weighted gate",
  whenToUse:
    "Run a free (no ANTHROPIC_API_KEY) smoke test of the marketing classifier prompt via sub-agents. Prep first: bun tests/evals/subagent-runner.ts prep marketing",
  phases: [{ title: "Classify", detail: "one Haiku sub-agent per fixture" }],
};

// Structured output — the schema forces a clean verdict, so unlike a free-text
// agent there is no tag/prose leakage to parse around.
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    isMarketing: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["isMarketing"],
};

// `args` may arrive as an object or as a JSON string depending on the caller;
// normalize both (the Workflow docs warn a stringified arg reaches the script
// as one string, so args.cases would be undefined without this parse).
let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    /* leave as-is; guard below reports the shape */
  }
}

const cases = (input && input.cases) || [];
const floor = input && typeof input.floor === "number" ? input.floor : 0.85;
const maxFalsePositives =
  input && typeof input.maxFalsePositives === "number" ? input.maxFalsePositives : 0;

if (!cases.length) {
  throw new Error(
    `no cases in args (typeof args=${typeof args}, keys=${input && typeof input === "object" ? Object.keys(input).join(",") : "none"}) — run: bun tests/evals/subagent-runner.ts prep marketing, then pass its JSON as args`,
  );
}

phase("Classify");
const verdicts = await parallel(
  cases.map(
    (c) => () =>
      agent(
        `Read the file ${c.file}. It contains a classifier instruction followed by a single changelog item. Apply the instruction to that item and return the verdict.`,
        { label: c.id, model: "haiku", schema: VERDICT_SCHEMA, phase: "Classify" },
      ).then((v) => ({
        id: c.id,
        expected: c.expected,
        predicted: !!v.isMarketing,
        reason: v.reason || null,
        // Echoed back (from prep's inline `item`) so `save --viewer` can render
        // the classified item next to its verdict. Optional; null if not prepped.
        item: c.item || null,
      })),
  ),
);

// Inline grading — mirrors tests/evals/graders.ts gradeBinary (the Workflow
// sandbox can't import repo modules). Keep the two in sync if either changes.
const graded = verdicts.filter(Boolean);
let correct = 0;
let falsePositives = 0; // predicted marketing, actually a real release -> real release hidden
let falseNegatives = 0; // predicted real, actually marketing -> marketing slipped through
for (const v of graded) {
  if (v.predicted === v.expected) correct++;
  else if (v.predicted && !v.expected) falsePositives++;
  else if (!v.predicted && v.expected) falseNegatives++;
}
const total = graded.length;
const accuracy = total > 0 ? correct / total : 0;
const pass = accuracy >= floor && falsePositives <= maxFalsePositives;

log(
  `Sub-agent marketing eval: ${correct}/${total} (${(accuracy * 100).toFixed(1)}%), FP=${falsePositives} FN=${falseNegatives} -> ${pass ? "PASS" : "FAIL"}`,
);

return {
  pass,
  accuracy,
  correct,
  total,
  falsePositives,
  falseNegatives,
  gate: { floor, maxFalsePositives },
  misses: graded.filter((v) => v.predicted !== v.expected),
  perCase: graded,
};
