FROM node:20-bookworm

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    dumb-init \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-core \
    libasound2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxss1 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY prompts ./prompts
COPY .env.example ./.env.example

RUN mkdir -p /app/.chrome-profile && chown -R node:node /app

USER node

CMD ["dumb-init", "xvfb-run", "-a", "node", "src/index.js"]
