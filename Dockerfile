# GLOBALISE MCP server, Streamable HTTP mode. Same base image as the research portal.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3001
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 mcp
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
USER mcp
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1
CMD ["node", "dist/http.js"]
