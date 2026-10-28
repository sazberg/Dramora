/**
 * server/payments.js — coin packs + VIP behind a processor interface.
 * DEMO mode (default): checkout completes instantly, clearly labeled demo,
 * no real payment, coins land instantly.
 * To go live with Stripe: set PAYMENT_PROCESSOR=stripe + STRIPE_SECRET_KEY
 * and implement hosted checkout + webhook in createCheckout()/verifyWebhook()
 * here — routes never change.
 */
'use strict';
const { db, applyLedger } = require('./db');
const PACKS = [
  { id: 'mini', name: 'Mini', coins: 100, price_cents: 299, blurb: 'A few episodes to get started' },
  { id: 'starter', name: 'Starter', coins: 300, price_cents: 699, blurb: 'One full series, roughly', popular: true },
  { id: 'plus', name: 'Plus', coins: 700, price_cents: 1299, blurb: 'For a binge weekend' },
  { id: 'max', name: 'Max', coins: 1500, price_cents: 2499, blurb: 'Best value per coin' },
  // v2: two VIP tiers (replaces the single v1 VIP pass). VIP = every episode
  // unlocked + ad-free while active (VIP users never see ad-unlock prompts).
  { id: 'vip-weekly', name: 'VIP Weekly', coins: 0, price_cents: 499, blurb: '7 days: unlocks every episode, ad-free', vip_days: 7 },
  { id: 'vip-monthly', name: 'VIP Monthly', coins: 0, price_cents: 999, blurb: '30 days: unlocks every episode, ad-free + 200 bonus coins', vip_days: 30, bonus_coins: 200 },
];
function getPack(id) { return PACKS.find(p => p.id === id) || null; }
function providerStatus() {
  const processor = (process.env.PAYMENT_PROCESSOR || 'demo').toLowerCase();
  return { processor, mode: processor === 'demo' ? 'demo' : 'live', configured: processor === 'demo' ? true : Boolean(process.env.STRIPE_SECRET_KEY), note: processor === 'demo' ? 'Demo checkout is active — no real payment is taken.' : 'Stripe selected; wire createCheckout/verifyWebhook in server/payments.js.' };
}
function createCheckout(userId, packId) {
  const pack = getPack(packId);
  if (!pack) throw Object.assign(new Error('Unknown pack.'), { code: 'BAD_PACK' });
  const status = providerStatus();
  if (status.mode !== 'demo') throw Object.assign(new Error('Live checkout is not wired yet — see server/payments.js.'), { code: 'NOT_CONFIGURED' });
  const info = db.prepare(`INSERT INTO purchases (user_id, pack_id, coins, amount_cents, status, provider) VALUES (?,?,?,?,'completed','demo')`).run(userId, pack.id, pack.coins, pack.price_cents);
  let balance = db.prepare('SELECT balance FROM users WHERE id=?').get(userId).balance;
  const grant = pack.coins + (pack.bonus_coins || 0);
  if (grant > 0) balance = applyLedger(userId, grant, 'purchase', `purchase:${info.lastInsertRowid}`, `${pack.name} pack — DEMO checkout (no real payment)`).balance;
  if (pack.vip_days) {
    // Extend from the current expiry if VIP is still active, else from now.
    const cur = db.prepare('SELECT vip_until FROM users WHERE id=?').get(userId).vip_until;
    const base = cur && new Date(cur) > new Date() ? new Date(cur).getTime() : Date.now();
    const until = new Date(base + pack.vip_days * 864e5).toISOString();
    db.prepare('UPDATE users SET vip_until=? WHERE id=?').run(until, userId);
  }
  return { mode: 'demo', purchase: { id: info.lastInsertRowid, pack_id: pack.id, coins: pack.coins, amount_cents: pack.price_cents, provider: 'demo', status: 'completed' }, balance };
}
module.exports = { PACKS, getPack, providerStatus, createCheckout };
