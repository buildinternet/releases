/**
 * AI SDK v7 `DecisionModel` adapter for providers that implement
 * `experimental_evaluate`, including OpenRouter's Decisions API.
 */

import { experimental_evaluate, type Experimental_EvaluationModel } from "ai";
import type {
  DecisionChoiceQuestion,
  DecisionModel,
  DecisionModelRequest,
  DecisionModelResult,
} from "./decision-model";

type AisdkDecisionQuestion<OPTION extends string> = DecisionChoiceQuestion<OPTION> & {
  type: "choice";
};

export interface AisdkDecisionEvaluateRequest<OPTION extends string> {
  model: Experimental_EvaluationModel;
  state: string;
  questions: { decision: AisdkDecisionQuestion<OPTION> };
  maxRetries: number;
  abortSignal: AbortSignal;
}

export interface AisdkDecisionEvaluateResult<OPTION extends string> {
  answers: {
    decision: {
      type: "choice";
      choice: OPTION;
      probabilities?: Record<OPTION, number>;
    };
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  providerMetadata?: unknown;
}

/** Injectable to keep unit tests independent from the AI SDK module. */
export type AisdkDecisionEvaluate = <OPTION extends string>(
  request: AisdkDecisionEvaluateRequest<OPTION>,
) => Promise<AisdkDecisionEvaluateResult<OPTION>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerMetadata(metadata: unknown): { confidence?: number; costUsd?: number } {
  const openrouter = asRecord(asRecord(metadata)?.openrouter);
  const answer = asRecord(asRecord(openrouter?.answers)?.decision);
  const usage = asRecord(openrouter?.usage);
  const confidence = answer?.confidence;
  const costUsd = usage?.cost;
  return {
    ...(typeof confidence === "number" ? { confidence } : {}),
    ...(typeof costUsd === "number" ? { costUsd } : {}),
  };
}

const defaultEvaluate: AisdkDecisionEvaluate = async <OPTION extends string>({
  model,
  state,
  questions,
  maxRetries,
  abortSignal,
}: AisdkDecisionEvaluateRequest<OPTION>) => {
  const result = await experimental_evaluate({ model, state, questions, maxRetries, abortSignal });
  const answer = result.answers.decision;
  if (answer.type !== "choice") {
    throw new TypeError("Decision model returned a non-choice answer.");
  }
  return {
    answers: {
      decision: {
        type: "choice",
        choice: answer.choice as OPTION,
        ...(answer.probabilities
          ? { probabilities: answer.probabilities as Record<OPTION, number> }
          : {}),
      },
    },
    usage: result.usage,
    providerMetadata: result.providerMetadata,
  };
};

export interface AisdkDecisionModelOpts {
  evaluate?: AisdkDecisionEvaluate;
  /** Bound one-shot decisions like text completions (30 seconds by default). */
  timeoutMs?: number;
}

/** Wrap a ready AI SDK evaluation model as a typed-choice `DecisionModel`. */
export function aisdkDecisionModel(
  model: Experimental_EvaluationModel,
  id: string,
  opts?: AisdkDecisionModelOpts,
): DecisionModel {
  const evaluate = opts?.evaluate ?? defaultEvaluate;
  return {
    id,
    async decide<OPTION extends string>(
      request: DecisionModelRequest<OPTION>,
    ): Promise<DecisionModelResult<OPTION>> {
      const result = await evaluate({
        model,
        state: request.state,
        questions: { decision: { type: "choice", ...request.question } },
        // Callers own retry/fail-open policy; avoid retrying a paid decision internally.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
      });
      const answer = result.answers.decision;
      const metadata = providerMetadata(result.providerMetadata);
      return {
        choice: answer.choice,
        ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
        ...(metadata.confidence !== undefined ? { confidence: metadata.confidence } : {}),
        usage: {
          ...(result.usage.inputTokens !== undefined
            ? { inputTokens: result.usage.inputTokens }
            : {}),
          ...(result.usage.outputTokens !== undefined
            ? { outputTokens: result.usage.outputTokens }
            : {}),
          ...(result.usage.totalTokens !== undefined
            ? { totalTokens: result.usage.totalTokens }
            : {}),
          ...(metadata.costUsd !== undefined ? { costUsd: metadata.costUsd } : {}),
        },
      };
    },
  };
}
