FROM node:22.23.2-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY packages ./packages
COPY workers ./workers

USER node
CMD ["node", "--experimental-strip-types", "workers/outbox/main.ts"]
