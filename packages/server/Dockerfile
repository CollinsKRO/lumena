FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages

RUN corepack enable && pnpm install --frozen-lockfile

RUN pnpm --filter @lumen/server build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["pnpm", "--filter", "@lumen/server", "start"]