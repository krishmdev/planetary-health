import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { until } from './components/states';

describe('until', () => {
  it('describes time left on a consent', () => {
    expect(until(new Date(Date.now() - 1000).toISOString())).toBe('expired');
    expect(until(new Date(Date.now() + 30 * 60_000).toISOString())).toBe('30 min left');
    expect(until(new Date(Date.now() + 5 * 3600_000).toISOString())).toBe('5 h left');
    expect(until(new Date(Date.now() + 10 * 86400_000).toISOString())).toBe('10 days left');
  });

  it('keeps the gateway error code and Retry-After', () => {
    const e = new ApiError(503, 'STALE_PEER', 'peer behind', 2);
    expect(e.status).toBe(503);
    expect(e.retryAfter).toBe(2);
  });
});
