# Built from the repo root: docker build -f gateway/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY gateway/package.json gateway/
RUN pnpm install --frozen-lockfile --filter @planetary-health/gateway
COPY gateway/ gateway/
RUN pnpm -C gateway build && pnpm deploy --filter @planetary-health/gateway --prod --legacy /out

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--no-warnings=ExperimentalWarning
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/gateway/dist ./dist
COPY --from=build /app/gateway/package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
