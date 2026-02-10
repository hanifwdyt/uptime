FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Compile seed to JS
RUN npx tsx --tsconfig tsconfig.json -e "console.log('ok')" 2>/dev/null || true
COPY prisma/seed.ts ./prisma/seed.ts

FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/data

ENV DATABASE_URL="file:/app/data/uptime.db"
ENV NODE_ENV=production

# Need tsx for seed script at runtime
RUN npm install -g tsx

EXPOSE 3069

CMD ["sh", "-c", "npx prisma db push --skip-generate && tsx prisma/seed.ts && node dist/index.js"]
