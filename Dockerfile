# VideoGrab — production image: ONE process, ONE port (5000).
# Express serves both the API and the built React client, so there is no
# Vite dev server in production (the old image ran `npm run dev`).

# ---- Stage 1: build the React client ------------------------------------
FROM node:20-bookworm-slim AS client-build
WORKDIR /build
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: runtime ----------------------------------------------------
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=5000 \
    PATH="/opt/venv/bin:$PATH"

# ffmpeg: HD merging + MP3. python venv: yt-dlp (kept updatable by the
# non-root user; "[default]" pulls yt-dlp-ejs, needed for YouTube).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/venv \
  && pip install --no-cache-dir -U "yt-dlp[default]" \
  && chown -R node:node /opt/venv \
  && yt-dlp --version \
  && ffmpeg -version | head -n 1

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
COPY --from=client-build /build/dist ./client/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
