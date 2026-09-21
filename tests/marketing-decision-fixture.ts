/** Complete Decisions API distribution, consumed through the real AI SDK validator. */
export function marketingDecisionResponse(choice: string, probability: number) {
  const probabilities: Record<string, number> = {
    real_product_news: 0,
    case_study: 0,
    newsletter: 0,
    event_recap: 0,
    partner_announcement: 0,
    positioning_piece: 0,
    localized_marketing: 0,
    unclear_other: 0,
  };
  probabilities[choice === "real_product_news" ? "unclear_other" : "real_product_news"] =
    1 - probability;
  probabilities[choice] = probability;
  return {
    answers: { decision: { type: "choice", choice, probabilities } },
    usage: { input_tokens: 12, output_tokens: 2, cost: 0.001 },
  };
}
