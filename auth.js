'use strict';
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db, applyLedger } = require('./db');
const DEMO_GRANT = 200;
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dramora-dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 },
});
function isVip(u) { return u.vip_until && new Date(u.vip_until) > new Date(); }
function publicUser(u) { return { id: u.id, email: u.email, is_admin: !!u.is_admin, balance: u.balance, is_vip: !!isVip(u), vip_until: u.vip_until || null, created_at: u.created_at }; }
function getUser(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function signupHandler(req, res) {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const isAdmin = count === 0 || (process.env.ADMIN_EMAIL && cleanEmail === process.env.ADMIN_EMAIL.toLowerCase()) ? 1 : 0;
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?,?,?)').run(cleanEmail, hash, isAdmin);
  const userId = info.lastInsertRowid;
  applyLedger(userId, DEMO_GRANT, 'demo_grant', 'welcome', 'Welcome grant (DEMO coins)');
  req.session.userId = userId;
  return res.json({ user: publicUser(getUser(userId)), demo_grant: DEMO_GRANT });
}
function loginHandler(req, res) {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.userId = user.id;
  return res.json({ user: publicUser(user) });
}
function logoutHandler(req, res) { req.session.destroy(() => res.json({ ok: true })); }
function meHandler(req, res) {
  if (!req.session.userId) return res.json({ user: null });
  const user = getUser(req.session.userId);
  if (!user) { req.session.userId = null; return res.json({ user: null }); }
  return res.json({ user: publicUser(user) });
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in.' });
  const user = getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  req.user = user; return next();
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin access required.' });
  return next();
}
module.exports = { sessionMiddleware, signupHandler, loginHandler, logoutHandler, meHandler, requireAuth, requireAdmin, publicUser, isVip, DEMO_GRANT };
