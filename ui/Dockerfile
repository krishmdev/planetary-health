# Built from the repo root: docker build -f ui/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY ui/package.json ui/
RUN pnpm install --frozen-lockfile --filter @planetary-health/ui
COPY ui/ ui/
RUN pnpm -C ui build

FROM nginx:1.29-alpine
COPY ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/ui/dist /usr/share/nginx/html
