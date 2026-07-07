#!/usr/bin/env node
// One-time TickTick authorization. Spins up a tiny local server, sends you to
// TickTick to click "Allow", catches the redirect, exchanges the code for a token,
// and writes TICKTICK_ACCESS_TOKEN (+ refresh token if given) into .env.local.
//
// Prereqs in .env.local: TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET.
// And register this exact redirect URI on your TickTick app:  http://localhost:8321/callback
//
//   npm run ticktick-auth

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });

const CLIENT_ID = process.env.TICKTICK_CLIENT_ID;
const CLIENT_SECRET = process.env.TICKTICK_CLIENT_SECRET;
const PORT = Number(process.env.TICKTICK_AUTH_PORT || 8321);
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'tasks:write tasks:read';
const STATE = 'imessage-intake';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n✗ Missing TICKTICK_CLIENT_ID / TICKTICK_CLIENT_SECRET in .env.local.');
  console.error('  Add them from https://developer.ticktick.com/manage, then re-run.\n');
  process.exit(1);
}

const authUrl =
  'https://ticktick.com/oauth/authorize?' +
  `scope=${encodeURIComponent(SCOPE)}&client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&state=${STATE}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`;

// Replace any existing KEY= lines in .env.local with one, else append. Leaves
// every other line (incl. the Anthropic key) untouched.
function upsertEnv(key, value) {
  const p = path.join(process.cwd(), '.env.local');
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch {}
  const kept = lines.filter((l) => l.trim() && !l.startsWith(key + '='));
  kept.push(`${key}=${value}`);
  fs.writeFileSync(p, kept.join('\n') + '\n');
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) { res.writeHead(404); res.end('not here'); return; }
  const url = new URL(req.url, REDIRECT);
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (err) { res.end(`Authorization error: ${err}`); console.error('\n✗ Authorization denied:', err, '\n'); server.close(); process.exit(1); }
  if (!code) { res.end('waiting for code…'); return; }
  try {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://ticktick.com/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, scope: SCOPE }),
    });
    const text = await r.text();
    if (!r.ok) { res.end('Token exchange failed — check the terminal.'); console.error('\n✗ Token exchange failed:', r.status, text, '\n'); server.close(); process.exit(1); }
    const data = JSON.parse(text);
    if (!data.access_token) { res.end('No token returned — check the terminal.'); console.error('\n✗ No access_token in response:', text, '\n'); server.close(); process.exit(1); }
    upsertEnv('TICKTICK_ACCESS_TOKEN', data.access_token);
    if (data.refresh_token) upsertEnv('TICKTICK_REFRESH_TOKEN', data.refresh_token);
    res.end('TickTick connected. You can close this tab and go back to the terminal.');
    console.log('\n✅ TickTick connected — token written to .env.local');
    console.log('   TICKTICK_ACCESS_TOKEN saved' + (data.refresh_token ? ' + TICKTICK_REFRESH_TOKEN' : '') + '\n');
    server.close();
    process.exit(0);
  } catch (e) { res.end('Failed — check the terminal.'); console.error('\n✗', e.message, '\n'); server.close(); process.exit(1); }
});

server.listen(PORT, () => {
  console.log(`\nTickTick auth helper running at ${REDIRECT}`);
  console.log('\n⚠ Make sure this EXACT redirect URI is registered on your TickTick app:');
  console.log(`   ${REDIRECT}`);
  console.log('\nOpening your browser to authorize… if it does not open, paste this into your browser:\n');
  console.log(`   ${authUrl}\n`);
  try { spawn('open', [authUrl]); } catch {}
});
