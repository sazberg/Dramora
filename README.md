# Dramora (working title)

A short-drama streaming app modeled on ReelShort / DramaBox / DramaWave / Epnova — built so **Osasu can upload his own short dramas** and viewers can watch, unlock, and binge them.

> **Working title:** "Dramora" is a placeholder only — renamable. The name lives in `public/index.html` (title + logos) and `public/manifest.webmanifest`.

## What works today (MVP, tested end-to-end)

**Viewer**
- Signup / login / logout, bcrypt passwords, session cookies. **First account created = admin.** New viewers get **200 DEMO coins** (clearly labeled in the ledger).
- Home: hero, Continue Watching (from real watch history), Trending rail, New Releases grid, genre chips filter, search.
- Series detail: poster, genre/tags, synopsis, episode grid with FREE / 🔒 coin-price badges, Add to My List, dimmed state for episodes with no video yet.
- Vertical player: full-screen 9:16 video, episode title, Prev / Next + episode picker, resume from saved progress, auto-saves progress, records views + history on play.
- Coin unlocks: locked episode → unlock prompt → transactional ledger deduction (balance + ledger always reconcile) → **permanent unlock**. Insufficient coins → sent to Shop. VIP pass holders unlock everything while active.
- Shop: coin packs (Mini 100 / Starter 300 / Plus 700 / Max 1500) + **VIP Weekly (7 days) / VIP Monthly (30 days)** tiers — all **DEMO checkout, clearly labeled, no real payment, coins land instantly**. Payments sit behind `server/payments.js` so Stripe can be wired later in one file.
- Mine / Library: My List, Continue Watching, My Unlocks, coin balance + full ledger, logout.

**Creator / Admin (first account)**
- Dashboard stats: series count, episode count (and how many have video), users, total views, total unlocks, total coins spent.
- Create / edit / delete series: title, genre, synopsis, tags, status (draft/published), free_episodes count, coin_price_per_episode, 18+ flag, poster image upload.
- Episode management per series: upload episode MP4 (multer, up to **500 MB**, stored in `data/uploads/videos/`), episode number + title, optional thumbnail upload, delete episode, file size + duration probed with ffprobe when available. Uploading to an existing episode number replaces its video.
- Videos stream with **HTTP Range support** (verified: Range request returns `206 Partial Content`) so seeking works on phones.

**Seeded catalog** (metadata + real posters where they exist; episodes exist as rows — the admin uploads videos to fill them):
My Bestie's Brother, My Lie (40 eps) · The Plus One (15) · The Neighbor in 3B (10, tagged 18+) · The Last Checkpoint (20) · Unicorn Land: The Giggle Quest (10, kids) · Shadow of the Solarian (30) · The False Shepherd (5).

**Playable demo:** *The Last Checkpoint — Episode 1* ships with the real 16 MB episode file (`last-checkpoint-episode-1-v5.mp4`, 62s) attached, and Episodes 1–2 are free on that series, so playback works out of the box. Episode 3+ are locked (15 coins) so the unlock flow can be tested once a video is uploaded for them. Other seeded episodes honestly show "Video not uploaded yet" — playback is never faked.

## v2 upgrades (2026-10-27) — closing the Fiverr white-label gig gaps

1. **Seasons** — episodes carry a `season_number` (default 1; migration adds the column to old DBs). The Admin episode form sets it, and series pages group episodes under **Season 1 / Season 2** headings when a series has more than one season. Single-season series look exactly as before. Episode numbers stay unique per series, so numbering continues across seasons (Season 2 picks up where Season 1 ended).
2. **White-label branding** — Admin → Branding sets the **app name, tagline, accent color** and an optional **logo image**. Stored in a `settings` table; the UI fetches `/api/branding` on load and applies name/tagline/accent/logo everywhere (auth screen, header, page title). Untouched, everything stays "Dramora" exactly as before. (The static `<title>`/manifest are still the fallback before JS loads.)
3. **VIP tiers** — the single VIP pass is now **VIP Weekly — $4.99 / 7 days** and **VIP Monthly — $9.99 / 30 days** (+200 bonus coins), demo checkout in `server/payments.js`. Buying while VIP extends from the current expiry. Active VIP = every episode unlocked, ad-free, and Mine shows status + expiry.
4. **Rewarded ads (AVOD) — DEMO, honestly labeled** — a locked episode offers three choices: **coins, VIP, or "Watch ad to unlock"**. The ad is a simulated in-app 15-second spot labeled *"DEMO AD — real ads need an AdMob / ad-network account"*; finishing it unlocks the episode permanently (`unlocks.source = 'ad'`, no coins charged). In the Shop, **"Watch ad +10 coins"** pays a ledger `ad_reward`, capped at **5 per user per day, enforced server-side**. Sessions are one-use server tokens with a minimum watch time, so rewards can't be replayed or claimed instantly. **To go live:** `server/ads.js` is the one integration point — set `AD_PROVIDER` (+ `AD_CREATIVE_URL`) and swap the simulated session for the network's server-side verification (AdMob SSV etc.); routes and the player overlay don't change.
5. **Video quality renditions** — every uploaded episode video is transcoded in the background to a **480p rendition** (480 wide, e.g. 480×854 for portrait; stored as `<file>-480p.mp4` on the episode row). The player shows an **Original / 480p selector** only when a rendition exists, and switching keeps your place + play state. A failed transcode never fails the upload — the original plays and the rendition just stays absent. The seeded Last Checkpoint Ep 1 ships with its 480p rendition pre-generated (`seed-assets/` + `data/uploads/videos/`).
6. **Notifications** — in-app inbox: 🔔 bell in the header with an unread badge, list view, mark-all-read. Admin → **Broadcast** sends a title + message to every user's inbox. **Web Push is SCAFFOLD ONLY:** subscriptions posted to `/api/push/subscribe` are stored in `push_subscriptions`, but **nothing is sent** — live push requires VAPID keys and an HTTPS deployment, and there is deliberately no push opt-in button yet.

