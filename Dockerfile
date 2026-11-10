# GLOBALISE MCP server, Streamable HTTP mode. Same build approach as globalise-research-portal.

# Build
FROM node:26-alpine AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"

RUN ENV="$HOME/.shrc" SHELL=/bin/sh npx --yes get-pnpm 11.25.0 \
    && command -v pnpm \
    && pnpm --version

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN pnpm typecheck && pnpm test && pnpm build \
    && pnpm prune --prod

# Run
FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 mcp

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

USER mcp

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1

CMD ["node", "dist/http.js"]
