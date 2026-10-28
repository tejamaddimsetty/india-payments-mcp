# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The official image ships a non-root "node" user (uid 1000).
USER node
EXPOSE 8787

# /healthz is unauthenticated and returns {"ok":true,"version":...,"mode":...}.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${MCP_HTTP_PORT}/healthz" >/dev/null || exit 1

# MCP_HTTP_TOKEN (24+ chars) and gateway credentials must be injected at runtime.
# Never bake them into the image.
CMD ["node", "dist/cli.js", "http"]
