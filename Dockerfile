# syntax=docker/dockerfile:1
# Multi-stage build for Cloud Run. No secrets are baked in: all config arrives as env vars / Secret Manager at runtime.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-slim AS run
WORKDIR /app
# NODE_ENV=production also hard-disables the PayPal simulator's certificate allowance (see devCertOrigin()).
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
