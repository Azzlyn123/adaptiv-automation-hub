const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, request: httpRequest } = require('node:http');
const { createHash } = require('node:crypto');
const { google } = require('googleapis');
const { SCOPES } = require('../lib/googleDeliveryAgent');
const { parseArgs, validatePrivateNetwork, createPhoneHandler, limitGoogleRequests, CALLBACK, PREFIX } = require('../scripts/google-phone-reconnect');
const { matchesState, validateGrant } = require('../scripts/google-reconnect');

const host = 'owner.test-tailnet.ts.net';
const ownerLogin = 'owner@example.test';
const projectId = '11111111-1111-4111-8111-111111111111';
const serviceId = '22222222-2222-4222-8222-222222222222';
const origin = `https://${host}`;
const validTokens = { refresh_token: 'SYNTHETIC_PRIVATE_TOKEN', scope: SCOPES.join(' ') };
const cliArgs = ['--project', projectId, '--service', serviceId, '--host', host, '--mode', 'check'];

test('phone helper accepts only bounded explicit targets and private DNS names', () => {
  assert.deepEqual(parseArgs(cliArgs), { projectId, serviceId, host, mode: 'check', port: 8765, ttlMinutes: 45 });
  for (const extra of [['--port', '0'], ['--port', '8765;evil'], ['--ttl-minutes', '61'], ['--host', host]]) {
    assert.throws(() => parseArgs([...cliArgs, ...extra]));
  }
  for (const badHost of ['example.com', 'localhost', 'https://owner.test-tailnet.ts.net', 'owner.test-tailnet.ts.net.evil.test', 'owner.test-tailnet.ts.net:443']) {
    assert.throws(() => parseArgs(cliArgs.map(value => value === host ? badHost : value)));
  }
});

