# Paper-trading bot. Placeholder for later VPS migration.
# Builds a runtime image that runs poller + listener + executor + dashboard.
FROM node:20-bookworm-slim

# better-sqlite3 needs a toolchain to compile its native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps against the committed lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install tsx@4.19.2 typescript@5.7.3 --no-save

COPY . .

# Persistent data lives on a mounted volume in production.
VOLUME ["/app/data", "/app/logs", "/app/exports"]

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
