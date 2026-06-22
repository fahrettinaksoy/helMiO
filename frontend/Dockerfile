# syntax=docker/dockerfile:1
# Frontend image (@helmio/frontend) — built SPA served by nginx, which also
# reverse-proxies /api and /socket.io to the backend service.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY agent/package.json ./agent/
RUN npm ci
COPY frontend ./frontend
RUN npm run build -w frontend

FROM nginx:1.27-alpine AS runtime
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
