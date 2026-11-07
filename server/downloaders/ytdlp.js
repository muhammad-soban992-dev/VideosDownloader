import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const INFO_TIMEOUT_MS = Number(process.env.INFO_TIMEOUT_MS ?? 60_000);

/**
 * Optional cookies (needed for YouTube bot-checks from datacenter IPs,
 * and for login-only Instagram/Facebook videos). yt-dlp rewrites the
 * cookie file on exit, so work on a writable copy — that way the
 * original can be mounted read-only in Docker.
 */
let cookiesPath = null;
if (process.env.COOKIES_FILE) {
  if (existsSync(process.env.COOKIES_FILE)) {
    cookiesPath = path.join(os.tmpdir(), "videograb-cookies.txt");
    copyFileSync(process.env.COOKIES_FILE, cookiesPath);
    console.log("Using cookies from COOKIES_FILE");
  } else {
    console.warn(`COOKIES_FILE not found: ${process.env.COOKIES_FILE}`);
  }
}

/** Args shared by every yt-dlp invocation (info + download). */
export function commonArgs(url, { androidFallback = false } = {}) {
  return [
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    ...(process.env.YTDLP_PROXY ? ["--proxy", process.env.YTDLP_PROXY] : []),
    ...(cookiesPath ? ["--cookies", cookiesPath] : []),
    // Current YouTube extraction needs a JS runtime; Node is already here.
    // (yt-dlp only auto-enables Deno.) Needs yt-dlp[default] for yt-dlp-ejs.
    ...(isYouTubeUrl(url) ? ["--js-runtimes", "node"] : []),
    ...(androidFallback && isYouTubeUrl(url) ? youTubeExtractorArgs() : []),
    "--add-header",
    "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  ];
}

/**
 * Fail fast with a clear, actionable message if yt-dlp is not on PATH.
 * Called once at server startup (see server/index.js).
 */
export function checkYtDlpInstalled() {
  try {
    const result = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(`exit code ${result.status}`);
    }
    return result.stdout.trim();
  } catch {
    console.error(
      "yt-dlp not found. Install it (see README).",
    );
    console.error("  macOS:   brew install yt-dlp ffmpeg");
    console.error("  Ubuntu:  sudo apt install yt-dlp ffmpeg");
    console.error(
      "  Windows: download yt-dlp.exe + ffmpeg and add them to PATH",
    );
    console.error("  Then verify with: yt-dlp --version && ffmpeg -version");
    process.exit(1);
  }
}

export function checkFfmpegInstalled() {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    console.warn(
      "WARNING: ffmpeg not found — HD (merged) video and MP3 downloads will fail.",
    );
    return false;
  }
  return true;
}

export function isYouTubeUrl(url) {
  return /(youtube\.com|youtu\.be)/.test(url);
}

/**
 * YouTube player-client fallback. Some videos (e.g.
 * https://www.youtube.com/watch?v=GiLj9GibpSw) return no usable
 * combined format from the default web client, while the Android
 * client reliably returns format 18 (360p progressive MP4).
 * Only used for YouTube, and only as a retry (see getVideoInfo).
 */
export function youTubeExtractorArgs() {
  return ["--extractor-args", "youtube:player_client=android,web"];
}

export function qualityLabel(height) {
  if (!height) return "best";
  if (height >= 4320) return "8K";
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  return `${height}p`;
}

function hasVideo(f) {
  return f.vcodec && f.vcodec !== "none";
}
function hasAudio(f) {
  return f.acodec && f.acodec !== "none";
}
function fileSize(f) {
  return f.filesize ?? f.filesize_approx ?? null;
}

/**
 * Build the full quality list from yt-dlp's format table.
 *
 * Only qualities that actually exist for THIS video are returned —
 * 8K/4K/2K/1080p/720p/480p are never faked. For each height:
 *  - a progressive (video+audio) file, if one exists: mode "direct",
 *    streamed straight from its upstream URL;
 *  - otherwise a video-only stream + the best audio stream:
 *    mode "merged", merged to MP4 on the fly by the server
 *    (yt-dlp + ffmpeg, see /api/stream?video=...&height=...).
 *
 * Also returns an audio option whenever any format carries audio:
 * mode "audio", converted to MP3 on the fly by the server.
 */
export function buildFormats(info, originalUrl) {
  const formats = Array.isArray(info.formats) ? info.formats : [];

  // Best candidate per height: prefer MP4, then highest bitrate.
  const bestPerHeight = (candidates) => {
    const byHeight = new Map();
    for (const f of candidates) {
      if (!f.height) continue;
      const prev = byHeight.get(f.height);
      const score = (x) => (x.ext === "mp4" ? 1000 : 0) + (x.tbr ?? 0);
      if (!prev || score(f) > score(prev)) byHeight.set(f.height, f);
    }
    return byHeight;
  };

  const progressive = bestPerHeight(
    formats.filter((f) => hasVideo(f) && hasAudio(f) && f.url),
  );
  const videoOnly = bestPerHeight(
    formats.filter((f) => hasVideo(f) && !hasAudio(f) && f.url),
  );
  const audioOnly = formats
    .filter((f) => !hasVideo(f) && hasAudio(f) && f.url)
    .sort((a, b) => {
      const score = (x) => (x.ext === "m4a" ? 1000 : 0) + (x.abr ?? 0);
      return score(b) - score(a);
    });
  const bestAudio = audioOnly[0] ?? null;

  const heights = [...new Set([...progressive.keys(), ...videoOnly.keys()])]
    .sort((a, b) => b - a);

  const options = heights.map((height) => {
    const prog = progressive.get(height);
    if (prog) {
      return {
        height,
        label: qualityLabel(height),
        mode: "direct",
        ext: prog.ext ?? "mp4",
        formatId: prog.format_id,
        filesize: fileSize(prog),
        url: prog.url,
      };
    }
    const video = videoOnly.get(height);
    return {
      height,
      label: qualityLabel(height),
      mode: "merged",
      ext: "mp4",
      formatId: video.format_id,
      filesize:
        fileSize(video) && bestAudio && fileSize(bestAudio)
          ? fileSize(video) + fileSize(bestAudio)
          : (fileSize(video) ?? null),
      url: null,
    };
  });

  // Last resort: yt-dlp's own best single URL, if it has one and
  // no format table was usable at all.
  if (options.length === 0 && info.url) {
    options.push({
      height: info.height ?? null,
      label: qualityLabel(info.height) || "best",
      mode: "direct",
      ext: info.ext ?? "mp4",
      formatId: info.format_id ?? null,
      filesize: fileSize(info),
      url: info.url,
    });
  }

  const hasAnyAudio =
    bestAudio !== null ||
    formats.some((f) => hasAudio(f) && f.url) ||
    Boolean(info.url);

  return {
    options,
    audio: hasAnyAudio
      ? { label: "Audio (MP3)", mode: "audio", ext: "mp3", formatId: bestAudio?.format_id ?? null }
      : null,
  };
}

