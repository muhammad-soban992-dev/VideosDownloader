# 🎬 VideoGrab

A multi-platform video downloader for TikTok, YouTube, Instagram,
and Facebook — downloads videos without watermarks, using yt-dlp.
Runs locally, in Docker, or on a server — see **[DEPLOY_AWS.md](DEPLOY_AWS.md)**
for a step-by-step AWS guide.

## Prerequisites

- Node.js 20+
- yt-dlp installed and on PATH
  - macOS: `brew install yt-dlp ffmpeg`
  - Ubuntu: `sudo apt install yt-dlp ffmpeg`
  - Windows: download yt-dlp.exe + ffmpeg, add to PATH
- Verify with:

```bash
yt-dlp --version && ffmpeg -version
```

## Install

```bash
cd video-downloader
npm install
cd server && npm install && cd ..
cd client && npm install && cd ..
```

Or, in one go from the project root:

```bash
npm run install:all
```

## Run (single command)

```bash
npm run dev
```

Opens:

- Backend: http://localhost:5000
- Frontend: http://localhost:5173

`npm run dev` uses `concurrently` to start both the Express server
(port 5000) and the Vite client (port 5173). You can also run them in
two terminals instead:

```bash
# Terminal 1
cd server && npm run dev

# Terminal 2
cd client && npm run dev
```

## Run with Docker

No Node, yt-dlp or ffmpeg needed on your machine — all inside the image.
The image builds the client and serves everything from **one port (5000)**.

```bash
docker compose up --build      # then open http://localhost:5000
```

## Deploy to a server (AWS)

See **[DEPLOY_AWS.md](DEPLOY_AWS.md)**: EC2 + Docker + Caddy with automatic
HTTPS, password protection, billing alarm, and the YouTube bot-check caveat.

## Production without Docker

```bash
npm run install:all && npm start     # builds the client, serves on PORT (default 5000)
```

## Features

- **Quality picker:** 8K, 4K, 2K, 1080p, 720p, 480p, and lower —
  only the qualities that actually exist for that video are shown.
  A 360p-only video will never offer fake 4K. Each option shows
  whether it is a direct single file or a server-merged file, plus
  its estimated size.
- **Audio download:** a separate "Download Audio MP3" button.
  Audio is converted to MP3 on the server with ffmpeg.
- **Other functions:** Paste from clipboard, Clear, Copy download
  link, Download thumbnail, Open original video, and a Recent
  history (last 5 videos, stored in your browser only).
- **Video info:** title, thumbnail, uploader, views, upload date,
  and duration.

## How it works

1. Paste a TikTok, YouTube, Instagram, or Facebook URL in the browser.
2. The frontend POSTs it to `POST /api/download`.
3. The backend detects the platform from the URL, runs
   `yt-dlp --dump-json --no-playlist` (via `spawn`, never a shell
   string), and builds the full quality list: progressive files
   stream directly, while separate video+audio (DASH) qualities
   are merged to MP4 on the fly. YouTube is tried with the default
   clients first (so high-quality DASH is kept), then with the
   Android client as a fallback for videos the web client refuses.
4. The result card shows the title, thumbnail, info, and quality
   buttons. Pick a quality, then download.
5. Direct files are proxied from `GET /api/stream?url=…&sig=…` (links are
   HMAC-signed, so the server can't be used as an open proxy). HD (merged)
   video and MP3 are built by yt-dlp + ffmpeg into a temp file and sent with
   a real size, so your browser shows proper progress. The page shows a
   "Preparing…" state and re-enables its buttons when the file starts, or
   shows the error if it failed.

## How to update yt-dlp when downloads stop working

Platforms change their pages often, and an old yt-dlp is the most
common cause of a download that suddenly stops working. Update it:

```bash
yt-dlp -U
```

Or via your package manager:

```bash
brew upgrade yt-dlp   # macOS
apt upgrade yt-dlp    # Ubuntu
```

## Troubleshooting

- **"yt-dlp not found"** — install it (see Prerequisites above). The
  server checks at startup and exits with this message if yt-dlp is
  not on PATH.
- **YouTube returns 360p only** — normal for progressive formats.
  If a video has no combined file at all (separate video/audio
  streams only), the server automatically falls back to a merged
  download: yt-dlp + ffmpeg merge the best video and audio into
  one MP4 on the fly via `GET /api/stream?video=<url>`.
  That fallback needs ffmpeg installed.
- **"No downloadable video format found"** — update yt-dlp (see above).
- **Instagram "login required" / YouTube bot-check** — export
  cookies.txt from your browser and set `COOKIES_FILE=/path/to/cookies.txt`
  (see DEPLOY_AWS.md).
- **TikTok 403** — update yt-dlp (see above).
- **Unsupported URL** — only TikTok, YouTube, Instagram, and
  Facebook links are accepted; anything else returns a clear error.
- **Private / deleted video** — the backend returns a clear message
  instead of a blank failure.

## API

| Endpoint | Description |
| --- | --- |
| `GET /health` | `{ "status": "ok" }` |
| `POST /api/download` | Body `{ "url": "..." }` → metadata + `downloadUrl` |
| `GET /api/stream?url=…&sig=…` | Proxies a signed direct video file |
| `GET /api/stream?video=<page url>&height=<h>` | HD video (merged with ffmpeg) |
| `GET /api/stream?video=<page url>&audio=mp3` | Audio as MP3 |

## Legal notice

Download only content you own or have rights to. Respect platform
Terms of Service.
# VideosDownloader
