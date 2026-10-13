const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

test('legacy browser OAuth setup never redirects, exchanges, or discloses a token', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    for (const path of ['/auth/google', '/oauth2callback?code=synthetic']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
      const body = await response.text();
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('location'), null);
      assert.doesNotMatch(body, /refreshToken|synthetic|access_token/i);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