**DEMO vs live, plainly:** payments = demo checkout (Stripe wiring point unchanged, `server/payments.js`) · ads = simulated (real network plugs into `server/ads.js`) · push = storage scaffold only (no delivery) · everything else above is fully working.

## Run it locally

```bash
cd ~/workspace/shortdrama-app
npm install
PORT=3200 SESSION_SECRET=any-long-random-string npm start
# open http://localhost:3200 — first signup becomes admin
```

Requirements: Node ≥ 18. `ffprobe` (from ffmpeg) is optional — used for episode duration/size.

Data lives in `data/` (SQLite DB + `data/uploads/`). Delete `data/dramora.db` to reset; the catalog re-seeds on boot (the seeded playable video is re-attached from `data/uploads/videos/seed-last-checkpoint-ep1.mp4` — keep that file).

## Configuration (see `.env.example`)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3200) |
| `SESSION_SECRET` | Session cookie signing secret — set a real one |
| `ADMIN_EMAIL` | This account is always admin (in addition to first-account rule) |
| `PAYMENT_PROCESSOR` | `demo` (default) or `stripe` (wire in `server/payments.js`) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Future live payments |
| `AD_PROVIDER` | `demo-simulated` (default) — set to your ad network when wiring real ads in `server/ads.js` |
| `AD_CREATIVE_URL` | Real ad creative/SDK URL (unused in demo mode) |
| `AD_MIN_WATCH_SEC` | Server-side minimum ad watch time before a reward is honoured (default 15; tests only should lower it) |

## Locked product decisions

1. Coins are the unlock currency; unlocks are **permanent per user** and every coin movement goes through the single transactional ledger in `server/db.js`.
2. Checkout is **demo-only** until a real processor is wired in `server/payments.js` — the UI and API say so plainly.
3. No faked playback: an episode without an uploaded file shows a clean "not uploaded yet" state.
4. Admin = uploader. There is one creator (Osasu); viewers never see Admin.

## Deploy notes (still on Osasu)

- **This sandbox cannot expose a public URL** — deploy on Render or a VPS under your own account.
- **Render (package ready, rehearsed 2026-10-23):** `render.yaml` is included — Blueprint deploy creates the service on the **Starter plan with a 10 GB Persistent Disk mounted at `data/`** (a disk needs a paid plan; ephemeral disk would wipe accounts + videos on every deploy) and generates `SESSION_SECRET`. Seed posters + the playable Last Checkpoint Ep 1 live in `seed-assets/` (outside `data/`) and are copied into the data dir on first boot, so the mounted disk starting empty does not hide them — verified with a clean install + empty data dir: all 7 series seeded, posters serve, Ep 1 streams with Range/206, first signup becomes admin. Steps mirror DraftCruncher: GitHub repo → upload the package → Render **New + → Blueprint → Apply**. **VPS:** pm2/systemd + Caddy/Nginx for HTTPS; persist and back up `data/` — it is the whole business.
- **Video storage will outgrow any single disk fast.** The scale step is moving `data/uploads/videos/` to **S3 / Cloudflare R2 + a CDN** and storing object URLs on episodes instead of local filenames — the streaming route in `server/index.js` is the one place to change.
- **Real payments:** wire Stripe hosted checkout + webhook in `server/payments.js` (the only file that changes); packs/VIP already flow through it.
- **Final app name + store accounts** (Apple Developer / Google Play, if native wrappers come later) are on Osasu. Rename in `public/index.html` + `public/manifest.webmanifest`.

## Project layout

```
server/
  index.js    routes: catalog, player/streaming (?q=480 rendition), unlocks, shop, library, admin CRUD + uploads, branding, ads, notifications, push scaffold
  db.js       SQLite schema (+ v2 migrations: seasons, renditions, unlock source, settings, notifications, push_subscriptions), seed catalog, transactional coin ledger
  auth.js     signup/login/sessions, first-account-admin, 200 DEMO coin grant
  payments.js coin packs + VIP Weekly/Monthly catalog, processor interface (demo today, Stripe later)
  ads.js      rewarded-ads config + session flow — THE integration point for a real ad network (demo-simulated today)
public/
  index.html  app shell (auth, Home / Detail / Shop / Mine / Admin, player)
  app.js      SPA logic
  styles.css  dark UI, phone-column layout
  manifest.webmanifest, sw.js, icon.svg   PWA shell
data/         runtime data (created on boot): dramora.db, uploads/{videos,posters,thumbs}, seed-posters/
```
