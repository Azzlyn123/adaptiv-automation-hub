const { createHash, timingSafeEqual } = require('node:crypto');

function createHubAccess({ getToken = () => process.env.HUB_API_TOKEN } = {}) {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (['GET', 'HEAD'].includes(req.method) && req.path === '/health') return next();

    const expected = getToken();
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
      return res.status(503).json({ error: 'Protected hub routes are disabled until server authentication is configured.' });
    }
    if (req.headers.origin || req.headers['sec-fetch-site']) {
      return res.status(403).json({ error: 'Browser access to protected hub routes is disabled.' });
    }
    const match = typeof req.headers.authorization === 'string' &&
      req.headers.authorization.match(/^Bearer ([a-f0-9]{64})$/i);
    const digest = (value) => createHash('sha256').update(value).digest();
    if (!match || !timingSafeEqual(digest(match[1]), digest(expected))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Authentication required.' });
    }
    return next();
  };
}

module.exports = { createHubAccess };
