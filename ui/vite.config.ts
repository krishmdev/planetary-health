import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The UI talks to each hospital's API through the activator. Same-origin paths avoid CORS:
// /api/org1 -> :8080, /api/org2 -> :8081 (nginx does the same in compose.app.yaml).
const target = (port: number) => ({
  target: `http://localhost:${port}`,
  changeOrigin: true,
  rewrite: (p: string) => p.replace(/^\/api\/org[12]/, ''),
});

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/org1': target(Number(process.env.ORG1_PORT ?? 8080)),
      '/api/org2': target(Number(process.env.ORG2_PORT ?? 8081)),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