export function mapYtDlpError(detail) {
  if (/ffmpeg|ffprobe/i.test(detail) && /not found|not installed/i.test(detail)) {
    return new Error(
      "ffmpeg is required for HD and MP3 downloads and was not found on the server.",
    );
  }
  if (/requested format is not available/i.test(detail)) {
    return new Error(
      "This quality is not available for this video. Pick another quality.",
    );
  }
  if (/not a bot|sign in to confirm/i.test(detail)) {
    return new Error(
      "YouTube is asking for a bot check for this video (common on server/datacenter IPs). Update yt-dlp, or configure COOKIES_FILE / YTDLP_PROXY — see README.",
    );
  }
  if (/private/i.test(detail)) {
    return new Error("This video is private or requires login.");
  }
  if (/not available|removed|deleted|unavailable/i.test(detail)) {
    return new Error("This video is unavailable, deleted, or removed.");
  }
  if (/login required|log in/i.test(detail)) {
    return new Error(
      "This video requires login. See README: export cookies.txt from your browser.",
    );
  }
  if (/unsupported url|no video formats/i.test(detail)) {
    return new Error("Unsupported URL or no downloadable video found.");
  }
  return new Error(
    detail
      ? `yt-dlp failed: ${detail.split("\n").pop()}`
      : "yt-dlp failed to fetch this video.",
  );
}

/**
 * One yt-dlp --dump-json run. Uses spawn() with an argument array —
 * never a shell string — so a crafted URL cannot inject commands.
 */
function runYtDlpDump(url, useAndroidFallback) {
  return new Promise((resolve, reject) => {
    const args = [
      "--dump-json",
      ...commonArgs(url, { androidFallback: useAndroidFallback }),
      "--add-header",
      "Referer:https://www.google.com/",
      "--",
      url,
    ];

    const child = spawn("yt-dlp", args);
    let stdout = "";
    let stderr = "";
    let settled = false;

    // Without this, a stalled yt-dlp leaves the UI on "Fetching…" forever.
    // Reject right away; don't wait for the process's pipes to close.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const err = new Error(
        "Timed out while fetching this video. Please try again in a moment.",
      );
      err.code = "TIMEOUT";
      reject(err);
    }, INFO_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to run yt-dlp: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(mapYtDlpError(stderr.trim()));
        return;
      }
      try {
        // --no-playlist yields exactly one JSON object, but take the
        // last non-empty line defensively in case of stray output.
        const lines = stdout.trim().split("\n").filter(Boolean);
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        reject(new Error("Could not parse yt-dlp output."));
      }
    });
  });
}

/**
 * Run yt-dlp and return parsed metadata + the full quality list.
 *
 * Strategy: try the default player clients first, so videos that
 * offer high-quality DASH streams (1080p/4K/8K) keep them. Only if
 * that run fails or yields no usable format, retry YouTube with
 * the Android client, which rescues videos the web client refuses
 * (e.g. GiLj9GibpSw, which only offers format 18 there).
 */
export async function getVideoInfo(url) {
  let info;
  let lastError = null;
  try {
    info = await runYtDlpDump(url, false);
  } catch (err) {
    lastError = err;
  }

  let built = info ? buildFormats(info, url) : { options: [], audio: null };

  if (
    (!info || built.options.length === 0) &&
    isYouTubeUrl(url) &&
    lastError?.code !== "TIMEOUT"
  ) {
    try {
      info = await runYtDlpDump(url, true);
      built = buildFormats(info, url);
      lastError = null;
    } catch (err) {
      lastError = lastError ?? err;
    }
  }

  if (!info || built.options.length === 0) {
    throw lastError ?? new Error("No downloadable video format found.");
  }

  const best = built.options[0];
  return {
    title: info.title ?? "Untitled video",
    thumbnail: info.thumbnail ?? null,
    duration: info.duration ?? null,
    uploader: info.uploader ?? info.channel ?? null,
    viewCount: info.view_count ?? null,
    uploadDate: info.upload_date ?? null, // YYYYMMDD
    quality: best.label,
    ext: best.ext,
    formatId: best.formatId ?? null,
    mode: best.mode,
    directUrl: best.url,
    originalUrl: url,
    webpageUrl: info.webpage_url ?? url,
    formats: built.options,
    audio: built.audio,
  };
}
