# Stable: production image for Google Cloud Run.
# Node 22 LTS (Node 20 reached end-of-life in April 2026).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Prisma's query engine needs OpenSSL.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching). The prisma/ folder is
# needed here because `postinstall` runs `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# Don't run as root.
USER node

# Cloud Run injects PORT (default 8080).
EXPOSE 8080
CMD ["node", "src/server.js"]

# Migrations are NOT run here. They run as a separate Cloud Run Job
# (`npx prisma migrate deploy`) before each deploy. See README "Deployment".
