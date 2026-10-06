export interface TokenPrice {
  /** USD per token. */
  inputPerToken?: number;
  outputPerToken?: number;
}

/** Cost in USD for a token usage at a price, or null when the price or usage is unknown. */
export const computeCostUsd = (
  price: TokenPrice | undefined | null,
  usage: { inputTokens?: number; outputTokens?: number } | undefined | null,
): number | null => {
  if (!price || !usage || (price.inputPerToken === undefined && price.outputPerToken === undefined)) {
    return null;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return null;
  }
  return (
    (usage.inputTokens ?? 0) * (price.inputPerToken ?? 0) + (usage.outputTokens ?? 0) * (price.outputPerToken ?? 0)
  );
};

/** `$0.0053`, `$12.40`, or `<$0.0001` for tiny non-zero amounts. */
export const formatUsd = (amount: number): string => {
  if (amount === 0) {
    return '$0.00';
  }
  if (amount < 0.0001) {
    return '<$0.0001';
  }
  return amount >= 1 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
};

/** A per-token price shown per 1M tokens, e.g. 0.0000055 -> `$5.50`, 0.0000001 -> `$0.10`. */
export const formatUsdPerMillion = (perToken: number): string => `$${(perToken * 1_000_000).toFixed(2)}`;
