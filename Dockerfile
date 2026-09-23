FROM node:24-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src ./src
COPY web/public ./public
# Vite emits the production UI into /app/public (served by NestJS useStaticAssets).
RUN npm run build

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npm run db:generate
COPY nest-cli.json tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
RUN apk add --no-cache curl && addgroup -S gateway && adduser -S gateway -G gateway
COPY --from=build --chown=gateway:gateway /app/node_modules ./node_modules
COPY --from=build --chown=gateway:gateway /app/dist ./dist
COPY --from=build --chown=gateway:gateway /app/prisma ./prisma
COPY --from=web --chown=gateway:gateway /app/public ./public
COPY --from=build --chown=gateway:gateway /app/package.json ./package.json
USER gateway
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 CMD curl -fsS http://127.0.0.1:4100/api/v1/health || exit 1
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
