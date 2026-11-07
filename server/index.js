import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  checkFfmpegInstalled,
  checkYtDlpInstalled,
  commonArgs,
  getVideoInfo,
  mapYtDlpError,
} from "./downloaders/ytdlp.js";

// Fail fast at startup if yt-dlp is missing — see ytdlp.js.
const ytDlpVersion = checkYtDlpInstalled();
checkFfmpegInstalled();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 5000);
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS ?? 3);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 20 * 60_000);
// Secret used to sign direct-download links (see signUrl). Set URL_SECRET
// in production if you run more than one instance behind a load balancer.
const URL_SECRET = process.env.URL_SECRET || randomBytes(32).toString("hex");

// Behind Caddy / an ALB set TRUST_PROXY=1 so rate limiting sees real IPs.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0));
app.disable("x-powered-by");

// The built client is served by this same server, so CORS is only needed
// if you host the frontend on a different origin.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(",") }));
}
app.use(express.json({ limit: "10kb" }));

/* ------------------------------------------------------------------ */
/* URL validation                                                      */
/* ------------------------------------------------------------------ */

const PLATFORM_HOSTS = {
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.watch"],
};

// Match on the parsed HOSTNAME. The old regex tested the whole string, so
// "https://evil.example/?x=tiktok.com" was accepted and handed to yt-dlp.
function detectPlatform(raw) {
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [platform, domains] of Object.entries(PLATFORM_HOSTS)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) {
      return platform;
    }
  }
  return null;
}

function isSupportedUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return detectPlatform(raw) !== null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Signed direct links (prevents /api/stream from being an open proxy) */
/* ------------------------------------------------------------------ */

function signUrl(url) {
  return createHmac("sha256", URL_SECRET).update(url).digest("base64url");
}

