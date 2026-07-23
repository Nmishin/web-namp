#!/usr/bin/env node
/**
 * Writes your Yandex Music OAuth token to .env so the web-namp server boots
 * straight into your real account.
 *
 * The token is read from stdin (or argv) on YOUR machine and written to a
 * gitignored .env — it is never printed and never leaves this process.
 *
 * Get a token:
 *   1. Open (logged in to Yandex):
 *      https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d
 *   2. Approve. You land on a page whose URL contains  #access_token=XXXX...
 *   3. Copy the access_token value.
 *
 * Use it:
 *   node scripts/set-token.mjs            # then paste the token when prompted
 *   echo "$TOKEN" | node scripts/set-token.mjs
 *   node scripts/set-token.mjs <token>    # (note: may land in shell history)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const ACCOUNT_STATUS = 'https://api.music.yandex.net/account/status';

/** Accept a bare token OR the whole OAuth redirect URL/fragment
 *  (…#access_token=XXXX&token_type=…) — same as the app's token field. */
function extractToken(raw) {
  const s = (raw ?? '').trim();
  const m = /access_token=([^&\s]+)/.exec(s);
  return (m ? m[1] : s).trim();
}

async function readToken() {
  const arg = process.argv[2];
  if (arg) return extractToken(arg);
  if (!process.stdin.isTTY) {
    return extractToken(readFileSync(0, 'utf8')); // piped input
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((res) =>
      rl.question('Paste your Yandex OAuth token (or the whole music.yandex.ru/#access_token=… URL): ', res),
    );
    return extractToken(answer);
  } finally {
    rl.close();
  }
}

// Validate via node:https, NOT fetch — Yandex's edge fingerprint-blocks
// undici/fetch with a 403, so fetch would falsely reject a valid token.
function validate(token) {
  return new Promise((done) => {
    const req = https.request(
      ACCOUNT_STATUS,
      { headers: { Authorization: `OAuth ${token}`, 'User-Agent': 'Yandex-Music-API' } },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const status = r.statusCode ?? 0;
          if (status === 401 || status === 403) {
            done({ ok: false, reason: `rejected (HTTP ${status})` });
            return;
          }
          if (status < 200 || status >= 300) {
            done({ ok: false, reason: `account/status → HTTP ${status}` });
            return;
          }
          try {
            const account = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.result?.account;
            if (!account || (account.uid === undefined && !account.login)) {
              done({ ok: false, reason: 'anonymous session (token not accepted)' });
              return;
            }
            done({ ok: true, login: account.login ?? account.displayName ?? String(account.uid) });
          } catch (err) {
            done({ ok: false, reason: `bad response: ${err?.message ?? err}` });
          }
        });
      },
    );
    req.on('error', (err) => done({ ok: false, reason: `network error: ${err?.message ?? err}` }));
    req.setTimeout(15_000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

/** Merge YANDEX_TOKEN into .env, preserving any other keys. */
function writeEnv(token) {
  let lines = [];
  try {
    lines = readFileSync(ENV_PATH, 'utf8').split('\n').filter((l) => !/^\s*YANDEX_TOKEN\s*=/.test(l));
  } catch {
    /* no existing .env — create a fresh one */
  }
  const body = [...lines.filter((l) => l.trim() !== ''), `YANDEX_TOKEN=${token}`].join('\n') + '\n';
  writeFileSync(ENV_PATH, body, { mode: 0o600 });
}

const token = await readToken();
if (!token) {
  console.error('No token provided. Nothing written.');
  process.exit(1);
}

process.stdout.write('Validating token against Yandex… ');
const result = await validate(token);
if (!result.ok) {
  console.error(`\n✗ Token not valid: ${result.reason}. Nothing written.`);
  process.exit(1);
}

writeEnv(token);
console.log(`ok`);
console.log(`✓ Connected as "${result.login}". Wrote token to .env (gitignored).`);
console.log(`  Restart the server (npm run dev) — it will boot in yandex mode.`);
