# hail-mcp — multi-stage build. Tiny: one runtime dependency, no database,
# all state in RAM. The result is a non-root Alpine image that runs the MCP
# server on $PORT (default 9091) and serves the channel at /mcp.

# ─── builder: install all deps + compile TypeScript ─────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install with a clean, reproducible tree (needs the lockfile).
COPY package.json package-lock.json ./
RUN npm ci

# Compile src -> dist (the build script runs `clean` first, so dist is fresh).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ─── runtime: production deps + compiled output only ────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production-only install (hail has a single runtime dependency).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The compiled server. package.json is already present above — server.ts reads
# its version from ../package.json at startup, so it must ship alongside dist/.
COPY --from=builder /app/dist ./dist

# Drop privileges — the base image ships an unprivileged `node` user.
USER node

# Default port; override with -e PORT=... (and publish the matching port).
ENV PORT=9091
EXPOSE 9091

# Liveness: any HTTP response (even the 401 from an unauthenticated probe)
# means the server is up and serving. Connection refused => unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||9091,path:'/mcp'},r=>process.exit(0)).on('error',()=>process.exit(1))"

# X_API_KEY is intentionally NOT baked in — pass it at run time:
#   docker run -e X_API_KEY=... -p 9091:9091 hail-mcp
CMD ["node", "dist/server.js"]
