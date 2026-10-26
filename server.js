'use strict';

// Meeting availability server — no dependencies. Serves the static front end from ./public,
// stores each event as a JSON file in DATA_DIR, and pushes changes to open pages over
// Server-Sent Events so everyone sees updates live.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY = 64 * 1024;
const MAX_DAYS = 31;
const MAX_PEOPLE = 200;
const MAX_NAME = 40;
const ACCESS_DAYS = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const ID = '([A-Za-z0-9_-]{6,32})';
const ROUTES = {
  events: /^\/api\/events$/,
  event: new RegExp(`^/api/events/${ID}$`),
  stream: new RegExp(`^/api/events/${ID}/stream$`),
  unlock: new RegExp(`^/api/events/${ID}/unlock$`),
  person: new RegExp(`^/api/events/${ID}/people/([^/]+)$`),
};

const cache = new Map();    // id -> Promise<event | null>
const writes = new Map();   // id -> Promise of the latest queued write
const streams = new Map();  // id -> Set of open SSE responses

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- storage ----------

function eventFile(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function slotCount(ev) {
  return ev.d.length * ((ev.e - ev.s) / ev.m);
}

// Version 1 events stored one bit per slot (free or not). Version 2 stores two bits per slot:
// 0 none, 1 available, 2 preferred, 3 not available. Old "free" slots become "available".
function migrate(ev) {
  if (ev.v === 2) return ev;
  const n = slotCount(ev);
  for (const [name, bits] of Object.entries(ev.p)) {
    const src = Buffer.from(bits, 'base64url');
    const out = Buffer.alloc(Math.ceil(n / 4));
    for (let i = 0; i < n; i++) {
      if ((src[i >> 3] >> (i & 7)) & 1) out[i >> 2] |= 1 << ((i & 3) * 2);
    }
    ev.p[name] = out.toString('base64url');
  }
  ev.v = 2;
  return ev;
}

function getEvent(id) {
  if (!cache.has(id)) {
    const loading = fsp.readFile(eventFile(id), 'utf8')
      .then((text) => migrate(JSON.parse(text)))
      .catch((err) => {
        if (err.code === 'ENOENT') return null;
        cache.delete(id);
        throw err;
      });
    cache.set(id, loading);
  }
  return cache.get(id);
}

function persist(ev) {
  const previous = writes.get(ev.id) || Promise.resolve();
  const next = previous.then(async () => {
    const tmp = `${eventFile(ev.id)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(ev));
    await fsp.rename(tmp, eventFile(ev.id));
  }).catch((err) => console.error(`Failed to save event ${ev.id}:`, err));
  writes.set(ev.id, next);
  return next;
}

// The event as sent to browsers: everything except the password hash.
function publicEvent(ev) {
  const { pw, ...rest } = ev;
  return { ...rest, protected: !!pw };
}

function broadcast(ev) {
  const payload = `data: ${JSON.stringify(publicEvent(ev))}\n\n`;
  for (const res of streams.get(ev.id) || []) res.write(payload);
}

async function requireEvent(id) {
  const ev = await getEvent(id);
  if (!ev) throw new HttpError(404, 'Event not found');
  return ev;
}

// ---------- passwords ----------
// Events can have a password. Only a salted scrypt hash is stored. Entering the right password
// sets an HttpOnly cookie holding a token derived from that hash, so the browser stays unlocked
// for ACCESS_DAYS and changing the hash would revoke every token.

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

async function checkPassword(ev, password) {
  const expected = Buffer.from(ev.pw.hash, 'base64');
  const actual = await scrypt(String(password || ''), Buffer.from(ev.pw.salt, 'base64'), 32);
  return crypto.timingSafeEqual(expected, actual);
}

function accessToken(ev) {
  return crypto.createHash('sha256').update(`${ev.id}:${ev.pw.hash}`).digest('base64url');
}

function cookieName(ev) {
  return `ev_${ev.id}`;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function hasAccess(req, ev) {
  if (!ev.pw) return true;
  const given = Buffer.from(readCookie(req, cookieName(ev)));
  const expected = Buffer.from(accessToken(ev));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function grantAccess(req, res, ev) {
  if (!ev.pw) return;
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', [
    `${cookieName(ev)}=${accessToken(ev)}`,
    'Path=/',
    `Max-Age=${ACCESS_DAYS * 24 * 60 * 60}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

async function requireAccess(req, id) {
  const ev = await requireEvent(id);
  if (!hasAccess(req, ev)) throw new HttpError(401, 'Password required', { title: ev.t });
  return ev;
}

// ---------- validation ----------

function validatePassword(password) {
  if (password === undefined || password === '') return '';
  if (typeof password !== 'string' || password.length < 4 || password.length > 200) {
    throw new HttpError(400, 'Passwords must be 4 to 200 characters');
  }
  return password;
}

function validateEvent(body) {
  const { t, tz, d, s, e, m } = body || {};
  const isInt = Number.isInteger;
  if (typeof t !== 'string' || !t.trim() || t.length > 80) throw new HttpError(400, 'Invalid event name');
  if (typeof tz !== 'string' || tz.length > 64) throw new HttpError(400, 'Invalid time zone');
  if (!Array.isArray(d) || !d.length || d.length > MAX_DAYS) throw new HttpError(400, 'Invalid dates');
  if (!d.every((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))) throw new HttpError(400, 'Invalid dates');
  if (![15, 30, 60].includes(m)) throw new HttpError(400, 'Invalid slot length');
  if (!isInt(s) || !isInt(e) || s < 0 || e > 24 * 60 || e <= s || (e - s) % m) throw new HttpError(400, 'Invalid time range');
  return { t: t.trim(), tz, d, s, e, m };
}

function validateName(raw) {
  let name;
  try {
    name = decodeURIComponent(raw).trim();
  } catch {
    throw new HttpError(400, 'Invalid name');
  }
  if (!name || name.length > MAX_NAME) throw new HttpError(400, 'Invalid name');
  return name;
}

function validateSlots(ev, slots) {
  const bytes = Math.ceil(slotCount(ev) / 4);
  if (typeof slots !== 'string' || !/^[A-Za-z0-9_-]*$/.test(slots) || slots.length > Math.ceil(bytes * 4 / 3)) {
    throw new HttpError(400, 'Invalid availability');
  }
  return slots;
}

// ---------- http helpers ----------

function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  if (!stat.isFile()) throw new HttpError(404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------- routes ----------

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  let match;

  if (ROUTES.events.test(pathname)) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = await readJson(req);
    const fields = validateEvent(body);
    const password = validatePassword(body.password);
    const ev = { id: crypto.randomBytes(8).toString('base64url'), v: 2, created: new Date().toISOString(), ...fields, p: {} };
    if (password) ev.pw = await hashPassword(password);
    cache.set(ev.id, Promise.resolve(ev));
    await persist(ev);
    grantAccess(req, res, ev);
    return send(res, 201, publicEvent(ev));
  }

  if ((match = pathname.match(ROUTES.event))) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return send(res, 200, publicEvent(await requireAccess(req, match[1])));
  }

  if ((match = pathname.match(ROUTES.unlock))) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const ev = await requireEvent(match[1]);
    const { password } = await readJson(req);
    if (ev.pw && !(await checkPassword(ev, password))) {
      await new Promise((resolve) => setTimeout(resolve, 1000));  // slow down guessing
      throw new HttpError(403, 'Incorrect password');
    }
    grantAccess(req, res, ev);
    return send(res, 204);
  }

  if ((match = pathname.match(ROUTES.stream))) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const ev = await requireAccess(req, match[1]);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\ndata: ${JSON.stringify(publicEvent(ev))}\n\n`);
    if (!streams.has(ev.id)) streams.set(ev.id, new Set());
    streams.get(ev.id).add(res);
    req.on('close', () => {
      const set = streams.get(ev.id);
      set.delete(res);
      if (!set.size) streams.delete(ev.id);
    });
    return;
  }

  if ((match = pathname.match(ROUTES.person))) {
    const ev = await requireAccess(req, match[1]);
    const name = validateName(match[2]);
    if (req.method === 'PUT') {
      const { slots } = await readJson(req);
      if (!ev.p[name] && Object.keys(ev.p).length >= MAX_PEOPLE) throw new HttpError(409, 'This event is full');
      ev.p[name] = validateSlots(ev, slots);
    } else if (req.method === 'DELETE') {
      delete ev.p[name];
    } else {
      throw new HttpError(405, 'Method not allowed');
    }
    broadcast(ev);
    await persist(ev);
    return send(res, 204);
  }

  if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : err.message, ...err.extra });
    else res.end();
  });
});

// Keep SSE connections alive through proxies that close idle sockets.
setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();

fs.mkdirSync(DATA_DIR, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(`Meeting availability running at http://localhost:${PORT} (data in ${DATA_DIR})`);
});