test('private networking requires this device owner, existing HTTPS, and Funnel off', () => {
  const status = { BackendState: 'Running', Self: { DNSName: `${host}.`, UserID: 1 }, User: { 1: { LoginName: ownerLogin } } };
  const serve = { TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:5295' } } } } };
  const target = { host, port: 8765 };
  assert.equal(validatePrivateNetwork(status, serve, target), ownerLogin);
  assert.throws(() => validatePrivateNetwork({ ...status, BackendState: 'Stopped' }, serve, target));
  assert.throws(() => validatePrivateNetwork(status, { ...serve, AllowFunnel: { [`${host}:443`]: true } }, target));
  assert.throws(() => validatePrivateNetwork({ ...status, User: {} }, serve, target));
  assert.throws(() => validatePrivateNetwork({ ...status, Self: { ...status.Self, Tags: ['tag:server'] } }, serve, target));
  assert.throws(() => validatePrivateNetwork(status, { ...serve, TCP: {} }, target));
  assert.throws(() => validatePrivateNetwork(status, serve, { ...target, host: 'other.test-tailnet.ts.net' }));
  const conflict = structuredClone(serve);
  conflict.Web[`${host}:443`].Handlers[PREFIX] = { Proxy: 'http://127.0.0.1:9999' };
  assert.throws(() => validatePrivateNetwork(status, conflict, target));
});

test('grant validation rejects missing or broader scopes and Unicode state never throws', () => {
  assert.equal(validateGrant(validTokens), validTokens.refresh_token);
  assert.throws(() => validateGrant({ scope: validTokens.scope }));
  assert.throws(() => validateGrant({ ...validTokens, scope: `${validTokens.scope} https://mail.google.com/` }));
  assert.equal(matchesState('\u00e9', 'a'), false);
  assert.equal(matchesState(null, 'a'), false);
});

async function withPhone(options, run) {
  const stored = [];
  const exchanges = [];
  const starts = [];
  const statuses = [];
  let clock = 1000;
  const server = createServer(createPhoneHandler({
    host, ownerLogin, founderEmail: ownerLogin,
    oauthClient: {
      generateAuthUrl: parameters => {
        starts.push(parameters);
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
        return options.authUrl || url.href;
      },
      getToken: async parameters => {
        exchanges.push(parameters);
        if (options.exchange) return options.exchange(parameters);
        if (options.exchangeError) throw new Error('SYNTHETIC_SECRET_IN_ERROR');
        return { tokens: options.tokens || validTokens };
      },
    },
    storeToken: async token => {
      if (options.storeError) throw new Error('SYNTHETIC_STORAGE_SECRET');
      stored.push(token);
    },
    verifyAccount: async () => { if (options.wrongAccount) throw new Error('SYNTHETIC_WRONG_ACCOUNT'); },
    now: () => clock,
    recoveryDeadline: options.recoveryDeadline ?? Infinity,
    onStatus: value => statuses.push(value),
  }));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (urlPath, { method = 'GET', body = '', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { Host: host, 'Tailscale-User-Login': ownerLogin, ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  let priorCsrf;
  const start = async () => {
    const landing = await request(`${PREFIX}/`);
    const csrf = landing.text.match(/name="csrf" value="([a-f0-9]+)"/)?.[1] || priorCsrf;
    assert.ok(csrf);
    priorCsrf = csrf;
    return request(`${PREFIX}/start`, { method: 'POST', body: `csrf=${csrf}`, headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } });
  };
  try { await run({ request, start, stored, exchanges, starts, statuses, advance: milliseconds => { clock += milliseconds; } }); }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}

test('public, missing-identity, wrong-owner, and forged-host requests are denied', async () => {
  await withPhone({}, async ({ request, starts, exchanges }) => {
    for (const headers of [{ 'Tailscale-User-Login': '' }, { 'Tailscale-User-Login': 'other@example.test' }, { Host: 'evil.test' }, { 'Tailscale-Funnel-Request': '1' }]) {
      assert.equal((await request(`${PREFIX}/`, { headers })).status, 403);
      assert.equal((await request(`${PREFIX}/oauth2callback?code=synthetic&state=synthetic`, { headers })).status, 403);
    }
    assert.equal(starts.length, 0);
    assert.equal(exchanges.length, 0);
  });
});

test('only a same-origin owner form can start a consent request', async () => {
  await withPhone({}, async ({ request, starts }) => {
    assert.equal((await request(`${PREFIX}/start`)).status, 404);
    const base = { method: 'POST', body: 'csrf=wrong', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } };
    assert.equal((await request(`${PREFIX}/start`, base)).status, 403);
    assert.equal((await request(`${PREFIX}/start`, { ...base, headers: { ...base.headers, Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(`${PREFIX}/start`, { ...base, body: 'x'.repeat(3000) })).status, 400);
    assert.equal(starts.length, 0);
  });
});

test('successful consent uses PKCE and stores once without disclosing credentials', async () => {
  await withPhone({}, async ({ request, start, stored, exchanges, starts, statuses }) => {
    const started = await start();
    assert.equal(started.status, 303);
    assert.equal(new URL(started.headers.location).hostname, 'accounts.google.com');
    assert.match(started.headers['content-security-policy'], /form-action 'self' https:\/\/accounts\.google\.com/);
    assert.deepEqual(starts[0].scope, SCOPES);
    assert.equal(starts[0].login_hint, ownerLogin);
    assert.equal(starts[0].code_challenge_method, 'S256');
    assert.equal(starts[0].state.length, 64);
    assert.equal((await start()).status, 409);
    const callback = `${CALLBACK}?code=SYNTHETIC_CODE&state=${starts[0].state}`;
    const result = await request(callback);
    assert.equal(result.status, 303);
    assert.equal(result.headers.location, `${PREFIX}/complete`);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.equal(exchanges[0].code, 'SYNTHETIC_CODE');
    assert.equal(exchanges[0].redirect_uri, origin + CALLBACK);
    assert.equal(createHash('sha256').update(exchanges[0].codeVerifier).digest('base64url'), starts[0].code_challenge);
    assert.deepEqual(stored, [validTokens.refresh_token]);
    assert.equal((await request(callback)).status, 403);
    const complete = await request(`${PREFIX}/complete`);
    assert.match(complete.text, /No deployment or email was sent/);
    assert.doesNotMatch(complete.text + JSON.stringify(result.headers) + statuses.join(' '), /SYNTHETIC_|refresh_token|codeVerifier/);
    assert.deepEqual(JSON.parse((await request(`${PREFIX}/status`)).text), { status: 'stored' });
  });
});

test('landing permits same-origin Origin headers but callback referrers remain suppressed', async () => {
  await withPhone({}, async ({ request }) => {
    const landing = await request(`${PREFIX}/`);
    assert.equal(landing.headers['referrer-policy'], 'same-origin');
    assert.equal((await request(`${PREFIX}/complete`)).headers['referrer-policy'], 'no-referrer');
  });
});

test('window expiry during an in-flight exchange prevents credential storage', async () => {
  let release;
  let entered;
  const pending = new Promise(resolve => { release = resolve; });
  const exchanging = new Promise(resolve => { entered = resolve; });
  await withPhone({ recoveryDeadline: 10000, exchange: async () => { entered(); await pending; return { tokens: validTokens }; } }, async ({ request, start, starts, advance, stored }) => {
    await start();
    const result = request(`${CALLBACK}?code=x&state=${starts[0].state}`);
    await exchanging;
    advance(10000);
    release();
    assert.equal((await result).status, 303);
    assert.deepEqual(stored, []);
    assert.equal((await request(`${PREFIX}/`)).status, 410);
  });
});

test('wrong, duplicated, expired, and pre-consent states never exchange a code', async () => {
  await withPhone({}, async ({ request, start, starts, advance, exchanges }) => {
    assert.equal((await request(`${CALLBACK}?code=x&state=unknown`)).status, 403);
    await start();
    const state = starts[0].state;
    assert.equal((await request(`${CALLBACK}?code=x&state=wrong`)).status, 403);
    assert.equal((await request(`${CALLBACK}?code=x&state=${state}&state=${state}`)).status, 403);
    assert.equal((await request(`${CALLBACK}?code=x&state=${encodeURIComponent('\u00e9'.repeat(64))}`)).status, 403);
    advance(10 * 60000);
    assert.equal((await request(`${CALLBACK}?code=x&state=${state}`)).status, 403);
    assert.equal(exchanges.length, 0);
  });
});

test('simultaneous callback replay cannot trigger a second exchange or storage', async () => {
  let release;
  let entered;
  const pending = new Promise(resolve => { release = resolve; });
  const exchanging = new Promise(resolve => { entered = resolve; });
  await withPhone({ exchange: async () => { entered(); await pending; return { tokens: validTokens }; } }, async ({ request, start, starts, exchanges, stored }) => {
    await start();
    const callback = `${CALLBACK}?code=x&state=${starts[0].state}`;
    const first = request(callback);
    await exchanging;
    assert.equal((await request(callback)).status, 403);
    release();
    assert.equal((await first).status, 303);
    assert.equal(exchanges.length, 1);
    assert.equal(stored.length, 1);
  });
});

test('denial, duplicate codes, incomplete scopes, exchange failures, and storage failures stay generic', async () => {
  for (const options of [{ denied: true }, { duplicateCode: true }, { tokens: { ...validTokens, scope: SCOPES[0] } }, { exchangeError: true }, { storeError: true }, { wrongAccount: true }]) {
    await withPhone(options, async ({ request, start, starts, stored }) => {
      await start();
      const query = options.denied ? 'error=access_denied' : `code=SYNTHETIC_CODE${options.duplicateCode ? '&code=SECOND' : ''}`;
      assert.equal((await request(`${CALLBACK}?${query}&state=${starts[0].state}`)).status, 303);
      const complete = await request(`${PREFIX}/complete`);
      assert.match(complete.text, /could not be confirmed/);
      assert.doesNotMatch(complete.text, /SYNTHETIC_|invalid_grant/);
      assert.deepEqual(stored, []);
      assert.deepEqual(JSON.parse((await request(`${PREFIX}/status`)).text), { status: 'failed' });
    });
  }
});

test('Google request limiter overrides SDK retryConfig and never retries a token POST', async () => {
  let forwarded;
  const fake = { transporter: { request: async options => { forwarded = options; } } };
  limitGoogleRequests(fake);
  await fake.transporter.request({ url: 'https://oauth2.googleapis.com/token', retry: true, retryConfig: { retry: 3, httpMethodsToRetry: ['POST'] } });
  assert.equal(forwarded.timeout, 20000);
  assert.equal(forwarded.retry, false);
  assert.deepEqual(forwarded.retryConfig, { retry: 0, noResponseRetries: 0 });
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"synthetic_test_error"}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const client = limitGoogleRequests(new google.auth.OAuth2({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'http://localhost/callback', endpoints: { oauth2TokenUrl: `http://127.0.0.1:${server.address().port}/token` } }));
    await assert.rejects(client.getToken('synthetic-code'), error => error.response?.status === 500);
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('stripped Serve mount paths work and non-Google consent destinations fail closed', async () => {
  await withPhone({}, async ({ request, start, starts }) => {
    assert.equal((await request('/')).status, 200);
    await start();
    assert.equal((await request(`/oauth2callback?code=x&state=${starts[0].state}`)).status, 303);
    assert.equal((await request('/status')).status, 200);
  });
  await withPhone({ authUrl: 'https://evil.test/authorize' }, async ({ start, stored, exchanges }) => {
    assert.equal((await start()).status, 502);
    assert.deepEqual(stored, []);
    assert.deepEqual(exchanges, []);
  });
});
