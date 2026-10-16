const { execFile } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const path = require('node:path');
const { google } = require('googleapis');
const { SCOPES } = require('../lib/googleDeliveryAgent');
const { parseRailwayJson, runRailway, validateRailwayTarget, validateGrant, matchesState } = require('./google-reconnect');

const PREFIX = '/google-reconnect';
const CALLBACK = `${PREFIX}/oauth2callback`;
const SESSION_MS = 10 * 60 * 1000;

function parseArgs(args) {
  const values = {};
  const usage = 'Use --project <UUID> --service <UUID> --host <device.tailnet.ts.net> --mode check|serve [--port 8765] [--ttl-minutes 45].';
  for (let i = 0; i < args.length; i += 2) {
    if (!['--project', '--service', '--host', '--mode', '--port', '--ttl-minutes'].includes(args[i]) || !args[i + 1] || values[args[i]]) {
      throw new Error(usage);
    }
    values[args[i]] = args[i + 1];
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const host = values['--host'];
  const port = Number(values['--port'] || '8765');
  const ttlMinutes = Number(values['--ttl-minutes'] || '45');
  if (!uuid.test(values['--project'] || '') || !uuid.test(values['--service'] || '') ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(host || '') ||
      !['check', 'serve'].includes(values['--mode']) ||
      !/^\d+$/.test(values['--port'] || '8765') || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !/^\d+$/.test(values['--ttl-minutes'] || '45') || !Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60) {
    throw new Error(usage);
  }
  return { projectId: values['--project'], serviceId: values['--service'], host, mode: values['--mode'], port, ttlMinutes };
}

function validatePrivateNetwork(status, serve, target) {
  const ownerLogin = status.User?.[String(status.Self?.UserID)]?.LoginName;
  const dnsName = String(status.Self?.DNSName || '').replace(/\.$/, '');
  if (status.BackendState !== 'Running' || dnsName !== target.host || !ownerLogin ||
      (status.Self?.Tags || []).length || serve.TCP?.['443']?.HTTPS !== true ||
      Object.values(serve.AllowFunnel || {}).some(Boolean)) {
    throw new Error('Owner identity, private HTTPS, or Funnel-off check failed. Nothing was authorized.');
  }
  const handlers = serve.Web?.[`${target.host}:443`]?.Handlers;
  if (!handlers?.['/']) throw new Error('Existing private dashboard HTTPS configuration was not found.');
  const route = handlers[PREFIX] || handlers[`${PREFIX}/`];
  if (route && route.Proxy !== `http://127.0.0.1:${target.port}`) {
    throw new Error('Private reconnect path is already used by another service.');
  }
  return ownerLogin;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function limitGoogleRequests(client) {
  const sendRequest = client.transporter.request.bind(client.transporter);
  // OAuth's SDK sets a retryConfig that must also be explicitly overridden.
  client.transporter.request = options => sendRequest({ ...options, timeout: 20000, retry: false, retryConfig: { retry: 0, noResponseRetries: 0 } });
  return client;
}

async function verifyGoogleAccount(tokens, founderEmail) {
  if (!tokens.access_token) throw new Error('Google access token missing.');
  const auth = limitGoogleRequests(new google.auth.OAuth2());
  auth.setCredentials({ access_token: tokens.access_token });
  const { data } = await google.drive({ version: 'v3', auth }).about.get({ fields: 'user(emailAddress)' }, { timeout: 20000, retry: false, retryConfig: { retry: 0, noResponseRetries: 0 } });
  if (data.user?.emailAddress?.trim().toLowerCase() !== founderEmail.trim().toLowerCase()) {
    throw new Error('Google account does not match the configured founder inbox.');
  }
}

function page(title, content) {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${title}</title><body><main><h1>${title}</h1>${content}</main></body></html>`;
}

async function readForm(request) {
  let body = '';
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= 2048) body += chunk.toString('utf8');
  }
  if (length > 2048) throw new Error('Form too large.');
  return new URLSearchParams(body);
}

function createPhoneHandler({ host, ownerLogin, founderEmail, oauthClient, storeToken, verifyAccount, now = Date.now, onStatus = () => {}, recoveryDeadline = Infinity }) {
  if (typeof verifyAccount !== 'function') throw new Error('Google account verification is required.');
  const origin = `https://${host}`;
  const csrf = randomBytes(32).toString('hex');
  let session = null;
  let status = 'ready';
  function update(value) { status = value; onStatus(value); }
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com");
    const send = (code, text, type = 'text/plain; charset=utf-8') => {
      response.setHeader('Content-Type', type);
      response.writeHead(code).end(text);
    };
    if (![host, `${host}:443`].includes(request.headers.host) || request.headers['tailscale-user-login'] !== ownerLogin || request.headers['tailscale-funnel-request'] !== undefined) {
      send(403, 'Private owner connection required.');
      return;
    }
    let url;
    try { url = new URL(request.url, origin); } catch { send(400, 'Invalid request.'); return; }
    if (url.origin !== origin) { send(400, 'Invalid request origin.'); return; }
    if (now() >= recoveryDeadline) { send(410, 'This private recovery window has expired. Return to Codex.'); return; }
    // Serve may strip the mount prefix; neither form opens another route.
    const route = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length) : url.pathname;
    if (request.method === 'GET' && ['/', PREFIX].includes(route)) {
      const content = status === 'ready'
        ? `<p>Reconnect the existing Google delivery permissions for ${escapeHtml(founderEmail)}: send email, create/edit Docs, and access app-created Drive files. This does not enable SMS or send a message.</p><form method="post" action="${PREFIX}/start"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Reconnect Google</button></form>`
        : '<p>Connection status: ' + escapeHtml(status) + '. Return to Codex for the next step. No deployment or email was sent.</p>';
      send(200, page('Adaptiv email connection', content), 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && route === '/status') { send(200, JSON.stringify({ status }), 'application/json'); return; }
    if (request.method === 'GET' && route === '/complete') {
      response.setHeader('Referrer-Policy', 'no-referrer');
      const message = status === 'stored'
        ? 'Google authorization was stored privately. Return to Codex to activate and test email. No deployment or email was sent.'
        : 'The connection could not be confirmed. Return to Codex. Do not send any credentials.';
      send(200, page('Adaptiv email connection', `<p>${message}</p>`), 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'POST' && route === '/start') {
      if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        send(403, 'Private same-origin form required.'); return;
      }
      let form;
      try { form = await readForm(request); } catch { send(400, 'Invalid form.'); return; }
      if (now() >= recoveryDeadline) { send(410, 'Recovery window expired. Return to Codex.'); return; }
      if (form.getAll('csrf').length !== 1 || !matchesState(form.get('csrf'), csrf)) { send(403, 'Form was not accepted.'); return; }
      if (status !== 'ready') { send(409, 'A connection attempt already exists. Return to Codex.'); return; }
      const verifier = randomBytes(32).toString('base64url');
      session = { state: randomBytes(32).toString('hex'), verifier, expires: Math.min(now() + SESSION_MS, recoveryDeadline), consumed: false };
      try {
        const authUrl = oauthClient.generateAuthUrl({
          access_type: 'offline', prompt: 'consent', scope: SCOPES, state: session.state,
          login_hint: founderEmail, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        });
        const parsed = new URL(authUrl);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com') throw new Error('Unexpected consent destination.');
        update('consent_pending');
        response.writeHead(303, { Location: authUrl }).end();
      } catch { update('failed'); send(502, 'Google connection could not start. No credential was printed.'); }
      return;
    }
    if (request.method === 'GET' && route === '/oauth2callback') {
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (!session || session.consumed || session.expires <= now() || status !== 'consent_pending' ||
          url.searchParams.getAll('state').length !== 1 || !matchesState(url.searchParams.get('state'), session.state)) {
        send(403, 'Authorization state was not accepted.'); return;
      }
      session.consumed = true;
      update('exchanging');
      try {
        if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) {
          throw new Error('Consent was not completed.');
        }
        const { tokens } = await oauthClient.getToken({ code: url.searchParams.get('code'), codeVerifier: session.verifier, redirect_uri: origin + CALLBACK });
        const token = validateGrant(tokens);
        if (now() >= session.expires || now() >= recoveryDeadline) throw new Error('Authorization window expired during exchange.');
        await verifyAccount(tokens);
        if (now() >= session.expires || now() >= recoveryDeadline) throw new Error('Authorization window expired during account check.');
        await storeToken(token);
        update('stored');
      } catch { update('failed'); }
      session.verifier = '';
      response.writeHead(303, { Location: `${PREFIX}/complete` }).end();
      return;
    }
    send(request.method === 'GET' ? 404 : 405, 'Not found.');
  };
}

