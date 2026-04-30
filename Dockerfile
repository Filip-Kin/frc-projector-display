FROM oven/bun:1-alpine
WORKDIR /app

# ── Server dependencies ───────────────────────────────────────────────────────
COPY server/package.json ./
RUN bun install --production

# ── Client source (bundled for self-hosted distribution) ─────────────────────
COPY client/ ./client-dist/

# ── Server source + public ────────────────────────────────────────────────────
COPY server/src/ ./src/
COPY server/public/ ./public/

# Create client.tar.gz (no node_modules — thin client installs them after)
RUN tar -czf ./public/client.tar.gz --exclude=node_modules --exclude=.git -C ./client-dist .

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
