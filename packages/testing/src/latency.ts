/** Latency percentiles for journey timing assertions and load smoke summaries. */

export interface LatencySummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** Nearest-rank percentile; null for an empty sample, never zero. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (p <= 0 || p > 100) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] ?? null;
}

export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples.length === 0 ? null : Math.max(...samples),
  };
}
