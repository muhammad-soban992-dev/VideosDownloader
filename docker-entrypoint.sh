#!/bin/sh
# Platforms change constantly and an old yt-dlp is the #1 cause of
# "downloads stopped working". Update it on every container start
# (a restart is therefore also the way to update). Never block startup.
timeout 90 pip install --no-cache-dir -q -U "yt-dlp[default]" >/dev/null 2>&1 \
  && echo "yt-dlp updated: $(yt-dlp --version)" \
  || echo "yt-dlp update skipped (offline?) — using $(yt-dlp --version)"
exec "$@"
