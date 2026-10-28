/**
 * server/index.js — Dramora backend.
 * Viewer: catalog, detail, vertical player (Range streaming), coin unlocks,
 * shop, library. Admin: series/episode CRUD + uploads (multer) + stats.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { db, applyLedger, DATA_DIR, probe, getSettings, setSetting } = require('./db');
const { sessionMiddleware, signupHandler, loginHandler, logoutHandler, meHandler, requireAuth, requireAdmin, publicUser, isVip } = require('./auth');
const payments = require('./payments');
const ads = require('./ads');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3200;
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);

const VID_DIR = path.join(DATA_DIR, 'uploads/videos');
const POSTER_DIR = path.join(DATA_DIR, 'uploads/posters');
const THUMB_DIR = path.join(DATA_DIR, 'uploads/thumbs');
const LOGO_DIR = path.join(DATA_DIR, 'uploads/logos');

function storageFor(dir, prefix) {
  return multer.diskStorage({
    destination: dir,
    filename: (_req, file, cb) => cb(null, `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname).toLowerCase()}`),
  });
}
const uploadVideo = multer({ storage: storageFor(VID_DIR, 'ep'), limits: { fileSize: 500 * 1024 * 1024 }, fileFilter: (_r, f, cb) => cb(null, /video|mp4|mov|webm|mkv/i.test(f.mimetype) || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.originalname)) });
const uploadImage = multer({ storage: storageFor(POSTER_DIR, 'poster'), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_r, f, cb) => cb(null, /image/i.test(f.mimetype) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.originalname)) });
const uploadEpFiles = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'thumb' ? THUMB_DIR : VID_DIR),
  filename: (_req, file, cb) => cb(null, `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname).toLowerCase()}`),
}), limits: { fileSize: 500 * 1024 * 1024 } });

// ---------- v2: 480p rendition ----------
// Transcode a portrait video to a 480-wide rendition next to the original.
// Async + best-effort: a failed transcode logs and leaves rendition_file NULL
// (original keeps working) — it must never fail an upload.
function renditionName(videoFile) { return videoFile.replace(/(\.[^.]+)$/, '-480p$1'); }
function makeRendition(epId, videoFile) {
  const src = path.join(VID_DIR, path.basename(videoFile));
  const outName = renditionName(path.basename(videoFile));
  const out = path.join(VID_DIR, outName);
  execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src], (perr, stdout) => {
    const [w, h] = !perr && stdout ? stdout.trim().split(',').map(Number) : [0, 0];
    if (!w || h <= 500) { console.log(`[dramora] rendition skipped for ${videoFile} (source ${w}x${h} already small)`); return; }
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', 'scale=480:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out], (ferr) => {
      if (ferr) { console.log(`[dramora] rendition FAILED for ${videoFile}: ${ferr.message}`); return; }
      try { db.prepare('UPDATE episodes SET rendition_file=? WHERE id=?').run(outName, epId); console.log(`[dramora] rendition ready: ${outName}`); } catch (e) { console.log(`[dramora] rendition db update failed: ${e.message}`); }
    });
  });
}

// ---------- helpers ----------
function seriesRow(s, userId) {
  let inList = false;
  if (userId) inList = !!db.prepare('SELECT 1 FROM mylist WHERE user_id=? AND series_id=?').get(userId, s.id);
  const epCount = db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE series_id=?').get(s.id).n;
  return { ...s, is_18plus: !!s.is_18plus, episode_count: epCount, in_my_list: inList, poster_url: s.poster_file ? `/media/posters/${s.poster_file}` : null };
}
function episodeState(ep, series, user) {
  const isFree = ep.ep_number <= series.free_episodes;
  let unlocked = isFree;
  let unlockRow = null;
  if (user) {
    if (isVip(user)) unlocked = true;
    unlockRow = db.prepare('SELECT * FROM unlocks WHERE user_id=? AND episode_id=?').get(user.id, ep.id);
    if (unlockRow) unlocked = true;
  }
  let progress = null;
  if (user) progress = db.prepare('SELECT * FROM history WHERE user_id=? AND episode_id=?').get(user.id, ep.id);
  return {
    id: ep.id, series_id: ep.series_id, ep_number: ep.ep_number, season_number: ep.season_number || 1, title: ep.title,
    duration_sec: ep.duration_sec, file_size: ep.file_size, views: ep.views,
    has_video: !!ep.video_file, has_rendition: !!ep.rendition_file, is_free: isFree, price: isFree ? 0 : series.coin_price,
    unlocked, unlock_source: unlockRow ? (unlockRow.source || 'coins') : null,
    thumb_url: ep.thumb_file ? `/media/thumbs/${ep.thumb_file}` : null,
    progress_sec: progress ? progress.progress_sec : 0,
  };
}
function getSeriesAndEp(epId) {
  const ep = db.prepare('SELECT * FROM episodes WHERE id=?').get(epId);
  if (!ep) return {};
  const series = db.prepare('SELECT * FROM series WHERE id=?').get(ep.series_id);
  return { ep, series };
}

// ---------- health + auth ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, app: getSettings().app_name }));

// ---------- v2: branding (public, applied by the UI on load) ----------
function brandingPayload() {
  const s = getSettings();
  return { app_name: s.app_name, tagline: s.tagline, accent_color: s.accent_color, logo_url: s.logo_file ? `/media/logos/${s.logo_file}` : null, manifest_name: `${s.app_name} — Short Drama Streaming` };
}
app.get('/api/branding', (_req, res) => res.json({ branding: brandingPayload() }));
app.post('/api/auth/signup', signupHandler);
app.post('/api/auth/login', loginHandler);
app.post('/api/auth/logout', logoutHandler);
app.get('/api/auth/me', meHandler);

// ---------- catalog ----------
app.get('/api/home', (req, res) => {
  const uid = req.session.userId || null;
  const published = db.prepare("SELECT * FROM series WHERE status='published' ORDER BY views DESC, id DESC").all();
  const trending = published.slice(0, 10).map(s => seriesRow(s, uid));
  const newest = [...published].sort((a, b) => b.id - a.id).slice(0, 10).map(s => seriesRow(s, uid));
  let cont = [];
  if (uid) {
    cont = db.prepare(`SELECT h.*, e.title AS ep_title, e.ep_number, s.title AS series_title, s.poster_file FROM history h JOIN episodes e ON e.id=h.episode_id JOIN series s ON s.id=h.series_id WHERE h.user_id=? ORDER BY h.updated_at DESC LIMIT 10`).all(uid)
      .map(r => ({ ...r, poster_url: r.poster_file ? `/media/posters/${r.poster_file}` : null }));
  }
  res.json({ hero: trending[0] || null, trending, new_releases: newest, continue_watching: cont, genres: [...new Set(published.map(s => s.genre))] });
});
app.get('/api/series', (req, res) => {
  const uid = req.session.userId || null;
  const { genre, q } = req.query;
  let rows = db.prepare("SELECT * FROM series WHERE status='published' ORDER BY views DESC, id DESC").all();
  if (genre && genre !== 'All') rows = rows.filter(s => s.genre === genre);
  if (q) { const needle = String(q).toLowerCase(); rows = rows.filter(s => (s.title + ' ' + s.genre + ' ' + s.tags + ' ' + s.synopsis).toLowerCase().includes(needle)); }
  res.json({ series: rows.map(s => seriesRow(s, uid)), genres: [...new Set(db.prepare("SELECT DISTINCT genre FROM series WHERE status='published'").all().map(r => r.genre))] });
});
app.get('/api/series/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s || (s.status !== 'published' && !(req.session.userId && db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId)?.is_admin))) return res.status(404).json({ error: 'Series not found.' });
  const user = req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null;
  const eps = db.prepare('SELECT * FROM episodes WHERE series_id=? ORDER BY season_number, ep_number').all(s.id).map(ep => episodeState(ep, s, user));
  // v2: group episodes by season (UI renders "Season N" headings when >1).
  const seasons = [];
  for (const ep of eps) {
    let g = seasons.find(x => x.season_number === ep.season_number);
    if (!g) { g = { season_number: ep.season_number, episodes: [] }; seasons.push(g); }
    g.episodes.push(ep);
  }
  res.json({ series: seriesRow(s, req.session.userId || null), episodes: eps, seasons });
});

// ---------- wallet + shop ----------
app.get('/api/wallet', requireAuth, (req, res) => {
  const ledger = db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json({ balance: req.user.balance, is_vip: !!isVip(req.user), vip_until: req.user.vip_until || null, ledger });
});
app.get('/api/shop/packs', (_req, res) => res.json({ packs: payments.PACKS, provider: payments.providerStatus() }));
app.post('/api/shop/checkout', requireAuth, (req, res) => {
  try {
    const r = payments.createCheckout(req.user.id, (req.body || {}).packId);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    res.json({ ok: true, mode: r.mode, balance: r.balance, purchase: r.purchase, user: publicUser(u), message: 'Demo checkout complete — no real payment was taken.' });
  } catch (e) { res.status(e.code === 'BAD_PACK' ? 400 : 503).json({ error: e.message }); }
});

// ---------- playback / unlock / progress ----------
app.post('/api/episodes/:id/play', requireAuth, (req, res) => {
  const { ep, series } = getSeriesAndEp(req.params.id);
  if (!ep) return res.status(404).json({ error: 'Episode not found.' });
  const st = episodeState(ep, series, req.user);
  if (!st.unlocked) return res.status(402).json({ error: 'locked', price: st.price, balance: req.user.balance });
  if (!ep.video_file) return res.status(409).json({ error: 'Video not uploaded yet for this episode. The admin can upload it from the Admin dashboard.' });
  db.prepare('UPDATE episodes SET views=views+1 WHERE id=?').run(ep.id);
  db.prepare('UPDATE series SET views=views+1 WHERE id=?').run(series.id);
  db.prepare(`INSERT INTO history (user_id, episode_id, series_id, progress_sec, duration_sec, updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_id, episode_id) DO UPDATE SET updated_at=datetime('now')`).run(req.user.id, ep.id, series.id, st.progress_sec || 0, ep.duration_sec || null);
  const eps = db.prepare('SELECT * FROM episodes WHERE series_id=? ORDER BY season_number, ep_number').all(series.id).map(e => episodeState(e, series, req.user));
  res.json({ ok: true, stream_url: `/stream/episodes/${ep.id}`, stream_url_480: ep.rendition_file ? `/stream/episodes/${ep.id}?q=480` : null, episode: st, episodes: eps, series: { id: series.id, title: series.title } });
});
app.post('/api/episodes/:id/unlock', requireAuth, (req, res) => {
  const { ep, series } = getSeriesAndEp(req.params.id);
  if (!ep) return res.status(404).json({ error: 'Episode not found.' });
  const st = episodeState(ep, series, req.user);
  if (st.unlocked) return res.json({ ok: true, already: true, balance: req.user.balance });
  try {
    const charged = applyLedger(req.user.id, -st.price, 'unlock', `episode:${ep.id}`, `Unlock ${series.title} Ep ${ep.ep_number}`);
    db.prepare("INSERT INTO unlocks (user_id, episode_id, series_id, price_paid, source) VALUES (?,?,?,?, 'coins')").run(req.user.id, ep.id, series.id, st.price);
    return res.json({ ok: true, balance: charged.balance, price_paid: st.price });
  } catch (e) {
    if (e.code === 'INSUFFICIENT') return res.status(402).json({ error: `Not enough coins — this episode costs ${st.price} and you have ${req.user.balance}. Get more in the Shop.`, need_shop: true });
    throw e;
  }
});
app.post('/api/episodes/:id/progress', requireAuth, (req, res) => {
  const { ep } = getSeriesAndEp(req.params.id);
  if (!ep) return res.status(404).json({ error: 'Episode not found.' });
  const p = Math.max(0, Number((req.body || {}).progress_sec) || 0);
  const d = Number((req.body || {}).duration_sec) || ep.duration_sec || null;
  db.prepare(`INSERT INTO history (user_id, episode_id, series_id, progress_sec, duration_sec, updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_id, episode_id) DO UPDATE SET progress_sec=excluded.progress_sec, duration_sec=excluded.duration_sec, updated_at=datetime('now')`).run(req.user.id, ep.id, ep.series_id, p, d);
  res.json({ ok: true });
});

// Video streaming — express sendFile honours HTTP Range (206) for seeking.
// v2: ?q=480 serves the lower rendition when one exists (else the original).
app.get('/stream/episodes/:id', requireAuth, (req, res) => {
  const { ep, series } = getSeriesAndEp(req.params.id);
  if (!ep || !ep.video_file) return res.status(404).json({ error: 'Video not uploaded yet.' });
  const st = episodeState(ep, series, req.user);
  if (!st.unlocked) return res.status(402).json({ error: 'locked' });
  let file = ep.video_file;
  if (req.query.q === '480' && ep.rendition_file) file = ep.rendition_file;
  const full = path.join(VID_DIR, path.basename(file));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Video file is missing.' });
  res.sendFile(full);
});

// ---------- v2: rewarded ads (DEMO — see server/ads.js) ----------
app.get('/api/ads/status', requireAuth, (req, res) => res.json(ads.adStatus(req.user.id)));
app.post('/api/ads/session', requireAuth, (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'earn' ? 'earn' : 'unlock';
  try {
    if (kind === 'unlock') {
      const { ep, series } = getSeriesAndEp(b.episode_id);
      if (!ep) return res.status(404).json({ error: 'Episode not found.' });
      const st = episodeState(ep, series, req.user);
      if (st.unlocked) return res.status(409).json({ error: 'This episode is already unlocked for you.' });
    }
    res.json({ ok: true, ...ads.startSession(req.user.id, kind, b.episode_id) });
  } catch (e) { res.status(e.code === 'AD_CAP' ? 429 : 400).json({ error: e.message, code: e.code }); }
});
app.post('/api/ads/complete', requireAuth, (req, res) => {
  try { res.json({ ok: true, ...ads.completeSession(req.user.id, String((req.body || {}).token || '')) }); }
  catch (e) { res.status(e.code === 'AD_CAP' ? 429 : 400).json({ error: e.message, code: e.code }); }
});

// ---------- v2: notifications inbox ----------
function notifForUser(n, userId) {
  const read = n.is_broadcast
    ? !!db.prepare('SELECT 1 FROM notification_reads WHERE notification_id=? AND user_id=?').get(n.id, userId)
    : !!n.read_at;
  return { id: n.id, title: n.title, body: n.body, is_broadcast: !!n.is_broadcast, created_at: n.created_at, read };
}
app.get('/api/notifications', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? OR is_broadcast=1 ORDER BY id DESC LIMIT 50').all(req.user.id);
  const list = rows.map(n => notifForUser(n, req.user.id));
  res.json({ notifications: list, unread_count: list.filter(n => !n.read).length });
});
app.post('/api/notifications/read-all', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? OR is_broadcast=1').all(req.user.id);
  const tx = db.transaction(() => {
    for (const n of rows) {
      if (n.is_broadcast) db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?,?)').run(n.id, req.user.id);
      else if (!n.read_at) db.prepare("UPDATE notifications SET read_at=datetime('now') WHERE id=?").run(n.id);
    }
  });
  tx();
  res.json({ ok: true, unread_count: 0 });
});

// ---------- v2: Web Push SCAFFOLD (storage only — nothing is sent yet) ----------
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = (req.body && (req.body.subscription || req.body)) || null;
  const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : null;
  if (!endpoint) return res.status(400).json({ error: 'A push subscription with an endpoint is required.' });
  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, subscription_json) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, subscription_json=excluded.subscription_json')
    .run(req.user.id, endpoint, JSON.stringify(sub));
  res.json({ ok: true, note: 'Subscription stored. Live push delivery is not enabled yet — it needs VAPID keys + an HTTPS deployment (see README).' });
});

// ---------- library ----------
app.get('/api/library', requireAuth, (req, res) => {
  const uid = req.user.id;
  const myList = db.prepare('SELECT s.* FROM mylist m JOIN series s ON s.id=m.series_id WHERE m.user_id=? ORDER BY m.created_at DESC').all(uid).map(s => seriesRow(s, uid));
  const cont = db.prepare(`SELECT h.*, e.title AS ep_title, e.ep_number, s.title AS series_title, s.poster_file FROM history h JOIN episodes e ON e.id=h.episode_id JOIN series s ON s.id=h.series_id WHERE h.user_id=? ORDER BY h.updated_at DESC LIMIT 20`).all(uid).map(r => ({ ...r, poster_url: r.poster_file ? `/media/posters/${r.poster_file}` : null }));
  const unlocks = db.prepare(`SELECT u.*, e.title AS ep_title, e.ep_number, s.title AS series_title FROM unlocks u JOIN episodes e ON e.id=u.episode_id JOIN series s ON s.id=u.series_id WHERE u.user_id=? ORDER BY u.id DESC`).all(uid);
  res.json({ my_list: myList, continue_watching: cont, unlocks });
});
app.post('/api/series/:id/mylist', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const exists = db.prepare('SELECT 1 FROM mylist WHERE user_id=? AND series_id=?').get(req.user.id, s.id);
  if (exists) { db.prepare('DELETE FROM mylist WHERE user_id=? AND series_id=?').run(req.user.id, s.id); return res.json({ ok: true, in_my_list: false }); }
  db.prepare('INSERT INTO mylist (user_id, series_id) VALUES (?,?)').run(req.user.id, s.id);
  return res.json({ ok: true, in_my_list: true });
});

// ---------- media (public posters/thumbs) ----------
app.get('/media/posters/:file', (req, res) => { const f = path.join(POSTER_DIR, path.basename(req.params.file)); if (!fs.existsSync(f)) return res.status(404).end(); res.sendFile(f); });
app.get('/media/logos/:file', (req, res) => { const f = path.join(LOGO_DIR, path.basename(req.params.file)); if (!fs.existsSync(f)) return res.status(404).end(); res.sendFile(f); });
app.get('/media/thumbs/:file', (req, res) => { const f = path.join(THUMB_DIR, path.basename(req.params.file)); if (!fs.existsSync(f)) return res.status(404).end(); res.sendFile(f); });

// ---------- admin ----------
app.get('/api/admin/stats', requireAuth, requireAdmin, (_req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  res.json({ stats: {
    series: one('SELECT COUNT(*) AS n FROM series'), episodes: one('SELECT COUNT(*) AS n FROM episodes'),
    episodes_with_video: one('SELECT COUNT(*) AS n FROM episodes WHERE video_file IS NOT NULL'),
    users: one('SELECT COUNT(*) AS n FROM users'), total_views: one('SELECT COALESCE(SUM(views),0) AS n FROM episodes'),
    total_unlocks: one('SELECT COUNT(*) AS n FROM unlocks'),
    total_coins_spent: Math.abs(db.prepare("SELECT COALESCE(SUM(delta),0) AS n FROM ledger WHERE delta<0").get().n),
    purchases: one('SELECT COUNT(*) AS n FROM purchases'),
  }, payments: payments.providerStatus() });
});
// ---------- v2 admin: branding + broadcast ----------
app.get('/api/admin/settings', requireAuth, requireAdmin, (_req, res) => res.json({ settings: getSettings(), branding: brandingPayload() }));
app.put('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.app_name !== undefined) { const v = String(b.app_name).trim().slice(0, 40); if (!v) return res.status(400).json({ error: 'App name cannot be empty.' }); setSetting('app_name', v); }
  if (b.tagline !== undefined) setSetting('tagline', String(b.tagline).trim().slice(0, 120));
  if (b.accent_color !== undefined) { const v = String(b.accent_color).trim(); if (!/^#[0-9a-fA-F]{6}$/.test(v)) return res.status(400).json({ error: 'Accent color must be a hex color like #ff2e63.' }); setSetting('accent_color', v); }
  res.json({ ok: true, settings: getSettings(), branding: brandingPayload() });
});
const uploadLogo = multer({ storage: storageFor(LOGO_DIR, 'logo'), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_r, f, cb) => cb(null, /image/i.test(f.mimetype) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.originalname)) });
app.post('/api/admin/branding/logo', requireAuth, requireAdmin, uploadLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No logo image received.' });
  const prev = getSettings().logo_file;
  if (prev) fs.rmSync(path.join(LOGO_DIR, path.basename(prev)), { force: true });
  setSetting('logo_file', req.file.filename);
  res.json({ ok: true, branding: brandingPayload() });
});
app.post('/api/admin/broadcast', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  const body = String(b.body || '').trim().slice(0, 1000);
  if (!title) return res.status(400).json({ error: 'Notification title is required.' });
  const info = db.prepare('INSERT INTO notifications (user_id, is_broadcast, title, body) VALUES (NULL, 1, ?, ?)').run(title, body);
  const recipients = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ ok: true, id: info.lastInsertRowid, recipients });
});

app.get('/api/admin/series', requireAuth, requireAdmin, (req, res) => {
  res.json({ series: db.prepare('SELECT * FROM series ORDER BY id DESC').all().map(s => seriesRow(s, req.user.id)) });
});
app.post('/api/admin/series', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const slug = (String(b.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `series-${Date.now()}`);
  try {
    const info = db.prepare(`INSERT INTO series (slug,title,genre,synopsis,tags,status,free_episodes,coin_price,is_18plus) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(slug, title, String(b.genre || 'Drama'), String(b.synopsis || ''), String(b.tags || ''), b.status === 'draft' ? 'draft' : 'published', Math.max(0, parseInt(b.free_episodes, 10) || 0), Math.max(0, parseInt(b.coin_price, 10) || 15), b.is_18plus ? 1 : 0);
    return res.json({ series: seriesRow(db.prepare('SELECT * FROM series WHERE id=?').get(info.lastInsertRowid), req.user.id) });
  } catch (e) { return res.status(409).json({ error: 'Slug already exists — pick a different title/slug.' }); }
});
app.put('/api/admin/series/:id', requireAuth, requireAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const b = req.body || {};
  db.prepare(`UPDATE series SET title=?, genre=?, synopsis=?, tags=?, status=?, free_episodes=?, coin_price=?, is_18plus=?, updated_at=datetime('now') WHERE id=?`)
    .run(String(b.title ?? s.title), String(b.genre ?? s.genre), String(b.synopsis ?? s.synopsis), String(b.tags ?? s.tags), b.status === 'draft' ? 'draft' : 'published', Math.max(0, parseInt(b.free_episodes, 10) ?? s.free_episodes), Math.max(0, parseInt(b.coin_price, 10) ?? s.coin_price), b.is_18plus ? 1 : 0, s.id);
  return res.json({ series: seriesRow(db.prepare('SELECT * FROM series WHERE id=?').get(s.id), req.user.id) });
});
app.delete('/api/admin/series/:id', requireAuth, requireAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const eps = db.prepare('SELECT * FROM episodes WHERE series_id=?').all(s.id);
  db.prepare('DELETE FROM episodes WHERE series_id=?').run(s.id);
  db.prepare('DELETE FROM series WHERE id=?').run(s.id);
  if (s.poster_file) fs.rmSync(path.join(POSTER_DIR, path.basename(s.poster_file)), { force: true });
  for (const ep of eps) { if (ep.video_file && !String(ep.video_file).startsWith('seed-')) { fs.rmSync(path.join(VID_DIR, path.basename(ep.video_file)), { force: true }); if (ep.rendition_file) fs.rmSync(path.join(VID_DIR, path.basename(ep.rendition_file)), { force: true }); } }
  return res.json({ ok: true });
});
app.post('/api/admin/series/:id/poster', requireAuth, requireAdmin, uploadImage.single('poster'), (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  if (!req.file) return res.status(400).json({ error: 'No poster image received.' });
  if (s.poster_file) fs.rmSync(path.join(POSTER_DIR, path.basename(s.poster_file)), { force: true });
  db.prepare('UPDATE series SET poster_file=? WHERE id=?').run(req.file.filename, s.id);
  return res.json({ ok: true, poster_url: `/media/posters/${req.file.filename}` });
});
app.get('/api/admin/series/:id/episodes', requireAuth, requireAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const eps = db.prepare('SELECT * FROM episodes WHERE series_id=? ORDER BY season_number, ep_number').all(s.id);
  res.json({ series: seriesRow(s, req.user.id), episodes: eps.map(ep => ({ ...ep, has_video: !!ep.video_file, has_rendition: !!ep.rendition_file, season_number: ep.season_number || 1 })) });
});
app.post('/api/admin/series/:id/episodes', requireAuth, requireAdmin, uploadEpFiles.fields([{ name: 'video', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const epNum = parseInt(req.body.ep_number, 10);
  if (!epNum || epNum < 1) return res.status(400).json({ error: 'Episode number is required.' });
  const seasonNum = Math.max(1, parseInt(req.body.season_number, 10) || 1);
  const video = req.files && req.files.video && req.files.video[0];
  const thumb = req.files && req.files.thumb && req.files.thumb[0];
  // If thumb was stored in poster dir flow, move handling: multer dest already routes thumbs to THUMB_DIR; posters field not used here.
  let dur = null, size = null, videoFile = null;
  if (video) { videoFile = video.filename; const p = probe(video.path); dur = p.duration; size = p.size || video.size; }
  const thumbFile = thumb ? thumb.filename : null;
  // thumb files uploaded via 'thumb' field land in THUMB_DIR per storage router; if ext is image and it landed in VID_DIR (older), it's fine — basename served from THUMB_DIR only, so copy if needed
  if (thumb && thumb.destination !== THUMB_DIR) { fs.copyFileSync(thumb.path, path.join(THUMB_DIR, thumb.filename)); }
  try {
    const existing = db.prepare('SELECT * FROM episodes WHERE series_id=? AND ep_number=?').get(s.id, epNum);
    if (existing) {
      // A replaced video invalidates the old rendition — drop it, regenerate below.
      if (videoFile && existing.rendition_file) fs.rmSync(path.join(VID_DIR, path.basename(existing.rendition_file)), { force: true });
      db.prepare('UPDATE episodes SET title=?, season_number=?, video_file=COALESCE(?,video_file), thumb_file=COALESCE(?,thumb_file), duration_sec=COALESCE(?,duration_sec), file_size=COALESCE(?,file_size), rendition_file=CASE WHEN ? IS NOT NULL THEN NULL ELSE rendition_file END WHERE id=?')
        .run(String(req.body.title || existing.title), seasonNum, videoFile, thumbFile, dur, size, videoFile, existing.id);
      if (videoFile) makeRendition(existing.id, videoFile);
      return res.json({ ok: true, updated: true, episode: db.prepare('SELECT * FROM episodes WHERE id=?').get(existing.id) });
    }
    const info = db.prepare('INSERT INTO episodes (series_id, ep_number, season_number, title, video_file, thumb_file, duration_sec, file_size) VALUES (?,?,?,?,?,?,?,?)')
      .run(s.id, epNum, seasonNum, String(req.body.title || `Episode ${epNum}`), videoFile, thumbFile, dur, size);
    if (videoFile) makeRendition(info.lastInsertRowid, videoFile);
    return res.json({ ok: true, episode: db.prepare('SELECT * FROM episodes WHERE id=?').get(info.lastInsertRowid) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/episodes/:id', requireAuth, requireAdmin, (req, res) => {
  const ep = db.prepare('SELECT * FROM episodes WHERE id=?').get(req.params.id);
  if (!ep) return res.status(404).json({ error: 'Episode not found.' });
  db.prepare('DELETE FROM episodes WHERE id=?').run(ep.id);
  if (ep.video_file && !String(ep.video_file).startsWith('seed-')) { fs.rmSync(path.join(VID_DIR, path.basename(ep.video_file)), { force: true }); if (ep.rendition_file) fs.rmSync(path.join(VID_DIR, path.basename(ep.rendition_file)), { force: true }); }
  if (ep.thumb_file) fs.rmSync(path.join(THUMB_DIR, path.basename(ep.thumb_file)), { force: true });
  return res.json({ ok: true });
});

// ---------- static SPA ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/') || req.path.startsWith('/stream/')) return next();
  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.listen(PORT, () => console.log(`[dramora] listening on http://localhost:${PORT} · payments: ${payments.providerStatus().mode}`));