function tailscaleJson(args) {
  const binary = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Tailscale', 'tailscale.exe') : 'tailscale';
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 15000, maxBuffer: 2_000_000, windowsHide: true }, (error, stdout) => {
      if (error) { reject(new Error('Private Tailscale configuration could not be verified.')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid Tailscale status. No values printed.')); }
    });
  });
}

async function main() {
  const target = parseArgs(process.argv.slice(2));
  validateRailwayTarget(parseRailwayJson(await runRailway(['status', '--json'])), target);
  const variables = parseRailwayJson(await runRailway(['variable', 'list', '--json', '--service', target.serviceId, '--environment', 'production']));
  if (!variables.GOOGLE_CLIENT_ID || !variables.GOOGLE_CLIENT_SECRET || !variables.FOUNDER_EMAIL) throw new Error('Google client or founder email is not configured.');
  const ownerLogin = validatePrivateNetwork(await tailscaleJson(['status', '--json']), await tailscaleJson(['serve', 'status', '--json']), target);
  if (target.mode === 'check') { console.log('Production Hub, Google client fields, and private owner network verified. No authorization or writes performed.'); return; }
  const oauthClient = limitGoogleRequests(new google.auth.OAuth2(variables.GOOGLE_CLIENT_ID, variables.GOOGLE_CLIENT_SECRET, `https://${target.host}${CALLBACK}`));
  const server = createServer(createPhoneHandler({
    host: target.host, ownerLogin, founderEmail: variables.FOUNDER_EMAIL, oauthClient,
    recoveryDeadline: Date.now() + target.ttlMinutes * 60000,
    verifyAccount: tokens => verifyGoogleAccount(tokens, variables.FOUNDER_EMAIL),
    storeToken: token => runRailway(['variable', 'set', 'GOOGLE_REFRESH_TOKEN', '--stdin', '--skip-deploys', '--service', target.serviceId, '--environment', 'production'], { input: token, capture: false }),
    onStatus: status => console.log(`Google connection status: ${status}. No token, code, or state logged.`),
  }));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  await new Promise((resolve, reject) => {
    let timer;
    let forceClose;
    server.once('error', () => { if (timer) clearTimeout(timer); reject(new Error('Private callback port unavailable. Nothing was stored.')); });
    server.listen(target.port, '127.0.0.1', () => {
      console.log(`Private connection page ready at https://${target.host}${PREFIX}/`);
      console.log('Explicit phone consent required. No deployment, email, or SMS will be sent by this helper.');
    });
    timer = setTimeout(() => {
      server.close(resolve);
      forceClose = setTimeout(() => server.closeAllConnections(), 90000);
    }, target.ttlMinutes * 60000);
    server.once('close', () => { clearTimeout(timer); clearTimeout(forceClose); });
  });
  console.log('Private Google recovery window closed.');
}

if (require.main === module) main().catch(() => { console.error('Private Google recovery stopped. No credential was printed; return to Codex.'); process.exitCode = 1; });
module.exports = { parseArgs, validatePrivateNetwork, createPhoneHandler, limitGoogleRequests, CALLBACK, PREFIX };
