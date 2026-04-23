# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Drop devDependencies to slim the runtime image
RUN npm prune --omit=dev

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# git is needed by Copilot worker sessions
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY agents/ agents/
COPY skills/ skills/

# Tell Max it's running inside a container (used to adjust restart behavior)
ENV MAX_DOCKER=1

EXPOSE 7777

CMD ["node", "dist/cli.js", "start"]
