import pino from 'pino';

export function logger(level = process.env.LOG_LEVEL ?? 'info') {
  return pino({ level, base: { svc: 'gateway', org: process.env.ORG ?? 'org1' } });
}
