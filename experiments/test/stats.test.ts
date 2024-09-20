import { describe, expect, it } from 'vitest';
import { percentile, summary } from '../src/lib/stats.js';

describe('percentile (nearest rank)', () => {
  it('matches hand-computed ranks', () => {
    const xs = [15, 20, 35, 40, 50];
    expect(percentile(xs, 50)).toBe(35);
    expect(percentile(xs, 95)).toBe(50);
    expect(percentile(xs, 0)).toBe(15);
    expect(percentile([], 50)).toBeNull();
  });

  it('does not reorder its input', () => {
    const xs = [3, 1, 2];
    summary(xs);
    expect(xs).toEqual([3, 1, 2]);
    expect(summary(xs)).toMatchObject({ n: 3, p50: 2, min: 1, max: 3, mean: 2 });
  });
});
