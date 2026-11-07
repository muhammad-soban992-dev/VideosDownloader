# Deploying VideoGrab on AWS (step by step)

**Recommended setup: one EC2 server running Docker + Caddy (automatic HTTPS).**
About 20 minutes, roughly $15–20/month plus bandwidth.

## Why EC2 and not Lambda / App Runner / Elastic Beanstalk?

VideoGrab runs yt-dlp + ffmpeg, writes multi‑GB temp files and keeps a
connection open for minutes. Lambda (15 min, tiny disk), App Runner
(~2 min request limit) and an ALB (60 s idle timeout by default) fight
that. A plain EC2 box with Docker just works.

## Read this first — two honest warnings

1. **YouTube often blocks AWS/datacenter IPs** ("Sign in to confirm you're
   not a bot"). TikTok/Instagram/Facebook are usually fine. If YouTube
   fails on the server but works on your laptop, see
   [YouTube bot-check](#youtube-bot-check) below. It is not a bug in the app.
2. **Don't leave it open to the whole internet.** Every download uses your
   bandwidth (AWS charges ~$0.09/GB after the first 100 GB/month) and CPU.
   Turn on the password (step 6) and a billing alarm (step 9).
   Also: only download content you have the right to, and respect each
   platform's Terms of Service.

## 1. Launch the server

AWS Console → **EC2 → Launch instance**

| Setting | Value |
| --- | --- |
| Name | `videograb` |
| AMI | Ubuntu Server 24.04 LTS |
| Type | `t3.small` (2 GB RAM). `t3.micro` can run out of memory merging HD. |
| Key pair | Create one and **keep the .pem file safe** |
| Storage | **30 GB gp3** (HD merges use temporary disk space) |
| Security group | Allow **SSH 22 → My IP only**, **HTTP 80** and **HTTPS 443** from anywhere |

## 2. Give it a fixed IP

EC2 → **Elastic IPs → Allocate → Associate** with the instance. Without
this, the IP changes on every stop/start.

## 3. Point a domain at it (needed for HTTPS)

- Have a domain? Add an **A record** `videos.yourdomain.com → <Elastic IP>`
  (Route 53 or your registrar).
- No domain? Use a free one built from the IP: for IP `3.80.12.34` use
  `3-80-12-34.sslip.io` — Caddy will get a real certificate for it.

HTTPS isn't optional here: browsers only allow the **Paste** button and
**Copy link** on HTTPS.

## 4. Install Docker on the server

```bash
ssh -i your-key.pem ubuntu@<Elastic IP>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit        # log out and back in so the group applies
```

## 5. Copy the project and configure it

From your computer (inside the folder that contains `video-downloader/`):

```bash
scp -i your-key.pem -r video-downloader ubuntu@<Elastic IP>:~/
ssh -i your-key.pem ubuntu@<Elastic IP>
cd video-downloader
cp .env.example .env
nano .env        # set DOMAIN=…  and  URL_SECRET=$(openssl rand -hex 32)
```

(Skip uploading `node_modules` — `.dockerignore` already excludes it, but
`scp` copies everything, so delete the local `node_modules` folders first
to save time.)

## 6. Password‑protect it (recommended)

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'choose-a-password'
nano deploy/Caddyfile      # uncomment basic_auth, replace <paste-hash-here>
```

## 7. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes a few minutes. Then check:

```bash
curl https://videos.yourdomain.com/health      # {"status":"ok"}
docker compose -f docker-compose.prod.yml logs -f app
```

Open `https://videos.yourdomain.com` in your browser. Done.

## 8. Day‑to‑day

| Task | Command (in `~/video-downloader`) |
| --- | --- |
| See logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| Update yt-dlp (do this when downloads stop working) | `docker compose -f docker-compose.prod.yml restart app` — it updates itself on every start |
| Deploy new code | upload the files again, then `docker compose -f docker-compose.prod.yml up -d --build` |
| Stop | `docker compose -f docker-compose.prod.yml down` |

Optional: auto‑update weekly with `crontab -e` →
`0 4 * * 0 cd ~/video-downloader && docker compose -f docker-compose.prod.yml restart app`

## 9. Protect your wallet

- **Billing alarm:** Billing → Budgets → create a $20/month budget with an
  email alert.
- Keep `MAX_CONCURRENT_JOBS=2` and the default rate limits.
- Keep the password on.

## YouTube bot-check

If YouTube downloads fail with the bot-check message only on the server:

1. **Cookies** (free, but fragile): in a browser logged into a *throwaway*
   Google account, export `cookies.txt` (Netscape format) with a
   "Get cookies.txt" extension. Upload it to `~/video-downloader/cookies.txt`
   on the server, uncomment the `volumes:` lines in
   `docker-compose.prod.yml`, add `COOKIES_FILE=/run/cookies.txt` to `.env`,
   then `docker compose -f docker-compose.prod.yml up -d`.
   Cookies expire; repeat when it breaks. Don't use your main account.
2. **Proxy:** set `YTDLP_PROXY=http://user:pass@host:port` in `.env`
   (e.g. a residential proxy service).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOMAIN` | – | Your domain (used by Caddy) |
| `URL_SECRET` | random per start | Signs direct links; set it so links survive restarts |
| `MAX_CONCURRENT_JOBS` | 3 | Parallel HD/MP3 jobs |
| `RATE_LIMIT_INFO` / `RATE_LIMIT_STREAM` | 20 / 30 | Requests per minute per IP |
| `INFO_TIMEOUT_MS` | 60000 | Max time to look up a video |
| `JOB_TIMEOUT_MS` | 1200000 | Max time for one download job |
| `COOKIES_FILE` | – | Path to cookies.txt inside the container |
| `YTDLP_PROXY` | – | Proxy passed to yt-dlp |
| `CORS_ORIGIN` | – | Only if the frontend is hosted on another origin |
