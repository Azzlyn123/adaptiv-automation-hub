const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, request } = require('node:http');
const { once } = require('node:events');
const { cleanupPrivateMount, closeRecoveryWindow, PREFIX } = require('../scripts/google-phone-reconnect');

const target = { host: 'owner.test-tailnet.ts.net', port: 8765 };
const webKey = `${target.host}:443`;
const root = { Proxy: 'http://127.0.0.1:5295' };
const makeConfig = () => ({
  TCP: { 443: { HTTPS: true } },
  Web: { [webKey]: { Handlers: { '/': { ...root }, [PREFIX]: { Proxy: 'http://127.0.0.1:8765' }, '/unrelated': { Proxy: 'http://127.0.0.1:9876' } } } },
});

test('cleanup removes only the matching mount and verifies the full remaining config', async () => {
  for (const mount of [PREFIX, `${PREFIX}/`]) {
    const config = makeConfig();
    if (mount !== PREFIX) {
      config.Web[webKey].Handlers[mount] = config.Web[webKey].Handlers[PREFIX];
      delete config.Web[webKey].Handlers[PREFIX];
    }
    const expected = structuredClone(config);
    delete expected.Web[webKey].Handlers[mount];
    const removed = [];
    const result = await cleanupPrivateMount(target, root, {
      readConfig: async () => structuredClone(config),
      removeMount: async value => { removed.push(value); delete config.Web[webKey].Handlers[value]; },
    });
    assert.equal(result, 'removed');
    assert.deepEqual(removed, [mount]);
    assert.deepEqual(config, expected);
  }
});

test('cleanup leaves absent, changed, ambiguous, or untrusted mounts alone', async () => {
  const cases = [
    config => { delete config.Web[webKey].Handlers[PREFIX]; },
    config => { config.Web[webKey].Handlers[PREFIX].Proxy = 'http://127.0.0.1:9999'; },
    config => { config.Web[webKey].Handlers[PREFIX].Text = 'different handler'; },
    config => { config.Web[webKey].Handlers[`${PREFIX}/`] = { Proxy: 'http://127.0.0.1:8765' }; },
    config => { config.Web[webKey].Handlers['/'].Proxy = 'http://127.0.0.1:8888'; },
    config => { config.TCP['443'].HTTPS = false; },
    config => { config.AllowFunnel = { [webKey]: true }; },
  ];
  for (const mutate of cases) {
    const config = makeConfig();
    mutate(config);
    const before = structuredClone(config);
    let writes = 0;
    const result = await cleanupPrivateMount(target, root, { readConfig: async () => config, removeMount: async () => { writes += 1; } });
    assert.ok(['absent', 'skipped'].includes(result));
    assert.equal(writes, 0);
    assert.deepEqual(config, before);
  }
});

test('cleanup does not call an unverified root or claim success after an unexpected result', async () => {
  let writes = 0;
  const config = makeConfig();
  assert.equal(await cleanupPrivateMount(target, null, { readConfig: async () => config, removeMount: async () => { writes += 1; } }), 'skipped');
  assert.equal(writes, 0);
  const result = await cleanupPrivateMount(target, root, {
    readConfig: async () => structuredClone(config),
    removeMount: async () => { writes += 1; delete config.Web[webKey].Handlers[PREFIX]; config.Web[webKey].Handlers['/'] = { Text: 'concurrent unrelated change' }; },
  });
  assert.equal(result, 'unconfirmed');
  assert.equal(writes, 1);
});

test('shutdown holds its listener through cleanup and closes after a failed cleanup too', async () => {
  for (const fail of [false, true]) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const result = await closeRecoveryWindow(server, async () => {
      assert.equal(server.listening, true);
      if (fail) throw new Error('synthetic private error');
      return 'removed';
    });
    assert.equal(server.listening, false);
    assert.equal(result, fail ? 'unconfirmed' : 'removed');
  }
});

test('already stopped helpers cannot remove a successor mount', async () => {
  let writes = 0;
  assert.equal(await closeRecoveryWindow({ listening: false }, async () => { writes += 1; }), 'skipped');
  assert.equal(writes, 0);
});

test('shutdown waits for an existing request before reporting closed', { timeout: 5000 }, async () => {
  let response;
  const server = createServer((incoming, outgoing) => { response = outgoing; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const finished = new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port: server.address().port, headers: { Connection: 'close' } }, reply => { reply.resume(); reply.on('end', resolve); });
    client.on('error', reject);
    client.end();
  });
  await once(server, 'request');
  let closed = false;
  const closing = closeRecoveryWindow(server, async () => 'absent').then(result => { closed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(server.listening, false);
  response.end('synthetic');
  await finished;
  assert.equal(await closing, 'absent');
  assert.equal(closed, true);
});
