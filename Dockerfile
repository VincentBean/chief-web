# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install every workspace dependency and compile server + web.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY server server
COPY web web
RUN npm run build

# ---------------------------------------------------------------------------
# Production dependencies only, installed from the same lockfile.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && mkdir -p server/node_modules

# ---------------------------------------------------------------------------
# Runtime image.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# git/openssh are used by the orchestrator to validate repository credentials
# (`git ls-remote`); docker-cli talks to the mounted host socket.
RUN apk add --no-cache git openssh-client docker-cli tini

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    CLAUDE_AUTH_DIR=/claude-auth \
    WEB_ROOT=/app/web/dist

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/server/node_modules server/node_modules
COPY package.json ./
COPY server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# The server runs as root because it drives the host Docker socket, whose group
# id is not knowable at build time. See README "Security model".
EXPOSE 8080
VOLUME ["/data", "/claude-auth"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
