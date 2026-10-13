const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const app = require('../server');
const { createHubAccess } = require('../lib/hubAccess');

const token = 'a'.repeat(64);

async function serve(t, application) {
  const server = application.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('every real non-health route is protected before its handler', async (t) => {
  const previous = process.env.HUB_API_TOKEN;
  process.env.HUB_API_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.HUB_API_TOKEN;
    else process.env.HUB_API_TOKEN = previous;
  });
  const origin = await serve(t, app);
  const routes = app._router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  assert.ok(routes.length >= 25);
  for (const route of routes) {
    for (const method of Object.keys(route.methods)) {
      const response = await fetch(`${origin}${route.path}`, { method: method.toUpperCase() });
      assert.equal(response.status, route.path === '/health' ? 200 : 401, `${method} ${route.path}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
});

test('missing or weak token configuration fails closed', async (t) => {
  for (const value of [undefined, '', 'short', 'x'.repeat(64)]) {
    const application = express();
    application.use(createHubAccess({ getToken: () => value }));
    application.get('/health', (req, res) => res.json({ status: 'ok' }));
    application.post('/write', (req, res) => res.json({ wrote: true }));
    const origin = await serve(t, application);
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/write`, { method: 'POST' })).status, 503);
  }
});

test('only an exact server bearer token reaches a protected handler', async (t) => {
  const application = express();
  let writes = 0;
  application.use(createHubAccess({ getToken: () => token }));
  application.use(express.json());
  application.post('/write', (req, res) => {
    writes += 1;
    res.json({ accepted: true });
  });
  const origin = await serve(t, application);
  const call = (headers = {}, suffix = '') => fetch(`${origin}/write${suffix}`, { method: 'POST', headers });
  for (const headers of [
    {},
    { authorization: `Bearer ${'b'.repeat(64)}` },
    { authorization: token },
    { cookie: `token=${token}` },
    { 'x-api-key': token },
  ]) {
    assert.equal((await call(headers)).status, 401);
  }
  assert.equal((await call({}, `?token=${token}`)).status, 401);
  assert.equal((await call({ authorization: `Bearer ${token}`, origin: 'https://example.com' })).status, 403);
  assert.equal((await call({ authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal(writes, 0);
  assert.equal((await call({ authorization: `Bearer ${token}` })).status, 200);
  assert.equal(writes, 1);
});

test('operator examples and environment template match protected routes', () => {
  const root = path.resolve(__dirname, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const commands = readme.split(/\r?\n/).filter((line) => /^\s*curl -X POST /.test(line));
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.ok(command.includes('-H "Authorization: Bearer ${HUB_API_TOKEN}"'), command);
  }
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(template, /^HUB_API_TOKEN=$/m);
});
