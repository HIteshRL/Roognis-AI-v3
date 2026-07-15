# ── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# ── Stage 2: Production image ────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma generate --schema=prisma/schema.prisma

EXPOSE 3002

CMD ["node", "server.js"]
