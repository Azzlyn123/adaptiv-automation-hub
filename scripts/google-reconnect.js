const { spawn } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { createServer } = require('node:http');
const path = require('node:path');
const { google } = require('googleapis');
const { SCOPES } = require('../lib/googleDeliveryAgent');

const DEFAULT_PORT = 3000;
const SERVICE_NAME = 'adaptiv-automation-hub';
const ENVIRONMENT_NAME = 'production';

function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--project', '--service', '--mode', '--port'].includes(flag) || !args[i + 1] || values[flag]) {
      throw new Error('Use --project <UUID> --service <UUID> --mode check|authorize [--port <number>].');
    }
    values[flag] = args[i + 1];
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const portText = values['--port'];
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!uuid.test(values['--project'] || '') || !uuid.test(values['--service'] || '') || !['check', 'authorize'].includes(values['--mode']) ||
      (portText !== undefined && !/^\d+$/.test(portText)) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Use --project <UUID> --service <UUID> --mode check|authorize [--port <number>].');
  }
  return { projectId: values['--project'], serviceId: values['--service'], mode: values['--mode'], port };
}

function parseRailwayJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Railway CLI returned invalid JSON. No values were printed.');
  }
}

function runRailway(args, { input, capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const command = windows ? process.execPath : 'railway';
    const commandArgs = windows
      ? [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.js'), ...args]
      : args;
    const child = spawn(command, commandArgs, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let tooLarge = false;
    const timer = setTimeout(() => child.kill(), 30000);

    child.stdout.on('data', (chunk) => {
      if (!capture) return;
      output += chunk.toString('utf8');
      if (output.length > 2_000_000) {
        tooLarge = true;
        child.kill();
      }
    });
    if (!capture) child.stdout.resume();
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Railway CLI could not start.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tooLarge || code !== 0) reject(new Error('Railway CLI operation failed. No secret was printed.'));
      else resolve(output);
    });
    child.stdin.end(input || '');
  });
}

function validateRailwayTarget(status, { projectId, serviceId }) {
  if (status.id !== projectId) throw new Error('Linked Railway project does not match --project.');
  const production = status.environments?.edges?.find((edge) => edge.node?.name === ENVIRONMENT_NAME)?.node;
  const service = production?.serviceInstances?.edges?.find((edge) => edge.node?.serviceId === serviceId)?.node;
  if (service?.serviceName !== SERVICE_NAME || service?.source?.repo !== 'Azzlyn123/adaptiv-automation-hub') {
    throw new Error('Production Hub service does not match --service.');
  }
}

function validateGrant(tokens) {
  const granted = new Set((tokens.scope || '').split(/\s+/).filter(Boolean));
  if (!tokens.refresh_token || SCOPES.some((scope) => !granted.has(scope)) || [...granted].some(scope => !SCOPES.includes(scope))) {
    throw new Error('Google did not return a refresh token with the required scopes. Nothing was stored.');
  }
  return tokens.refresh_token;
}

function matchesState(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function createCallbackHandler({ state, oauthClient, storeToken, finish, port = DEFAULT_PORT }) {
  let consumed = false;
  return async (request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || request.headers.host !== `localhost:${port}`) {
      response.writeHead(400).end('Invalid local callback.');
      return;
    }
    const url = new URL(request.url, `http://localhost:${port}/oauth2callback`);
    if (url.pathname !== '/oauth2callback') {
      response.writeHead(404).end('Not found.');
      return;
    }
    if (consumed || !matchesState(url.searchParams.get('state'), state)) {
      response.writeHead(403).end('Authorization state was not accepted.');
      return;
    }
    consumed = true;
    try {
      if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new Error('Authorization was not completed.');
      const { tokens } = await oauthClient.getToken(url.searchParams.get('code'));
      await storeToken(validateGrant(tokens));
      response.writeHead(200).end('Google authorization stored privately in Railway. No deployment or message was sent.');
      finish(null);
    } catch {
      response.writeHead(502).end('Google authorization was not stored. Check the local terminal for a generic status.');
      finish(new Error('Authorization or private storage failed. No token was printed.'));
    }
  };
}

async function main() {
  const target = parseArgs(process.argv.slice(2));
  const status = parseRailwayJson(await runRailway(['status', '--json']));
  validateRailwayTarget(status, target);
  const variables = parseRailwayJson(await runRailway([
    'variable', 'list', '--json', '--service', target.serviceId, '--environment', ENVIRONMENT_NAME,
  ]));
  if (!variables.GOOGLE_CLIENT_ID || !variables.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth client ID or secret is missing from Railway.');
  }
  if (target.mode === 'check') {
    console.log('Production Hub target and Google client fields verified. No authorization or writes performed.');
    return;
  }
  if (!process.stdin.isTTY) throw new Error('Authorization requires an interactive local terminal.');

  const state = randomBytes(32).toString('hex');
  const redirectUri = `http://localhost:${target.port}/oauth2callback`;
  const oauthClient = new google.auth.OAuth2(variables.GOOGLE_CLIENT_ID, variables.GOOGLE_CLIENT_SECRET, redirectUri);
  const authUrl = oauthClient.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
  await new Promise((resolve, reject) => {
    const server = createServer(createCallbackHandler({
      state,
      oauthClient,
      port: target.port,
      storeToken: (token) => runRailway([
        'variable', 'set', 'GOOGLE_REFRESH_TOKEN', '--stdin', '--skip-deploys',
        '--service', target.serviceId, '--environment', ENVIRONMENT_NAME,
      ], { input: token, capture: false }),
      finish: (error) => server.close(() => error ? reject(error) : resolve()),
    }));
    let timer;
    server.once('error', () => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Local port ${target.port} is unavailable. No token was stored.`));
    });
    server.listen(target.port, '127.0.0.1', () => {
      console.log('Open this Google authorization URL in a browser on this computer:');
      console.log(authUrl);
      console.log('This is a temporary recovery while the Google app remains in Testing.');
    });
    timer = setTimeout(() => server.close(() => reject(new Error('Authorization timed out. No token was stored.'))), 300000);
    server.once('close', () => clearTimeout(timer));
  });
  console.log('Refresh token stored without deployment. Review and deploy the intended Hub build separately before testing delivery.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[google reconnect] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, parseRailwayJson, runRailway, validateRailwayTarget, validateGrant, matchesState, createCallbackHandler };
