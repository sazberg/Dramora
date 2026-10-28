/**
 * ads.js — Rewarded ads (AVOD), DEMO implementation.
 *
 * ============================================================================
 * GOING LIVE WITH REAL ADS — this file is the ONE place to change.
 * Set AD_PROVIDER to your network (e.g. 'admob') and AD_CREATIVE_URL /
 * the network's rewarded-ad unit, then replace the simulated session flow
 * below with the network SDK's server-side verification callback
 * (AdMob SSV, Unity Ads S2S, etc.). Routes in index.js call
 * startSession()/completeSession() and never touch ad internals, and the
 * player overlay in app.js (watchAd) just counts down whatever
 * `duration_sec` the session returns — point it at the real creative.
 * Until then the "ad" is an in-app simulated 15s spot, honestly labeled
 * "DEMO AD" everywhere it appears. No real advertiser is involved.
 * ============================================================================
 */
'use strict';
const crypto = require('crypto');
const { db, applyLedger } = require('./db');

const AD_CONFIG = {
  provider: process.env.AD_PROVIDER || 'demo-simulated',
  creativeUrl: process.env.AD_CREATIVE_URL || null, // real network creative/SDK URL goes here
  durationSec: 15,          // simulated ad length the overlay counts down
  earnCoins: 10,            // "watch ad" reward in Shop/Mine
  earnDailyCap: 5,          // max earn-rewards per user per day (server-enforced)
  // Server-side minimum watch time before a completion is accepted. Defaults
  // to the full ad length; tests may lower it via env. Never set 0 in prod.
  minWatchSec: Number(process.env.AD_MIN_WATCH_SEC || 15),
};

// One-use ad sessions: a completion is only honoured for a token this server
// issued, once, after minWatchSec has elapsed. Prevents instant/replay grants.
const sessions = new Map(); // token -> { userId, kind, episodeId, issuedAt }
function prune() {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.issuedAt > 5 * 60 * 1000) sessions.delete(t);
}

function earnedToday(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE user_id=? AND kind='ad_reward' AND date(created_at)=date('now')").get(userId).n;
}
function adStatus(userId) {
  const earned = earnedToday(userId);
  return { provider: AD_CONFIG.provider, demo: AD_CONFIG.provider === 'demo-simulated', duration_sec: AD_CONFIG.durationSec, earn_coins: AD_CONFIG.earnCoins, earn_daily_cap: AD_CONFIG.earnDailyCap, earned_today: earned, earn_remaining: Math.max(0, AD_CONFIG.earnDailyCap - earned) };
}

function startSession(userId, kind, episodeId) {
  prune();
  if (kind === 'earn' && earnedToday(userId) >= AD_CONFIG.earnDailyCap) {
    throw Object.assign(new Error(`Daily ad-reward limit reached (${AD_CONFIG.earnDailyCap}/day). Come back tomorrow.`), { code: 'AD_CAP' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, kind, episodeId: episodeId || null, issuedAt: Date.now() });
  return { token, duration_sec: AD_CONFIG.durationSec, provider: AD_CONFIG.provider, creative_url: AD_CONFIG.creativeUrl, demo: AD_CONFIG.provider === 'demo-simulated' };
}

function completeSession(userId, token) {
  const s = sessions.get(token);
  if (!s || s.userId !== userId) throw Object.assign(new Error('Ad session not found or expired — start the ad again.'), { code: 'AD_SESSION' });
  const watched = (Date.now() - s.issuedAt) / 1000;
  if (watched < AD_CONFIG.minWatchSec) throw Object.assign(new Error(`Ad not finished yet (${Math.ceil(AD_CONFIG.minWatchSec - watched)}s left).`), { code: 'AD_EARLY' });
  sessions.delete(token); // one-use

  if (s.kind === 'earn') {
    if (earnedToday(userId) >= AD_CONFIG.earnDailyCap) throw Object.assign(new Error(`Daily ad-reward limit reached (${AD_CONFIG.earnDailyCap}/day).`), { code: 'AD_CAP' });
    const r = applyLedger(userId, AD_CONFIG.earnCoins, 'ad_reward', 'ad:earn', `Ad reward (DEMO ad) +${AD_CONFIG.earnCoins} coins`);
    return { kind: 'earn', coins: AD_CONFIG.earnCoins, balance: r.balance, ...adStatus(userId) };
  }
  if (s.kind === 'unlock') {
    const ep = db.prepare('SELECT * FROM episodes WHERE id=?').get(s.episodeId);
    if (!ep) throw Object.assign(new Error('Episode not found.'), { code: 'NO_EP' });
    const existing = db.prepare('SELECT id FROM unlocks WHERE user_id=? AND episode_id=?').get(userId, ep.id);
    if (!existing) db.prepare("INSERT INTO unlocks (user_id, episode_id, series_id, price_paid, source) VALUES (?,?,?,0,'ad')").run(userId, ep.id, ep.series_id);
    const u = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
    return { kind: 'unlock', episode_id: ep.id, already: !!existing, balance: u.balance };
  }
  throw Object.assign(new Error('Unknown ad session kind.'), { code: 'AD_KIND' });
}

module.exports = { AD_CONFIG, adStatus, startSession, completeSession };
