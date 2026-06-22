# syntax=docker/dockerfile:1
# Backend image (@helmio/backend) — Node API + realtime server on :3001.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Copy only manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY agent/package.json ./agent/
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=./data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend

# Persisted JSON store, encryption key and JWT secret live here.
RUN mkdir -p /app/backend/data && chown -R node:node /app/backend/data
USER node
VOLUME ["/app/backend/data"]

EXPOSE 3001
CMD ["node", "backend/src/index.js"]
