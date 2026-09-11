/**
 * Anthropic first-party API rates, USD per million tokens.
 *
 * Used to answer "what would this have cost on the API instead of a
 * subscription". Cache writes bill at 1.25x input and cache reads at 0.1x,
 * except where a model publishes its own cache-read rate.
 *
 * Partner platforms (Bedrock, Vertex) price separately and are not modelled.
 * Rates as published 2026-06; see README for how to refresh.
 */
export interface Rate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const rate = (input: number, output: number, cacheRead?: number): Rate => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead: cacheRead ?? input * 0.1,
});

export const RATES: Record<string, Rate> = {
  'claude-fable-5-1': rate(10, 50, 0.25),
  'claude-mythos-5-1': rate(10, 50, 0.25),
  'claude-fable-5': rate(10, 50),
  'claude-opus-5': rate(5, 25),
  'claude-opus-4-8': rate(5, 25),
  'claude-opus-4-7': rate(5, 25),
  'claude-opus-4-6': rate(5, 25),
  'claude-sonnet-5': rate(2, 10),
  'claude-sonnet-4-6': rate(3, 15),
  'claude-haiku-4-5': rate(1, 5),
};

/** Fall back to the nearest family so an unseen snapshot still prices. */
export function rateFor(model: string): Rate | null {
  if (RATES[model]) return RATES[model]!;
  const base = model.replace(/-\d{8}$/, '');
  if (RATES[base]) return RATES[base]!;
  if (/fable|mythos/.test(model)) return RATES['claude-fable-5']!;
  if (/opus/.test(model)) return RATES['claude-opus-5']!;
  if (/sonnet/.test(model)) return RATES['claude-sonnet-5']!;
  if (/haiku/.test(model)) return RATES['claude-haiku-4-5']!;
  return null;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function costOf(model: string, t: TokenCounts): number | null {
  const r = rateFor(model);
  if (!r) return null;
  return (
    (t.input * r.input +
      t.output * r.output +
      t.cacheWrite * r.cacheWrite +
      t.cacheRead * r.cacheRead) /
    1_000_000
  );
}
