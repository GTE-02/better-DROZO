const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ahlwsktpiymgdvdmjdqq.supabase.co";
// The anon key is public (it is also inside the web pages). Set SUPABASE_SERVICE_ROLE_KEY on Render
// and turn on row-level security for drozo_guard_sessions so browsers cannot read it directly.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFobHdza3RwaXltZ2R2ZG1qZHFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzODY4OTUsImV4cCI6MjEwNjk2Mjg5NX0.8-mzkzp4parfSMVgbKNQ0eqoTazvZHc8R-HRpYcpirY";
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "https://better-drozo.onrender.com";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn("[warn] SESSION_SECRET is not set: everyone is signed out whenever the server restarts.");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "https://gte-02.github.io").split(',').map((s) => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    const ok = !origin || ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    cb(null, ok);
  }
}));
app.use(express.json({ limit: '1mb' }));

// ---------- helpers ----------
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const parts = stored.split(':');
  const x = crypto.scryptSync(pw, Buffer.from(parts[0], 'hex'), 64);
  const y = Buffer.from(parts[1], 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function signToken(email, stage) {
  const ttl = stage === 'pw' ? 10 * 60 * 1000 : 12 * 3600 * 1000;
  const p = Buffer.from(JSON.stringify({ e: email, s: stage, x: Date.now() + ttl })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
}
function readToken(tok) {
  if (!tok) return null;
  const parts = String(tok).split('.');
  if (parts.length !== 2) return null;
  const want = Buffer.from(crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest('base64url'));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let d;
  try { d = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch (_) { return null; }
  return d && d.x > Date.now() ? d : null;
}
function auth(stage) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const d = readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!d || (stage !== 'any' && d.s !== 'full')) return res.status(401).json({ error: 'unauthorized' });
    req.user = { email: d.e, stage: d.s };
    next();
  };
}

