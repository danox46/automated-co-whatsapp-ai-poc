import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPhoneGateway, hashPassword } from './phone-gateway.mjs';

const origin = 'https://inbox.example.test';
const password = 'test-only-password-0123456789';
const hash = await hashPassword(password);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const request = (url, options = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, options, res => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, headers: { get: name => { const v = res.headers[name]; return Array.isArray(v) ? v.join(';') : v; } } }));
  });
  req.on('error', reject);
  req.end(options.body?.toString());
});

test('gateway guards every route, forwards authenticated writes/media, revokes and expires sessions', async t => {
  let time = Date.now();
  let hits = 0;
  const upstream = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url, method: req.method })); });
  const upstreamPort = await listen(upstream);
  const server = http.createServer(createPhoneGateway({ origin, ...hash }, { now: () => time, upstreamPort }));
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const call = (path, options = {}) => request(`http://127.0.0.1:${port}${path}`, { ...options, headers: { host: 'inbox.example.test', ...options.headers } });
  for (const path of ['/', '/api/conversations', '/api/events', '/api/media/example', '/assets/app.js']) {
    const r = await call(path); assert.ok([303, 401].includes(r.status)); assert.equal(hits, 0);
  }
  assert.equal((await call('/api/conversations', { headers: { cookie: '__Host-inbox=forged' } })).status, 401);
  assert.equal((await call('/', { headers: { host: 'evil.example' } })).status, 421);
  const login = pw => call('/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: pw }) });
  assert.equal((await login('wrong-but-long-password')).status, 401);
  const logged = await login(password); assert.equal(logged.status, 303);
  const setCookie = logged.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(attribute));
  const cookie = setCookie.split(';')[0];
  assert.equal((await call('/api/media/example', { headers: { cookie } })).status, 200);
  assert.equal((await call('/api/conversations/example/replies', { method: 'POST', headers: { cookie, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/conversations/example/replies', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{"body":"test"}' })).status, 200);
  assert.equal((await call('/auth/logout', { method: 'POST', headers: { cookie, origin } })).status, 303);
  assert.equal((await call('/api/conversations', { headers: { cookie } })).status, 401);
  const nextCookie = (await login(password)).headers.get('set-cookie').split(';')[0];
  time += 12 * 3600 * 1000 + 1;
  assert.equal((await call('/api/conversations', { headers: { cookie: nextCookie } })).status, 401);
});

test('bad passwords are throttled, even across client addresses', async t => {
  const server = http.createServer(createPhoneGateway({ origin, ...hash }));
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = ip => request(`http://127.0.0.1:${port}/auth/login`, { method: 'POST', headers: { host: 'inbox.example.test', origin, 'cf-connecting-ip': ip, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=short' });
  for (let i = 0; i < 5; i++) assert.equal((await call('1')).status, 401);
  assert.equal((await call('1')).status, 429);
  for (let i = 0; i < 25; i++) assert.equal((await call(`client-${i}`)).status, 401);
  assert.equal((await call('new-client')).status, 429);
});
