/**
 * Provider-agnostic typed-choice seam for decision models. Unlike `TextModel`,
 * a decision model classifies one shared state against named options and can
 * retain the provider's probability and confidence signals.
 */

export interface DecisionChoiceQuestion<OPTION extends string> {
  instructions: string;
  criteria: Readonly<Record<OPTION, string>>;
}

export interface DecisionModelRequest<OPTION extends string> {
  state: string;
  question: DecisionChoiceQuestion<OPTION>;
}

export interface DecisionModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface DecisionModelResult<OPTION extends string> {
  choice: OPTION;
  probabilities?: Readonly<Record<OPTION, number>>;
  confidence?: number;
  usage: DecisionModelUsage;
}

/** Operator-facing scores: selected-option probability and provider confidence
 * are independent signals. Missing or nonfinite scores remain absent. */
export interface DecisionDiagnostics {
  choice: string;
  selectedChoiceProbability?: number;
  providerConfidence?: number;
}

export function decisionDiagnostics<OPTION extends string>(
  result: DecisionModelResult<OPTION>,
): DecisionDiagnostics {
  const probability = result.probabilities?.[result.choice];
  return {
    choice: result.choice,
    ...(typeof probability === "number" && Number.isFinite(probability)
      ? { selectedChoiceProbability: probability }
      : {}),
    ...(typeof result.confidence === "number" && Number.isFinite(result.confidence)
      ? { providerConfidence: result.confidence }
      : {}),
  };
}

export interface DecisionModel {
  /** `<provider>:<model>` — used for telemetry / log attribution. */
  readonly id: string;
  decide<OPTION extends string>(
    request: DecisionModelRequest<OPTION>,
  ): Promise<DecisionModelResult<OPTION>>;
}

/**
 * One yes/no question on a shared state. The AI SDK spells this `boolean`;
 * JEV and OpenRouter's Decisions API spell it `noul`. `criteria.true` is the
 * positive option. The answer probability is P(true) — the selected-choice
 * probability of that option, not provider confidence.
 */
export interface NoulQuestion {
  id: string;
  instructions: string;
  criteria: { true: string; false: string };
}

export interface NoulAnswer {
  id: string;
  /** P(true). Absent when the provider omits it or returns a non-finite value. */
  probability?: number;
}

export interface NoulBatchRequest {
  state: string;
  questions: NoulQuestion[];
}

export interface NoulBatchResult {
  answers: NoulAnswer[];
  usage: DecisionModelUsage;
}

/** Multi-question noul call. One shared state, one provider round trip. */
export interface NoulBatchModel {
  readonly id: string;
  decideNoul(request: NoulBatchRequest): Promise<NoulBatchResult>;
}
