const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { once } = require('node:events');
// This test must never load local .env credentials or integration clients.
const dotenv = require('dotenv');
const originalDotenvConfig = dotenv.config;
dotenv.config = () => ({ parsed: {} });
const integrationEnvironment = new Map();
for (const key of Object.keys(process.env)) {
  if (/^(NOTION_|STRIPE_|GOOGLE_|TWILIO_|FOUNDER_|RAILWAY_API_TOKEN$)/.test(key)) {
    integrationEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
}
const googleDeliveryAgent = require('../lib/googleDeliveryAgent');
const app = require('../server');

let server;
let baseUrl;
let authCalls = 0;
const originalAuthUrl = googleDeliveryAgent.getAuthUrl;
const originalExchange = googleDeliveryAgent.exchangeCodeForTokens;

before(async () => {
  googleDeliveryAgent.getAuthUrl = () => {
    authCalls += 1;
    throw new Error('OAuth must not be started through the public Hub');
  };
  googleDeliveryAgent.exchangeCodeForTokens = async () => {
    authCalls += 1;
    return { refresh_token: 'SYNTHETIC_TOKEN_MUST_NOT_APPEAR' };
  };
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  dotenv.config = originalDotenvConfig;
  for (const [key, value] of integrationEnvironment) process.env[key] = value;
  googleDeliveryAgent.getAuthUrl = originalAuthUrl;
  googleDeliveryAgent.exchangeCodeForTokens = originalExchange;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

test('retired Google routes never redirect or exchange a supplied code', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const path of ['/auth/google', '/oauth2callback']) {
      const response = await fetch(`${baseUrl}${path}?code=SYNTHETIC_CODE&state=SYNTHETIC_STATE`, {
        method,
        redirect: 'manual',
      });
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('location'), null);
      const body = await response.text();
      assert.doesNotMatch(body, /SYNTHETIC_|refreshToken|refresh_token/);
      assert.match(body, /owner-controlled reconnect helper/);
    }
  }
  assert.equal(authCalls, 0);
});

test('retired routes reject HEAD and trailing-slash requests too', async () => {
  for (const path of ['/auth/google/', '/oauth2callback/']) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(response.status, 410);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(authCalls, 0);
});

test('health remains public and unchanged', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('ordinary routes are not given a new caller-auth requirement by this patch', async () => {
  const originalNotionKey = process.env.NOTION_API_KEY;
  delete process.env.NOTION_API_KEY;
  try {
    const response = await fetch(`${baseUrl}/run-daily-brief`, { method: 'POST' });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, 'Missing required environment variables');
    assert.ok(body.missing.includes('NOTION_API_KEY'));
  } finally {
    if (originalNotionKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalNotionKey;
  }
});
