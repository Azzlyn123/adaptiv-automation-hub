const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, request: httpRequest } = require('node:http');
const { SCOPES } = require('../lib/googleDeliveryAgent');
const {
  parseArgs,
  parseRailwayJson,
  validateRailwayTarget,
  validateGrant,
  matchesState,
  createCallbackHandler,
} = require('../scripts/google-reconnect');

const projectId = '11111111-1111-4111-8111-111111111111';
const serviceId = '22222222-2222-4222-8222-222222222222';

test('reconnect accepts only explicit, validated target and mode', () => {
  assert.deepEqual(parseArgs(['--project', projectId, '--service', serviceId, '--mode', 'check']), {
    projectId,
    serviceId,
    mode: 'check',
    port: 3000,
  });
  assert.equal(parseArgs(['--project', projectId, '--service', serviceId, '--mode', 'authorize', '--port', '8765']).port, 8765);
  assert.throws(() => parseArgs(['--project', 'bad', '--service', serviceId, '--mode', 'authorize']));
  assert.throws(() => parseArgs(['--project', projectId, '--service', serviceId, '--mode', 'write']));
  assert.throws(() => parseArgs(['--project', projectId, '--service', serviceId, '--mode', 'check', '--extra', 'yes']));
  assert.throws(() => parseArgs(['--project', projectId, '--service', serviceId, '--mode', 'check', '--port', '0']));
  assert.throws(() => parseArgs(['--project', projectId, '--service', serviceId, '--mode', 'check', '--port', '8765;evil']));
});

test('malformed Railway output never echoes a secret in parse errors', () => {
  const secret = 'synthetic-private-token';
  assert.deepEqual(parseRailwayJson('{"ok":true}'), { ok: true });
  assert.throws(() => parseRailwayJson(`{"value":"${secret}"`), (error) => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /invalid JSON/);
    return true;
  });
});

test('reconnect rejects an unrelated Railway project or service', () => {
  const status = {
    id: projectId,
    environments: { edges: [{ node: {
      name: 'production',
      serviceInstances: { edges: [{ node: {
        serviceId,
        serviceName: 'adaptiv-automation-hub',
        source: { repo: 'Azzlyn123/adaptiv-automation-hub' },
      } }] },
    } }] },
  };
  assert.doesNotThrow(() => validateRailwayTarget(status, { projectId, serviceId }));
  assert.throws(() => validateRailwayTarget(status, { projectId: '00000000-0000-0000-0000-000000000000', serviceId }));
  assert.throws(() => validateRailwayTarget(status, { projectId, serviceId: '00000000-0000-0000-0000-000000000000' }));
});

test('reconnect requires a refresh token and every delivery scope', () => {
  assert.equal(validateGrant({ refresh_token: 'synthetic', scope: SCOPES.join(' ') }), 'synthetic');
  assert.throws(() => validateGrant({ scope: SCOPES.join(' ') }));
  assert.throws(() => validateGrant({ refresh_token: 'synthetic', scope: SCOPES[0] }));
  assert.equal(matchesState('abc', 'abc'), true);
  assert.equal(matchesState('abc', 'def'), false);
  assert.equal(matchesState(null, 'abc'), false);
});

async function withCallback({ tokens, code = 'synthetic-code', port = 3000 }, run) {
  let exchanges = 0;
  const stored = [];
  const server = createServer(createCallbackHandler({
    state: 'expected-state',
    oauthClient: { getToken: async (actual) => {
      exchanges += 1;
      assert.equal(actual, code);
      return { tokens };
    } },
    storeToken: async (token) => stored.push(token),
    finish: () => {},
    port,
  }));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = (path, host = `localhost:${port}`) => new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: { Host: host },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: async () => body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    await run({ request, stored, exchanges: () => exchanges });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('callback rejects wrong state and host without exchanging or storing', async () => {
  await withCallback({ tokens: { refresh_token: 'synthetic', scope: SCOPES.join(' ') } }, async ({ request, stored, exchanges }) => {
    assert.equal((await request('/oauth2callback?code=synthetic-code&state=wrong')).status, 403);
    assert.equal((await request('/oauth2callback?code=synthetic-code&state=expected-state', 'not-local:3000')).status, 400);
    assert.equal(exchanges(), 0);
    assert.deepEqual(stored, []);
  });
});

test('callback stores only a complete grant once and rejects replay', async () => {
  await withCallback({ tokens: { refresh_token: 'synthetic', scope: SCOPES.join(' ') } }, async ({ request, stored, exchanges }) => {
    assert.equal((await request('/oauth2callback?code=synthetic-code&state=expected-state')).status, 200);
    assert.equal((await request('/oauth2callback?code=synthetic-code&state=expected-state')).status, 403);
    assert.equal(exchanges(), 1);
    assert.deepEqual(stored, ['synthetic']);
  });
});

test('callback accepts only the selected local port in the Host header', async () => {
  await withCallback({ tokens: { refresh_token: 'synthetic', scope: SCOPES.join(' ') }, port: 8765 }, async ({ request, stored }) => {
    const path = '/oauth2callback?code=synthetic-code&state=expected-state';
    assert.equal((await request(path, 'localhost:3000')).status, 400);
    assert.equal((await request(path)).status, 200);
    assert.deepEqual(stored, ['synthetic']);
  });
});

test('callback refuses incomplete scope grant without storing', async () => {
  await withCallback({ tokens: { refresh_token: 'synthetic', scope: SCOPES[0] } }, async ({ request, stored }) => {
    const response = await request('/oauth2callback?code=synthetic-code&state=expected-state');
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /synthetic/);
    assert.deepEqual(stored, []);
  });
});