function validSignature(url, sig) {
  if (typeof sig !== "string") return false;
  const expected = Buffer.from(signUrl(url));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/* ------------------------------------------------------------------ */
/* Download helpers                                                    */
/* ------------------------------------------------------------------ */

const VALID_EXT = new Set(["mp4", "webm", "mkv", "mov", "m4a", "mp3"]);

function contentDisposition(name, ext) {
  const base =
    String(name ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video";
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(full).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// The browser downloads through a hidden iframe, so it cannot read our
// response. The client polls this cookie instead: "ok" once bytes are
// flowing, or "err.<message>" if the download failed. That is what lets
// the UI re-enable its buttons and show a real error.
function setStatusCookie(res, token, value) {
  if (!token) return;
  res.append(
    "Set-Cookie",
    `dl_${token}=${value}; Path=/; Max-Age=300; SameSite=Lax`,
  );
}

function streamError(res, token, status, message) {
  if (res.headersSent) {
    // Bytes already went out: abort the connection so the browser marks the
    // file as failed instead of saving a silently truncated one.
    res.destroy();
    return;
  }
  setStatusCookie(res, token, `err.${encodeURIComponent(message)}`);
  res.status(status).json({ error: message });
}

function parseToken(raw) {
  return typeof raw === "string" && /^[a-zA-Z0-9]{8,40}$/.test(raw)
    ? raw
    : null;
}

let activeJobs = 0;
function acquireSlot() {
  if (activeJobs >= MAX_CONCURRENT_JOBS) return null;
  activeJobs += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeJobs -= 1;
    }
  };
}

/**
 * Run yt-dlp into a temp directory, then send the finished file.
 *
 * Why not stream yt-dlp's stdout? When video+audio must be merged, yt-dlp
 * writes MPEG-TS to stdout even for "mp4", so the browser got a mislabelled
 * file with no duration/seeking and no Content-Length (so no progress bar).
 * A temp file gives a real MP4/MP3 with a proper size.
 */
function runJob(req, res, { args, url, token, name }) {
  const release = acquireSlot();
  if (!release) {
    return streamError(
      res,
      token,
      503,
      "The server is busy with other downloads. Please try again in a minute.",
    );
  }

  let dir = null;
  let child = null;
  let closed = false;
  let timer = null;

  const cleanup = () => {
    clearTimeout(timer);
    release();
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  // Fires on completion AND on client disconnect/cancel.
  res.on("close", () => {
    closed = true;
    if (child && child.exitCode === null) child.kill("SIGKILL");
    cleanup();
  });

  (async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "vg-"));
    if (closed) return cleanup();

    child = spawn("yt-dlp", [
      ...commonArgs(url),
      ...args,
      "-o",
      path.join(dir, "out.%(ext)s"),
      "--",
      url,
    ]);

    let stderr = "";
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      if (!closed) {
        streamError(res, token, 504, "The download took too long and was cancelled.");
      }
    }, JOB_TIMEOUT_MS);

    child.stderr.on("data", (c) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    child.on("error", (err) => {
      console.error("yt-dlp spawn failed:", err.message);
      if (!closed) streamError(res, token, 502, "Could not start the download.");
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (closed) return;
      try {
        if (timedOut) {
          return streamError(res, token, 504, "The download took too long and was cancelled.");
        }
        if (code !== 0) {
          console.error("yt-dlp failed:", stderr.trim().slice(-500));
          return streamError(res, token, 502, mapYtDlpError(stderr).message);
        }
        const files = await readdir(dir);
        const file = files.find(
          (f) => f.startsWith("out.") && !/\.(part|ytdl|temp)$/.test(f),
        );
        if (!file) {
          return streamError(res, token, 502, "The download finished but produced no file.");
        }
        const filePath = path.join(dir, file);
        const ext = path.extname(file).slice(1).toLowerCase();
        const { size } = await stat(filePath);

        const type =
          ext === "mp3" ? "audio/mpeg" : ext === "webm" ? "video/webm" : "video/mp4";
        res.setHeader("Content-Type", type);
        res.setHeader("Content-Length", size);
        res.setHeader("Content-Disposition", contentDisposition(name, ext));
        setStatusCookie(res, token, "ok");
        await pipeline(createReadStream(filePath), res);
      } catch (err) {
        // Client went away mid-transfer, or the file could not be read.
        if (!closed) streamError(res, token, 502, "Could not send the file.");
      }
    });
  })().catch((err) => {
    console.error("Job failed:", err.message);
    cleanup();
    if (!closed) streamError(res, token, 502, "Could not start the download.");
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function formatDownloadUrl(originalUrl, format, title) {
  const name = `&name=${encodeURIComponent(`${title} [${format.label}]`)}`;
  if (format.mode === "direct") {
    const ext = VALID_EXT.has(format.ext) ? format.ext : "mp4";
    return `/api/stream?url=${encodeURIComponent(format.url)}&sig=${signUrl(format.url)}&ext=${ext}${name}`;
  }
  // Merged: the server downloads + merges video and audio with ffmpeg.
  const height = format.height ? `&height=${format.height}` : "";
  return `/api/stream?video=${encodeURIComponent(originalUrl)}${height}${name}`;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const infoLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_INFO ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a minute and try again." },
});
const streamLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_STREAM ?? 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many downloads. Please wait a minute and try again." },
});

app.post("/api/download", infoLimiter, async (req, res) => {
  const { url } = req.body ?? {};

  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "Please paste a video URL." });
  }

  const trimmed = url.trim();

  if (!isSupportedUrl(trimmed)) {
    return res.status(400).json({
      error:
        "Unsupported URL. Only TikTok, YouTube, Instagram, and Facebook links are supported.",
    });
  }

  const platform = detectPlatform(trimmed);

  try {
    const info = await getVideoInfo(trimmed);

    const formats = (info.formats ?? []).map((f) => ({
      height: f.height,
      label: f.label,
      mode: f.mode,
      ext: f.ext,
      formatId: f.formatId,
      filesize: f.filesize,
      downloadUrl: formatDownloadUrl(trimmed, f, info.title),
    }));

    const audio = info.audio
      ? {
          label: info.audio.label,
          ext: info.audio.ext,
          downloadUrl: `/api/stream?video=${encodeURIComponent(trimmed)}&audio=mp3&name=${encodeURIComponent(`${info.title} [audio]`)}`,
        }
      : null;

    return res.json({
      platform,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      viewCount: info.viewCount,
      uploadDate: info.uploadDate,
      quality: info.quality,
      ext: info.ext,
      // Backwards-compatible single download (highest quality).
      downloadUrl: formats[0]?.downloadUrl ?? null,
      formats,
      audio,
      webpageUrl: info.webpageUrl,
    });
  } catch (err) {
    console.error("Download failed:", err.message);
    return res.status(502).json({
      error:
        err.message ||
        "Could not fetch this video. It may be private, deleted, or unsupported.",
    });
  }
});

