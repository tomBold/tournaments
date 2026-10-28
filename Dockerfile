FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
