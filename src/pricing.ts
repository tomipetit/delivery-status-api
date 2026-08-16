/**
 * Cost estimation for billed model calls.
 *
 * Rates are configuration, not constants: OpenAI changes them (Terra dropped to
 * $2/$12 on 2026-07-30), and a number baked into the source goes stale silently
 * while the report keeps looking authoritative.
 */

export interface ModelPricing {
  /** USD per 1M uncached input tokens. */
  inputPerMillion: number;
  /** USD per 1M cached input tokens. */
  cachedInputPerMillion: number;
  /** USD per 1M output tokens, reasoning tokens included. */
  outputPerMillion: number;
}

/**
 * Published gpt-5.6-terra rates, used when the vars are unset or unparseable.
 * Kept as a fallback so a misconfigured var degrades to a plausible figure
 * rather than to zero, which would read as "this cost nothing".
 */
export const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 2,
  cachedInputPerMillion: 0.2,
  outputPerMillion: 12,
};

export interface PricingVars {
  OPENAI_PRICE_INPUT_USD_PER_MTOK?: string;
  OPENAI_PRICE_CACHED_INPUT_USD_PER_MTOK?: string;
  OPENAI_PRICE_OUTPUT_USD_PER_MTOK?: string;
}

function rate(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[pricing] ${name}="${value}" is not a usable rate; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function pricingFromVars(vars: PricingVars): ModelPricing {
  return {
    inputPerMillion: rate(
      vars.OPENAI_PRICE_INPUT_USD_PER_MTOK,
      DEFAULT_PRICING.inputPerMillion,
      "OPENAI_PRICE_INPUT_USD_PER_MTOK",
    ),
    cachedInputPerMillion: rate(
      vars.OPENAI_PRICE_CACHED_INPUT_USD_PER_MTOK,
      DEFAULT_PRICING.cachedInputPerMillion,
      "OPENAI_PRICE_CACHED_INPUT_USD_PER_MTOK",
    ),
    outputPerMillion: rate(
      vars.OPENAI_PRICE_OUTPUT_USD_PER_MTOK,
      DEFAULT_PRICING.outputPerMillion,
      "OPENAI_PRICE_OUTPUT_USD_PER_MTOK",
    ),
  };
}

export interface BilledTokens {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/**
 * Estimated USD for one or more calls.
 *
 * The Responses API nests both detail counts inside their parent totals:
 * cached_tokens is part of input_tokens, and reasoning_tokens is part of
 * output_tokens. So cached is subtracted from input and charged at its own
 * rate, and reasoning is never added separately — doing so would bill the
 * thinking twice.
 *
 * Not modelled: the long-context tier, which multiplies a request's rates once
 * its prompt passes 272K input tokens. Extractions are capped far below that
 * (EXTRACTION_INPUT_CHARACTER_LIMIT), so it cannot apply to the text path.
 */
export function estimateCostUsd(tokens: BilledTokens, pricing: ModelPricing): number {
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedTokens);
  return (
    uncachedInput * pricing.inputPerMillion
    + tokens.cachedTokens * pricing.cachedInputPerMillion
    + tokens.outputTokens * pricing.outputPerMillion
  ) / 1_000_000;
}

/** Small daily figures need more places than a currency normally shows. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
