// Nearest-rank percentile on a copy of the samples.
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1]!;
}

export function summary(xs: number[]) {
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: xs.length,
    p50: round(percentile(xs, 50)),
    p95: round(percentile(xs, 95)),
    p99: round(percentile(xs, 99)),
    min: xs.length ? round(Math.min(...xs)) : null,
    max: xs.length ? round(Math.max(...xs)) : null,
    mean: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
  };
}
