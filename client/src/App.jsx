import { useEffect, useRef, useState } from "react";

const HISTORY_KEY = "videograb_history";
// A yt-dlp lookup normally takes a few seconds; never wait forever.
const FETCH_TIMEOUT_MS = 90_000;
// How long we wait for a download to start (HD merging can be slow).
const PREPARE_TIMEOUT_MS = 10 * 60_000;

// Accept "www.tiktok.com/…" or "youtube.com/…" without a scheme.
function normalizeUrl(raw) {
  const t = raw.trim();
  if (!t) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

function readCookie(name) {
  const hit = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function randomToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// navigator.clipboard only exists on HTTPS/localhost; fall back otherwise.
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return null;
  const total = Math.floor(Number(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatSize(bytes) {
  if (bytes == null) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatViews(n) {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  return `${n} views`;
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  // "video" | "audio" | null — which download is currently being prepared.
  const [downloading, setDownloading] = useState(null);
  const fetchAbort = useRef(null);
  const download = useRef(null); // { poll, iframe }

  // Stop timers / pending requests if the component goes away.
  useEffect(
    () => () => {
      fetchAbort.current?.abort();
      stopDownloadWatch();
    },
    [],
  );

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // Private mode / storage unavailable: history is optional.
    }
  }, [history]);

  function cancelFetch() {
    fetchAbort.current?.abort();
  }

  async function handleFetch(e, overrideUrl) {
    if (e) e.preventDefault();
    const target = normalizeUrl(overrideUrl ?? url);
    setError("");
    setResult(null);
    setSelected(null);
    setCopied(false);
    stopDownloadWatch();
    setDownloading(null);

    if (!target) {
      setError("Please paste a video URL first.");
      return;
    }

    // Only one lookup at a time; a newer one replaces the older.
    fetchAbort.current?.abort();
    const controller = new AbortController();
    fetchAbort.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    setUrl(target);
    setLoading(true);
    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
        signal: controller.signal,
      });
      // A proxy/load balancer timeout returns HTML, not JSON.
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error(
          data?.error ||
            (res.status === 504 || res.status === 502
              ? "The server took too long to respond. Please try again."
              : "Something went wrong."),
        );
      }
      setResult(data);
      setSelected(data.formats?.[0] ?? null);
      setHistory((prev) => {
        const entry = {
          url: target,
          title: data.title,
          thumbnail: data.thumbnail,
          platform: data.platform,
          at: Date.now(),
        };
        return [
          entry,
          ...prev.filter((h) => h.url !== target),
        ].slice(0, 5);
      });
    } catch (err) {
      if (controller.signal.aborted && !timedOut) {
        // Cancelled by the user (or replaced by a newer lookup).
        if (fetchAbort.current === controller) setError("Cancelled.");
      } else if (timedOut) {
        setError("This is taking too long. Please try again.");
      } else {
        setError(err.message || "Could not fetch this video.");
      }
    } finally {
      clearTimeout(timer);
      // Always re-enable the buttons — but only for the latest lookup.
      if (fetchAbort.current === controller) {
        fetchAbort.current = null;
        setLoading(false);
      }
    }
  }

  function stopDownloadWatch() {
    const d = download.current;
    if (!d) return;
    clearInterval(d.poll);
    clearTimeout(d.removeTimer);
    d.iframe.remove();
    download.current = null;
  }

  /**
   * Start a download in a hidden iframe (the browser's download manager
   * shows progress) and watch a status cookie the server sets once bytes
   * start flowing, or when it fails. This is what drives the "Preparing…"
   * state: the buttons are disabled only while we wait, then come back —
   * and a failure shows a real error instead of silently doing nothing.
   */
  function startDownload(kind, downloadUrl) {
    if (download.current) return;
    const token = randomToken();
    const sep = downloadUrl.includes("?") ? "&" : "?";
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = `${downloadUrl}${sep}token=${token}`;
    document.body.appendChild(iframe);

    const startedAt = Date.now();
    const finish = (message) => {
      const d = download.current;
      if (!d) return;
      clearInterval(d.poll);
      document.cookie = `dl_${token}=; Max-Age=0; Path=/`;
      download.current = null;
      setDownloading(null);
      if (message) {
        iframe.remove();
        setError(message);
      } else {
        // Keep the iframe a while so the transfer is not interrupted.
        setTimeout(() => iframe.remove(), PREPARE_TIMEOUT_MS);
      }
    };

    const poll = setInterval(() => {
      const value = readCookie(`dl_${token}`);
      if (value === "ok") {
        finish();
      } else if (value?.startsWith("err.")) {
        finish(decodeURIComponent(value.slice(4)));
      } else if (Date.now() - startedAt > PREPARE_TIMEOUT_MS) {
        finish("The download did not start. Please try again.");
      }
    }, 400);

    download.current = { poll, iframe };
    setError("");
    setDownloading(kind);
  }

  function cancelDownload() {
    stopDownloadWatch();
    setDownloading(null);
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
      else setError("The clipboard is empty.");
    } catch {
      setError("Clipboard access was blocked (it needs HTTPS and your permission). Paste manually with Ctrl+V.");
    }
  }

  async function handleCopyLink() {
    if (!selected) return;
    const absolute = `${window.location.origin}${selected.downloadUrl}`;
    try {
      await copyText(absolute);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the link. Copy it from the address bar instead.");
    }
  }

  const selectedLabel = selected
    ? `${selected.label} .${selected.ext}`
    : "video";

  return (
    <main className="container">
      <h1>🎬 VideoGrab</h1>
      <p className="subheading">
        TikTok · YouTube · Instagram · Facebook — 8K · 4K · 2K · 1080p · 720p · 480p · Audio, no watermark
      </p>

      <form className="row" onSubmit={handleFetch} noValidate>
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste a video URL here…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
        />
        <button type="button" className="icon-btn" onClick={handlePaste} disabled={loading}>
          📋 Paste
        </button>
        {url && !loading && (
          <button type="button" className="icon-btn" onClick={() => setUrl("")}>
            ✕ Clear
          </button>
        )}
        {loading && (
          <button type="button" className="icon-btn" onClick={cancelFetch}>
            ✕ Cancel
          </button>
        )}
        <button type="submit" disabled={loading}>
          {loading ? "Fetching…" : "Get video"}
        </button>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <section className="card">
          {result.thumbnail && (
            <img
              className="thumbnail"
              src={result.thumbnail}
              alt={result.title}
              referrerPolicy="no-referrer"
            />
          )}
          <div className="info">
            <h2>{result.title}</h2>
            <div className="badges">
              <span className="badge">{result.platform}</span>
              {result.uploader && <span className="badge">{result.uploader}</span>}
              {formatDuration(result.duration) && (
                <span className="badge">{formatDuration(result.duration)}</span>
              )}
              {formatViews(result.viewCount) && (
                <span className="badge">{formatViews(result.viewCount)}</span>
              )}
              {formatDate(result.uploadDate) && (
                <span className="badge">{formatDate(result.uploadDate)}</span>
              )}
            </div>

            {result.formats?.length > 0 && (
              <>
                <p className="section-label">Choose quality (only qualities this video actually has are shown):</p>
                <div className="quality-grid">
                  {result.formats.map((f) => (
                    <button
                      key={`${f.label}-${f.mode}-${f.height ?? "best"}`}
                      type="button"
                      className={`quality-btn ${selected?.label === f.label && selected?.mode === f.mode ? "selected" : ""}`}
                      onClick={() => setSelected(f)}
                      title={f.mode === "merged" ? "Video + audio merged on the server" : "Single file, streamed directly"}
                    >
                      <strong>{f.label}</strong>
                      <span>.{f.ext} · {f.mode === "merged" ? "merged" : "direct"}</span>
                      {formatSize(f.filesize) && <span>{formatSize(f.filesize)}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="actions">
              {selected && (
                <button
                  type="button"
                  className="download-btn"
                  disabled={downloading !== null}
                  onClick={() => startDownload("video", selected.downloadUrl)}
                >
                  {downloading === "video"
                    ? selected.mode === "merged"
                      ? "⏳ Preparing HD video… (can take a minute)"
                      : "⏳ Starting download…"
                    : `⬇ Download ${selectedLabel}`}
                </button>
              )}
              {result.audio && (
                <button
                  type="button"
                  className="audio-btn"
                  disabled={downloading !== null}
                  onClick={() => startDownload("audio", result.audio.downloadUrl)}
                >
                  {downloading === "audio"
                    ? "⏳ Converting to MP3…"
                    : "🎵 Download Audio MP3"}
                </button>
              )}
              {downloading && (
                <button type="button" className="secondary-btn" onClick={cancelDownload}>
                  ✕ Cancel
                </button>
              )}
            </div>
            {downloading && (
              <p className="hint">
                Your browser will start saving the file as soon as it is ready.
              </p>
            )}

            <div className="actions secondary">
              <button type="button" className="secondary-btn" onClick={handleCopyLink}>
                {copied ? "✓ Copied!" : "🔗 Copy download link"}
              </button>
              {result.thumbnail && (
                <a className="secondary-btn" href={result.thumbnail} target="_blank" rel="noreferrer">
                  🖼️ Open thumbnail
                </a>
              )}
              {result.webpageUrl && (
                <a className="secondary-btn" href={result.webpageUrl} target="_blank" rel="noreferrer">
                  ↗ Open original
                </a>
              )}
            </div>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="history">
          <p className="section-label">Recent:</p>
          {history.map((h) => (
            <button
              key={h.url}
              type="button"
              className="history-item"
              onClick={() => handleFetch(null, h.url)}
              disabled={loading}
            >
              {h.thumbnail && <img src={h.thumbnail} alt="" referrerPolicy="no-referrer" />}
              <span>
                <strong>{h.title}</strong>
                <small>{h.platform}</small>
              </span>
            </button>
          ))}
          <button type="button" className="history-clear" onClick={() => setHistory([])}>
            Clear history
          </button>
        </section>
      )}

      <p className="legal">
        Download only content you own or have rights to. Respect platform
        Terms of Service. Qualities shown are the ones actually available
        for that video — a 360p-only video will not offer fake 4K.
      </p>
    </main>
  );
}
