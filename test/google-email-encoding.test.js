const assert = require('node:assert/strict');
const { test } = require('node:test');
const { google } = require('googleapis');
const { buildRawMessage, sendBriefEmail } = require('../lib/googleDeliveryAgent');

function inspectMessage(raw) {
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  assert.doesNotMatch(message, /(?<!\r)\n/);
  const separator = message.indexOf('\r\n\r\n');
  assert.ok(separator > 0);
  const headers = message.slice(0, separator);
  const body = message.slice(separator + 4);
  const unfolded = headers.replace(/\r\n[ \t]+/g, ' ');
  const header = name => unfolded.match(new RegExp(`^${name}: (.*)$`, 'im'))?.[1];
  return { message, headers, body, header };
}

function decodeSubject(value) {
  // Encoded words separated by folding whitespace concatenate without a space.
  return value.replace(/(\?=)[ \t]+(?==\?)/g, '$1').replace(
    /=\?UTF-8\?([BQ])\?([^?]*)\?=/gi,
    (_, encoding, text) => {
      const bytes = encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([A-F\d]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
  );
}

test('UTF-8 test subject and body survive Gmail base64url and MIME encoding', async () => {
  const subject = 'Adaptiv Automation Hub \u2014 Test Email';
  const bodyText = 'Readiness \u2014 stable.\nCoach Zo\u00eb: caf\u00e9 \u2713';
  const message = inspectMessage(await buildRawMessage({ to: 'owner@example.com', subject, bodyText }));
  assert.equal(message.header('To'), 'owner@example.com');
  assert.equal(message.header('MIME-Version'), '1.0');
  assert.match(message.header('Content-Type'), /^text\/plain; charset=utf-8$/i);
  assert.equal(message.header('Content-Transfer-Encoding'), 'base64');
  assert.match(message.header('Subject'), /=\?UTF-8\?[BQ]\?/i);
  assert.equal(decodeSubject(message.header('Subject')), subject);
  assert.equal(Buffer.from(message.body, 'base64').toString('utf8').replace(/\r\n/g, '\n'), bodyText);
  assert.doesNotMatch(message.headers, /[^\x00-\x7f]/);
});

test('ASCII subjects and empty bodies remain readable', async () => {
  const message = inspectMessage(await buildRawMessage({ to: 'owner@example.com', subject: 'Daily brief', bodyText: '' }));
  assert.equal(message.header('Subject'), 'Daily brief');
  assert.equal(Buffer.from(message.body, 'base64').toString('utf8'), '');
});

test('long multilingual subjects fold without corrupting Unicode characters', async () => {
  const subject = 'Adaptiv \u2014 Zo\u00eb \u4f53\u80b2 \ud83c\udfc6 '.repeat(35).trim();
  const message = inspectMessage(await buildRawMessage({ to: 'owner@example.com', subject, bodyText: 'Synthetic only.' }));
  assert.equal(decodeSubject(message.header('Subject')), subject);
  const words = [...message.header('Subject').matchAll(/=\?UTF-8\?[BQ]\?[^?]*\?=/gi)];
  assert.ok(words.length > 1);
  for (const [word] of words) assert.ok(word.length <= 75);
  for (const line of message.headers.split('\r\n')) assert.ok(line.length <= 78);
});

test('subject and body cannot introduce recipient headers', async () => {
  const message = inspectMessage(await buildRawMessage({
    to: 'owner@example.com',
    subject: 'Update\r\nBcc: other@example.com',
    bodyText: '\r\nCc: another@example.com\nSynthetic only.',
  }));
  assert.equal(message.header('To'), 'owner@example.com');
  assert.equal(message.header('Cc'), undefined);
  assert.equal(message.header('Bcc'), undefined);
});

test('non-text content and recipient line breaks are rejected before composing', () => {
  for (const input of [
    { to: 'owner@example.com\r\nBcc: other@example.com', subject: 'Synthetic', bodyText: 'Synthetic' },
    { to: '', subject: 'Synthetic', bodyText: 'Synthetic' },
    { to: 'owner@example.com', subject: {}, bodyText: 'Synthetic' },
    { to: 'owner@example.com', subject: 'Synthetic', bodyText: { path: 'secret.txt' } },
  ]) assert.throws(() => buildRawMessage(input), TypeError);
});

test('sendBriefEmail sends once only to the configured founder', async t => {
  const previousFounder = process.env.FOUNDER_EMAIL;
  process.env.FOUNDER_EMAIL = 'owner@example.com';
  t.after(() => {
    if (previousFounder === undefined) delete process.env.FOUNDER_EMAIL;
    else process.env.FOUNDER_EMAIL = previousFounder;
  });
  const calls = [];
  const auth = {};
  t.mock.method(google, 'gmail', options => {
    assert.equal(options.auth, auth);
    assert.equal(options.version, 'v1');
    return { users: { messages: { send: async request => { calls.push(request); } } } };
  });
  await sendBriefEmail({ auth, subject: 'Synthetic \u2014 test', bodyText: 'No network call.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 'me');
  const message = inspectMessage(calls[0].requestBody.raw);
  assert.equal(message.header('To'), 'owner@example.com');
  assert.equal(message.header('Cc'), undefined);
  assert.equal(message.header('Bcc'), undefined);
  assert.equal(decodeSubject(message.header('Subject')), 'Synthetic \u2014 test');
});
