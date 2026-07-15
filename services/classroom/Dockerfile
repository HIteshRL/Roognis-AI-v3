FROM node:20-alpine
WORKDIR /app

# openssl required by Prisma query engine on Alpine (same as ai/analytics)
RUN apk add --no-cache curl openssl

COPY . .

RUN [ -f package.json ] && npm ci || true
RUN [ -f prisma/schema.prisma ] && NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma generate --schema=prisma/schema.prisma || true

EXPOSE 3005

CMD ["node", "server.js"]