const attempts = new Map();
function limited(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 10;
}
function noteFail(key) { const a = attempts.get(key) || []; a.push(Date.now()); attempts.set(key, a); }

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32dec(s) {
  let bits = '';
  for (const c of String(s).replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totpAt(secret, step) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const c = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(c % 1000000).padStart(6, '0');
}
function checkTotp(secret, code, nowMs) {
  const step = Math.floor((nowMs || Date.now()) / 30000);
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (let d = -1; d <= 1; d++) if (totpAt(secret, step + d) === c) return true;
  return false;
}

// ---------- Supabase storage (table drozo_guard_sessions) ----------
const sbHeaders = () => ({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' });
const TABLE = SUPABASE_URL + '/rest/v1/drozo_guard_sessions';

async function sbGet(token) {
  try {
    const r = await fetch(TABLE + '?session_token=eq.' + encodeURIComponent(token) + '&select=status&order=id.desc&limit=1', { headers: sbHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows.length ? rows[0].status : null;
  } catch (_) { return null; }
}
async function sbUpsert(token, email, status) {
  try {
    const up = await fetch(TABLE + '?session_token=eq.' + encodeURIComponent(token), {
      method: 'PATCH', headers: Object.assign(sbHeaders(), { Prefer: 'return=representation' }), body: JSON.stringify({ status: status, email: email })
    });
    if (up.ok) { const rows = await up.json(); if (rows && rows.length) return true; }
    const ins = await fetch(TABLE, {
      method: 'POST', headers: Object.assign(sbHeaders(), { Prefer: 'return=minimal' }), body: JSON.stringify({ session_token: token, email: email, status: status })
    });
    return ins.ok;
  } catch (_) { return false; }
}

// ---------- users ----------
const ADMIN_EMAILS = ['admin@drozominds.com', 'gamerkids1109@gmail.com'];
const isAdmin = (email) => ADMIN_EMAILS.includes(email);
const SEEDS = { 'admin@drozominds.com': process.env.ADMIN_PASSWORD, 'gamerkids1109@gmail.com': process.env.COORDINATOR_PASSWORD };
const seedHashes = new Map();
Object.keys(SEEDS).forEach((email) => {
  if (SEEDS[email]) seedHashes.set(email, hashPw(SEEDS[email]));
  else console.warn('[warn] No password env var for ' + email + ' (ADMIN_PASSWORD / COORDINATOR_PASSWORD): that account cannot sign in.');
});

const users = new Map();
async function loadUser(email) {
  let u = users.get(email);
  if (!u) {
    const raw = await sbGet('USER_' + email);
    if (raw) { try { u = JSON.parse(raw); } catch (_) {} }
  }
  if (seedHashes.has(email)) { u = u || {}; u.hash = seedHashes.get(email); }
  if (u) users.set(email, u);
  return u || null;
}
async function saveUser(email, u) {
  users.set(email, u);
  return sbUpsert('USER_' + email, email, JSON.stringify(u));
}
const sessionBody = (email, stage, needsTotp) => ({ token: signToken(email, stage), email: email, isAdmin: isAdmin(email), needsTotp: !!needsTotp });
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validPw = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128;

// ---------- public routes ----------
app.get('/', (req, res) => res.send('DrozoMind Cloud Engine is Online & Active.'));
app.get('/health', (req, res) => res.json({ status: 'alive', service: 'better-drozo', uptimeSeconds: Math.floor(process.uptime()), timestamp: new Date().toISOString() }));

app.post('/api/register', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = req.body && req.body.password;
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!validPw(password)) return res.status(400).json({ error: 'Password must be 8 to 128 characters.' });
  if (seedHashes.has(email) || SEEDS.hasOwnProperty(email)) return res.status(403).json({ error: 'This email is reserved.' });
  if (await loadUser(email)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const ok = await saveUser(email, { hash: hashPw(password), totp: null });
  if (!ok) { users.delete(email); return res.status(503).json({ error: 'Could not save the account. Try again shortly.' }); }
  res.json(sessionBody(email, 'full', false));
});

app.post('/api/login', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = req.body && req.body.password;
  const key = req.ip + '|' + email;
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = typeof password === 'string' && validEmail(email) ? await loadUser(email) : null;
  if (!u || !checkPw(password, u.hash)) { noteFail(key); return res.status(401).json({ error: 'Incorrect email or password.' }); }
  res.json(sessionBody(email, u.totp ? 'pw' : 'full', !!u.totp));
});

// ---------- signed-in routes ----------
app.post('/api/password', auth('full'), async (req, res) => {
  const email = req.user.email;
  const key = 'pw|' + req.ip + '|' + email;
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts.' });
  const u = await loadUser(email);
  if (!u || !checkPw(String(req.body.oldPassword || ''), u.hash)) { noteFail(key); return res.status(403).json({ error: 'Current password is incorrect.' }); }
  if (!validPw(req.body.newPassword)) return res.status(400).json({ error: 'Password must be 8 to 128 characters.' });
  if (seedHashes.has(email)) return res.status(400).json({ error: 'Change this account password in the Render environment settings.' });
  u.hash = hashPw(req.body.newPassword);
  if (!(await saveUser(email, u))) return res.status(503).json({ error: 'Could not save.' });
  res.json({ ok: true });
});

app.post('/api/totp/setup', auth('full'), async (req, res) => {
  const email = req.user.email;
  const u = await loadUser(email);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  u.totpPending = b32enc(crypto.randomBytes(20));
  if (!(await saveUser(email, u))) return res.status(503).json({ error: 'Could not save.' });
  const uri = 'otpauth://totp/DrozoMind:' + encodeURIComponent(email) + '?secret=' + u.totpPending + '&issuer=DrozoMind';
  res.json({ secret: u.totpPending, uri: uri });
});

app.post('/api/totp/confirm', auth('full'), async (req, res) => {
  const email = req.user.email;
  const key = 'totpc|' + req.ip + '|' + email;
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts.' });
  const u = await loadUser(email);
  if (!u || !u.totpPending || !checkTotp(u.totpPending, req.body.code)) { noteFail(key); return res.status(400).json({ error: 'Invalid code.' }); }
  u.totp = u.totpPending; delete u.totpPending;
  if (!(await saveUser(email, u))) return res.status(503).json({ error: 'Could not save.' });
  res.json({ ok: true });
});

app.post('/api/totp/verify', auth('any'), async (req, res) => {
  const email = req.user.email;
  const key = 'totpv|' + req.ip + '|' + email;
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts.' });
  const u = await loadUser(email);
  if (!u || !u.totp || !checkTotp(u.totp, req.body.code)) { noteFail(key); return res.status(400).json({ error: 'Invalid code.' }); }
  res.json(sessionBody(email, 'full', false));
});

app.post('/api/totp/reset', auth('full'), async (req, res) => {
  const email = req.user.email;
  const key = 'totpr|' + req.ip + '|' + email;
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts.' });
  const u = await loadUser(email);
  if (!u || !checkPw(String(req.body.password || ''), u.hash)) { noteFail(key); return res.status(403).json({ error: 'Incorrect password.' }); }
  u.totp = null; delete u.totpPending;
  if (!(await saveUser(email, u))) return res.status(503).json({ error: 'Could not save.' });
  res.json({ ok: true });
});

// ---------- shared state (allow-listed keys only) ----------
const memoryStateStore = {};
const GLOBAL_READ = new Set(['drozo_session_status', 'drozo_appointment_deleted', 'drozo_client_dispatched_docs']);
const GLOBAL_WRITE_ANY = new Set(['drozo_session_status', 'drozo_appointment_deleted']);
const USER_PREFIXES = ['drozo_user_2fa_pref_', 'drozo_user_2fa_verified_', 'drozo_id_pass_linked_', 'drozo_id_photo_'];

function keyAllowed(key, user, write) {
  if (typeof key !== 'string' || !/^[\w@.\-]{1,200}$/.test(key)) return false;
  if (GLOBAL_READ.has(key)) return write ? (isAdmin(user.email) || GLOBAL_WRITE_ANY.has(key)) : true;
  for (const p of USER_PREFIXES) if (key.startsWith(p)) return isAdmin(user.email) || key.slice(p.length) === user.email;
  return false;
}

app.get('/api/state/:key', auth('full'), async (req, res) => {
  const key = req.params.key;
  if (!keyAllowed(key, req.user, false)) return res.status(403).json({ error: 'forbidden' });
  const v = await sbGet('SYNC_' + key);
  if (v !== null) { memoryStateStore[key] = v; return res.json({ key: key, value: v, source: 'supabase' }); }
  res.json({ key: key, value: memoryStateStore[key] !== undefined ? memoryStateStore[key] : null, source: 'memory_backup' });
});

app.post('/api/state', auth('full'), async (req, res) => {
  const key = req.body && req.body.key;
  if (!keyAllowed(key, req.user, true)) return res.status(403).json({ error: 'forbidden' });
  const val = typeof req.body.value === 'object' ? JSON.stringify(req.body.value) : String(req.body.value);
  if (val.length > 200000) return res.status(413).json({ error: 'value too large' });
  memoryStateStore[key] = val;
  const ok = await sbUpsert('SYNC_' + key, req.user.email, val);
  res.json({ success: true, key: key, stored: ok });
});

// ---------- keep-alive ----------
function startKeepAliveEngine() {
  setInterval(() => {
    const lib = RENDER_EXTERNAL_URL.startsWith('https') ? https : http;
    lib.get(RENDER_EXTERNAL_URL + '/health', (r) => { r.resume(); }).on('error', (err) => console.warn('[KeepAlive] ' + err.message));
  }, 5 * 60 * 1000);
}

app.listen(PORT, () => {
  console.log('Better-Drozo backend active on port ' + PORT);
  startKeepAliveEngine();
});

module.exports = { checkTotp, totpAt, b32enc, b32dec };
