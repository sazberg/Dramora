/**
 * db.js — Dramora database (better-sqlite3). FLAT EDITION: this file sits at
 * the repo root, next to the seed posters/videos it loads on first boot.
 * Coins: users.balance (cache) + ledger (source of truth). applyLedger() is
 * the ONLY way coins move — one transaction, so they always reconcile.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
for (const sub of ['', 'uploads/videos', 'uploads/posters', 'uploads/thumbs', 'uploads/logos', 'seed-posters']) {
  fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
}
const db = new Database(path.join(DATA_DIR, 'dramora.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  vip_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT 'Drama',
  synopsis TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published',
  free_episodes INTEGER NOT NULL DEFAULT 3,
  coin_price INTEGER NOT NULL DEFAULT 15,
  poster_file TEXT,
  is_18plus INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  ep_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  video_file TEXT,
  thumb_file TEXT,
  duration_sec REAL,
  file_size INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(series_id, ep_number)
);
CREATE TABLE IF NOT EXISTS unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  series_id INTEGER NOT NULL,
  price_paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, episode_id)
);
CREATE TABLE IF NOT EXISTS mylist (
  user_id INTEGER NOT NULL, series_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, series_id)
);
CREATE TABLE IF NOT EXISTS history (
  user_id INTEGER NOT NULL, episode_id INTEGER NOT NULL,
  series_id INTEGER NOT NULL,
  progress_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, episode_id)
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pack_id TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
  provider TEXT NOT NULL DEFAULT 'demo',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- v2: white-label branding settings (key/value)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- v2: in-app notifications. A row is either personal (user_id set) or a
-- broadcast (is_broadcast=1, user_id NULL, visible to everyone). Per-user
-- read state for broadcasts lives in notification_reads.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  is_broadcast INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notification_id, user_id)
);
-- v2: Web Push SCAFFOLD only — subscriptions are stored, nothing is sent
-- until VAPID keys + an HTTPS deployment exist (see README).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  endpoint TEXT UNIQUE NOT NULL,
  subscription_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- v2 migrations (safe on existing DBs: add column only if missing) ----
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn('episodes', 'season_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('episodes', 'rendition_file', 'TEXT');
ensureColumn('unlocks', 'source', "TEXT NOT NULL DEFAULT 'coins'");

// ---- v2 branding settings helpers ----
const SETTING_DEFAULTS = { app_name: 'Dramora', tagline: 'Short dramas. Big twists. One episode at a time.', accent_color: '#ff2e63', logo_file: '' };
function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in out) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value == null ? null : String(value));
}

const applyLedger = db.transaction((userId, delta, kind, ref, note) => {
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  if (!user) throw Object.assign(new Error('User not found'), { code: 'NO_USER' });
  const next = user.balance + delta;
  if (next < 0) throw Object.assign(new Error('Insufficient coins'), { code: 'INSUFFICIENT' });
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(next, userId);
  const info = db.prepare('INSERT INTO ledger (user_id, delta, balance_after, kind, ref, note) VALUES (?,?,?,?,?,?)')
    .run(userId, delta, next, kind, ref || null, note || null);
  return { balance: next, ledgerId: info.lastInsertRowid };
});

function probe(filePath) {
  try {
    const out = execSync(`ffprobe -v error -show_entries format=duration,size -of csv=p=0 "${filePath}"`, { timeout: 8000 }).toString().trim().split(',');
    return { duration: parseFloat(out[0]) || null, size: parseInt(out[1], 10) || null };
  } catch { try { return { duration: null, size: fs.statSync(filePath).size }; } catch { return { duration: null, size: null }; } }
}

// ---- Seed catalog: real metadata from Osasu's produced series ----
const SEED = [
  { slug: 'my-besties-brother-my-lie', title: "My Bestie's Brother, My Lie", genre: 'Romance', tags: 'romantic suspense,vertical,40 episodes', synopsis: 'A 40-episode romantic-suspense vertical series. A lie told to protect the people she loves pulls a young woman into the orbit of her best friend\'s brother — and every episode ends on a secret about to break.', total: 40, free: 3, price: 15, poster: null },
  { slug: 'the-plus-one', title: 'The Plus One', genre: 'Romance', tags: 'romantic suspense,wedding,twist', synopsis: 'Logan Hale marries Sera Sterling — but a bachelor-party night with Mira Voss unravels everything. His best friend Marcus is secretly his half-brother, Sera and Marcus are lovers, and Mira is out for revenge for her sister Elena. Final twist: Mira is pregnant with Logan\'s baby while Sera remains a threat from prison. 15 episodes, cliffhanger endings.', total: 15, free: 3, price: 15, poster: null },
  { slug: 'the-neighbor-in-3b', title: 'The Neighbor in 3B', genre: 'Dark Romance', tags: '18+,adult,dark romance,thriller,Alexandria', synopsis: 'Adult dark romantic drama (18+). In Alexandria, Virginia, Jeff (19, art student) watches Evelyn (31, corporate lawyer) from 3B into 4A for months before they ever speak. Obsession, rules, the firm, the police — and an aftermath nobody walks away clean from. 10 episodes.', total: 10, free: 2, price: 20, poster: null, is18: 1 },
  { slug: 'the-last-checkpoint', title: 'The Last Checkpoint', genre: 'Action', tags: 'action,desert,border,cartel,20 episodes', synopsis: 'A 20-episode vertical action series. At a desert border checkpoint under siege, Agent Mara Reyes and cartel assassin Diego Vargas are forced together. Everyone has a price. 20 episodes. No one leaves clean. Episode 1 is playable in this demo.', total: 20, free: 2, price: 15, poster: 'last-checkpoint.jpg', playableEp: 1, playableFile: 'seed-last-checkpoint-ep1.mp4', epTitles: { 1: 'The Checkpoint' } },
  { slug: 'unicorn-land-the-giggle-quest', title: 'Unicorn Land: The Giggle Quest', genre: 'Kids', tags: 'kids,animation,family,unicorn', synopsis: 'A 10-episode animated kids\' series. Sloane & Lily adventure through Unicorn Land against Queen Grumblebum — with Astra, Prism, the Frownies, Nova, Pip and Dex the dragon. Episode 1: "The Pickle Jar of Doom".', total: 10, free: 10, price: 10, poster: 'unicorn-land.jpg', epTitles: { 1: 'The Pickle Jar of Doom', 2: 'The Call of the Fading Horn', 3: "Dex Tries to Be Nice (It's Awkward)", 4: 'The Snack Pack of Destiny', 5: "Astra's Sparkle Goes Poof", 6: 'The Grumpy Backstory', 7: 'Chicken Sloane and the Egg Map', 8: 'The Party Dex Awakens', 9: 'The Great Giggle Battle', 10: 'The Happily Ever After (Again!)' } },
  { slug: 'shadow-of-the-solarian', title: 'Shadow of the Solarian', genre: 'Fantasy', tags: 'dark fantasy,sci-fi,tragic romance,lycan,vampire', synopsis: 'A 30-episode dark fantasy / sci-fi tragic romance. A retired Lycan Alpha hiding as a quiet archivist inside the Vampire Empire must unleash his beast to save his daughter Elara, falls for enemy scientist Lady Seraphina Vane, and sacrifices his life to destroy High Marshal Draven\'s Sun-Shield weapon.', total: 30, free: 3, price: 15, poster: null },
  { slug: 'the-false-shepherd', title: 'The False Shepherd', genre: 'Drama', tags: 'historical,16th century,Hausa,narration', synopsis: 'A short film / series set in a 16th-century Hausa kingdom. Usman, a fake cleric, builds a following on staged miracles — until Bello, the critic-prophet, begins to expose him before Sarki Dauda, King of Kaya. Told with narration only.', total: 5, free: 1, price: 15, poster: 'false-shepherd.jpg' },
];

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM series').get().n;
  if (count > 0) return;
  const insS = db.prepare(`INSERT INTO series (slug,title,genre,synopsis,tags,status,free_episodes,coin_price,poster_file,is_18plus) VALUES (?,?,?,?,?,'published',?,?,?,?)`);
  const insE = db.prepare(`INSERT INTO episodes (series_id,ep_number,title,video_file,duration_sec,file_size,rendition_file) VALUES (?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const s of SEED) {
      let posterFile = null;
      if (s.poster) {
        // Seed assets live in DATA_DIR locally, but on hosted deploys DATA_DIR is a
        // mounted persistent disk that shadows the repo — fall back to the bundled
        // seed-assets/ folder at the app root so posters survive first boot there.
        let src = path.join(__dirname, s.poster); // FLAT: seed posters live at repo root
        if (!fs.existsSync(src)) src = path.join(DATA_DIR, 'seed-posters', s.poster);
        if (!fs.existsSync(src)) src = path.join(__dirname, 'seed-assets', s.poster);
        if (fs.existsSync(src)) { posterFile = `seed-${s.slug}.jpg`; fs.copyFileSync(src, path.join(DATA_DIR, 'uploads/posters', posterFile)); }
      }
      const info = insS.run(s.slug, s.title, s.genre, s.synopsis, s.tags, s.free, s.price, posterFile, s.is18 ? 1 : 0);
      const sid = info.lastInsertRowid;
      for (let n = 1; n <= s.total; n++) {
        const title = (s.epTitles && s.epTitles[n]) || `Episode ${n}`;
        let video = null, dur = null, size = null, rendition = null;
        if (s.playableEp === n && s.playableFile) {
          const vp = path.join(DATA_DIR, 'uploads/videos', s.playableFile);
          // Same disk-shadow fallback as posters: copy the bundled seed video into
          // the data dir on first boot when the deploy's disk starts empty.
          if (!fs.existsSync(vp)) {
            const bundled = path.join(__dirname, s.playableFile); // FLAT: seed video at repo root
            if (!fs.existsSync(bundled)) { const alt = path.join(__dirname, 'seed-assets', s.playableFile); if (fs.existsSync(alt)) fs.copyFileSync(alt, vp); }
            if (fs.existsSync(bundled)) fs.copyFileSync(bundled, vp);
          }
          if (fs.existsSync(vp)) { video = s.playableFile; const p = probe(vp); dur = p.duration; size = p.size; }
          // v2: attach the pre-generated 480p rendition of the seed video if present.
          const rendName = s.playableFile.replace(/\.mp4$/i, '-480p.mp4');
          const rp = path.join(DATA_DIR, 'uploads/videos', rendName);
          if (!fs.existsSync(rp)) {
            const bundledR = path.join(__dirname, rendName); // FLAT: seed rendition at repo root
            if (fs.existsSync(bundledR)) fs.copyFileSync(bundledR, rp);
            else { const altR = path.join(__dirname, 'seed-assets', rendName); if (fs.existsSync(altR)) fs.copyFileSync(altR, rp); }
          }
          if (fs.existsSync(rp)) rendition = rendName;
        }
        insE.run(sid, n, title, video, dur, size, rendition);
      }
    }
  });
  tx();
}
seed();

// v2: on pre-v2 databases the seeded playable episode already exists without a
// rendition — attach the on-disk 480p file if it has been generated.
(function ensureSeedRendition() {
  try {
    const ep = db.prepare("SELECT id, video_file FROM episodes WHERE video_file='seed-last-checkpoint-ep1.mp4' AND rendition_file IS NULL").get();
    if (!ep) return;
    const rendName = 'seed-last-checkpoint-ep1-480p.mp4';
    const rp = path.join(DATA_DIR, 'uploads/videos', rendName);
    if (!fs.existsSync(rp)) {
      const bundledR = path.join(__dirname, rendName); // FLAT: seed rendition at repo root
      if (fs.existsSync(bundledR)) fs.copyFileSync(bundledR, rp);
      else { const altR = path.join(__dirname, 'seed-assets', rendName); if (fs.existsSync(altR)) fs.copyFileSync(altR, rp); }
    }
    if (fs.existsSync(rp)) db.prepare('UPDATE episodes SET rendition_file=? WHERE id=?').run(rendName, ep.id);
  } catch { /* rendition is optional — never block boot */ }
})();

module.exports = { db, applyLedger, DATA_DIR, probe, getSettings, setSetting, SETTING_DEFAULTS };
