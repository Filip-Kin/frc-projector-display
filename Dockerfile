FROM oven/bun:1-alpine
WORKDIR /app

# ── Server dependencies ───────────────────────────────────────────────────────
COPY server/package.json ./
RUN bun install --production

# ── Client source (bundled for self-hosted distribution) ─────────────────────
COPY client/ ./client-dist/
# omtx player (stock OMT and omtx), shipped in the client bundle so boxes get it with a normal
# client update. Debian's ffmpeg package on the box provides libavcodec and SDL2.
ARG OMTX_VERSION=v0.2.3
ADD https://github.com/Filip-Kin/omtx/releases/download/${OMTX_VERSION}/omtx-play-linux-x86_64.tar.gz /tmp/omtx-play.tar.gz
RUN mkdir -p ./client-dist/players/omtx && tar -xzf /tmp/omtx-play.tar.gz -C ./client-dist/players/omtx && rm /tmp/omtx-play.tar.gz
# Bundle the controller page so the daemon can serve it offline
COPY server/public/control.html ./client-dist/public/control.html

# ── Server source + public ────────────────────────────────────────────────────
COPY server/src/ ./src/
COPY server/public/ ./public/

# Create client.tar.gz (no node_modules — thin client installs them after)
RUN tar -czf ./public/client.tar.gz --exclude=node_modules --exclude=.git -C ./client-dist .

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
