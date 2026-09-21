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

export interface DecisionModel {
  /** `<provider>:<model>` — used for telemetry / log attribution. */
  readonly id: string;
  decide<OPTION extends string>(
    request: DecisionModelRequest<OPTION>,
  ): Promise<DecisionModelResult<OPTION>>;
}