app.get("/api/stream", streamLimiter, async (req, res) => {
  const token = parseToken(req.query.token);
  const name = typeof req.query.name === "string" ? req.query.name : "video";

  // yt-dlp jobs: ?video=<original page URL>
  //   &height=1080  -> merged video at (at most) that height + best audio
  //   &audio=mp3    -> audio-only, converted to MP3
  if (req.query.video && typeof req.query.video === "string") {
    const originalUrl = req.query.video;
    if (!isSupportedUrl(originalUrl)) {
      return streamError(res, token, 400, "Unsupported video URL.");
    }

    if (req.query.audio) {
      return runJob(req, res, {
        url: originalUrl,
        token,
        name,
        args: [
          "-f",
          "bestaudio/best",
          "-x",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "2",
        ],
      });
    }

    const height = Number.parseInt(req.query.height, 10);
    // Prefer MP4/M4A streams so the merged file plays everywhere.
    const formatSelector = Number.isFinite(height)
      ? `bestvideo[height=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
      : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best";

    return runJob(req, res, {
      url: originalUrl,
      token,
      name,
      args: ["-f", formatSelector, "--merge-output-format", "mp4"],
    });
  }

  // Direct upstream proxy: ?url=<direct video URL>&sig=<HMAC from /api/download>
  const directUrl = req.query.url;

  if (!directUrl || typeof directUrl !== "string") {
    return streamError(res, token, 400, "Missing ?url= parameter.");
  }

  let parsed;
  try {
    parsed = new URL(directUrl);
  } catch {
    return streamError(res, token, 400, "Invalid video URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return streamError(res, token, 400, "Invalid video URL.");
  }
  // Only URLs this server itself produced (via yt-dlp) may be proxied.
  // Without this check anyone could use the server to reach internal
  // addresses such as the AWS metadata service (169.254.169.254).
  if (!validSignature(directUrl, req.query.sig)) {
    return streamError(
      res,
      token,
      403,
      "This download link is invalid or expired. Fetch the video again.",
    );
  }

  const ext = VALID_EXT.has(req.query.ext) ? req.query.ext : "mp4";
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const upstream = await fetch(directUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://www.google.com/",
      },
    });

    if (!upstream.ok || !upstream.body) {
      return streamError(
        res,
        token,
        502,
        upstream.status === 403 || upstream.status === 410
          ? "This download link has expired. Fetch the video again."
          : `Upstream video fetch failed (${upstream.status}).`,
      );
    }

    const upstreamType = upstream.headers.get("content-type") ?? "";
    res.setHeader(
      "Content-Type",
      /^(video|audio)\//.test(upstreamType) ? upstreamType : "video/mp4",
    );
    res.setHeader("Content-Disposition", contentDisposition(name, ext));
    const length = upstream.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);
    setStatusCookie(res, token, "ok");

    // pipeline() handles backpressure and tears both sides down on error.
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (controller.signal.aborted) return; // client cancelled
    console.error("Stream failed:", err.message);
    streamError(res, token, 502, "Could not stream this video.");
  }
});

/* ------------------------------------------------------------------ */
/* Serve the built frontend (production)                               */
/* ------------------------------------------------------------------ */

const clientDist = path.resolve(__dirname, "../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/|health).*/, (req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Don't let one bad request take the whole server down.
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// Remove temp dirs left behind by a crash.
readdir(os.tmpdir())
  .then((names) =>
    Promise.all(
      names
        .filter((n) => n.startsWith("vg-"))
        .map((n) => rm(path.join(os.tmpdir(), n), { recursive: true, force: true })),
    ),
  )
  .catch(() => {});

const server = app.listen(PORT, () => {
  console.log(`VideoGrab server running on http://localhost:${PORT}`);
  console.log(`yt-dlp ${ytDlpVersion}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
