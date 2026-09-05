import express from 'express';
import http from 'node:http';
import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const derive = promisify(scrypt);
const COOKIE = '__Host-inbox';
const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: hash.toString('hex') };
}

function page(message = '', logout = false) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Automated & CO · Inbox</title>
  <style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#eff5f2;color:#19372c;font:16px system-ui}main{box-sizing:border-box;width:min(420px,92vw);padding:36px;background:white;border:1px solid #dbe6df;border-radius:20px;box-shadow:0 14px 50px #16372612}small{font-weight:700;letter-spacing:.1em;color:#658375}h1{font-size:28px;margin-bottom:8px}p{line-height:1.5;color:#62776c}label{display:block;margin-top:24px;font-weight:600}input,button{box-sizing:border-box;width:100%;font:inherit;border-radius:10px;padding:14px;margin-top:10px}input{border:1px solid #b7cabf}button{background:#176a49;color:white;border:0;font-weight:650;cursor:pointer}.error{color:#9b2a2a}a{color:#176a49}</style>
  <main><small>AUTOMATED & CO</small><h1>${logout ? 'Cerrar sesión' : 'Tu bandeja de entrada'}</h1><p>${logout ? 'Cierra el acceso en este navegador.' : 'Inicia sesión para ver y responder tus conversaciones.'}</p><p class="error" role="alert">${message}</p>
  <form method="post" action="${logout ? '/auth/logout' : '/auth/login'}">${logout ? '' : '<label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="current-password" required minlength="16" maxlength="256">'}<button>${logout ? 'Cerrar sesión' : 'Entrar'}</button></form>${logout ? '<p><a href="/">Volver al inbox</a></p>' : ''}</main></html>`;
}

export function createPhoneGateway(config, { now = Date.now, upstreamPort = 3100 } = {}) {
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.port || origin.username || origin.password || origin.search || origin.hash) throw new Error('A canonical HTTPS origin is required');
  if (!/^[a-f0-9]{32}$/.test(config.salt) || !/^[a-f0-9]{128}$/.test(config.hash)) throw new Error('Invalid password hash configuration');
  const app = express();
  app.disable('x-powered-by');
  const sessions = new Map();
  const streams = new Map();
  const attempts = new Map();
  let globalAttempts = [];
  let checkingPassword = false;
  const lifetime = 12 * 60 * 60 * 1000;
  const windowMs = 15 * 60 * 1000;
  const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  const tokenOf = req => (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.headers.host !== origin.host) return res.status(421).send('Unknown inbox host');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin.origin) return res.status(403).json({ error: 'Origen no permitido.' });
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') return res.status(403).send('Cross-site request rejected');
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
    next();
  });
  // Native form POSTs need their real Origin for the strict CSRF check above.
  // no-referrer makes browsers send Origin: null; same-origin still suppresses
  // referrers to other sites. Apply this to retry/error form pages as well.
  app.use(['/auth/login', '/auth/logout'], (_req, res, next) => {
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.get('/auth/login', (_req, res) => res.type('html').send(page()));
  app.get('/auth/logout', (_req, res) => res.type('html').send(page('', true)));
  app.post('/auth/logout', (req, res) => {
    const key = digest(tokenOf(req));
    sessions.delete(key);
    for (const response of streams.get(key) ?? []) response.destroy();
    streams.delete(key);
    res.set('Set-Cookie', clearCookie).redirect(303, '/auth/login');
  });
  app.post('/auth/login', express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 2 }), async (req, res) => {
    const time = now();
    // The gateway only accepts tunnel traffic on loopback. A global cap also
    // prevents header spoofing or rotating client addresses bypassing limits.
    const client = digest(String(req.headers['cf-connecting-ip'] ?? 'unknown'));
    for (const [key, value] of attempts) if (value.reset <= time) attempts.delete(key);
    globalAttempts = globalAttempts.filter(t => t > time - windowMs);
    const attempt = attempts.get(client) ?? { count: 0, reset: time + windowMs };
    if (attempt.count >= 5 || globalAttempts.length >= 30 || checkingPassword) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).type('html').send(page('Demasiados intentos. Intenta de nuevo en 15 minutos.'));
    }
    attempt.count++; attempts.set(client, attempt); globalAttempts.push(time);
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 16 || password.length > 256) return res.status(401).type('html').send(page('Contraseña incorrecta.'));
    checkingPassword = true;
    try {
      const candidate = await hashPassword(password, config.salt);
      if (!timingSafeEqual(Buffer.from(candidate.hash, 'hex'), Buffer.from(config.hash, 'hex'))) return res.status(401).type('html').send(page('Contraseña incorrecta.'));
      attempts.delete(client);
      const token = randomBytes(32).toString('base64url');
      if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
      sessions.set(digest(token), time + lifetime);
      res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${lifetime / 1000}`);
      return res.redirect(303, '/');
    } finally { checkingPassword = false; }
  });
  app.use((req, res) => {
    const sessionKey = digest(tokenOf(req));
    const expires = sessions.get(sessionKey);
    if (!expires || expires <= now()) {
      res.set('Set-Cookie', clearCookie);
      return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Inicia sesión de nuevo.', code: 'AUTH_REQUIRED' }) : res.redirect(303, '/auth/login');
    }
    // Restrict the proxy to the inbox's fixed local origin; never accept a
    // caller-supplied upstream, absolute URL, or upgrade request.
    if (!req.url.startsWith('/') || req.url.startsWith('//') || req.headers.upgrade) return res.sendStatus(400);
    const active = streams.get(sessionKey) ?? new Set();
    active.add(res); streams.set(sessionKey, active);
    const headers = { host: `127.0.0.1:${upstreamPort}`, accept: req.headers.accept ?? '*/*' };
    for (const name of ['content-type', 'content-length', 'range', 'if-range', 'last-event-id']) if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers }, response => {
      res.status(response.statusCode ?? 502);
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) if (response.headers[name]) res.set(name, response.headers[name]);
      res.flushHeaders();
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    const expiryTimer = setTimeout(() => { upstream.destroy(); res.end(); }, Math.max(1, expires - now()));
    expiryTimer.unref();
    res.on('close', () => { clearTimeout(expiryTimer); upstream.destroy(); active.delete(res); if (!active.size) streams.delete(sessionKey); });
    req.on('aborted', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'El inbox no está disponible. Intenta de nuevo.' }); else res.end(); });
    req.pipe(upstream);
  });
  app.use((_error, _req, res, _next) => res.status(400).send('Solicitud no válida.'));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync('.runtime/phone-auth.json', 'utf8'));
  createPhoneGateway(config).listen(3101, '127.0.0.1', () => console.log(`Phone login gateway ready for ${config.origin}`));
}
