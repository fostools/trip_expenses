# Works on Fly.io, Railway and Render. Data (SQLite + receipt photos) lives on a mounted volume at /data.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/tripex.db \
    RECEIPTS_DIR=/data/receipts
EXPOSE 8080

CMD ["npx", "tsx", "src/server.ts"]
