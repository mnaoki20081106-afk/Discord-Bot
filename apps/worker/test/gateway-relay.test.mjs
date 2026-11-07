import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayScript = path.resolve(here, '../../gateway-relay/relay.mjs');
const guildId = '123456789012345678';
const botId = '223456789012345678';
const channelId = '423456789012345001';
const existing = {id: '323456789012345001', username: 'old', global_name: null, avatar: null};
const newcomer = {id: '323456789012345002', username: 'newbie', global_name: 'Newbie', avatar: null};
const token = 'local-test-token';
const checkChannel = '423456789012345777';
const otherChannel = '423456789012345888';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function eventually(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return fn();
}

test('VPS relay forwards gateway events to the Worker, which posts one join notification', async t => {
  const calls = [];
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: botId, DISCORD_PUBLIC_KEY: '00'.repeat(32),
      DASHBOARD_PASSWORD: 'local-test-password', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/'
    },
    outboundService: async request => {
      const url = new URL(request.url);
      const p = url.pathname.replace('/api/v10', '');
      const body = request.method === 'GET' ? null : await request.clone().json().catch(() => null);
      calls.push({method: request.method, path: p, body});
      if (p === `/guilds/${guildId}`) return Response.json({id: guildId, name: 'Fixture'});
      if (p === `/guilds/${guildId}/members`) {
        return Response.json(url.searchParams.get('after') === '0' ? [{user: existing}, {user: newcomer}] : []);
      }
      if (request.method === 'POST' && p === `/channels/${channelId}/messages`) return Response.json({id: '1'});
      if (request.method === 'DELETE' && /^\/channels\/\d+\/messages\/\d+$/.test(p)) return new Response(null, {status: 204});
      return Response.json({message: 'Missing Access'}, {status: 403});
    }
  });
  t.after(() => mf.dispose());

  // Create the member-activity tables, then enable notifications with "existing" already known.
  const worker = await mf.getWorker();
  await worker.scheduled({cron: '* * * * *'});
  const db = await mf.getD1Database('DB');
  const now = Date.now();
  await db.prepare('INSERT OR REPLACE INTO member_activity_settings(guild_id,enabled,channel_id,join_enabled,leave_enabled,initialized,last_scan_at,last_member_count,last_error,updated_at) VALUES (?,1,?,1,1,1,?,1,NULL,?)')
    .bind(guildId, channelId, now, now).run();
  await db.prepare('INSERT OR REPLACE INTO member_activity_members(guild_id,user_id,username,global_name,avatar,is_bot,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,0,?,?)')
    .bind(guildId, existing.id, existing.username, null, null, now, now).run();
  // /check-only channel
  await db.prepare('INSERT OR REPLACE INTO mediation_settings(guild_id,settings_json,result_dirty,updated_at) VALUES (?,?,0,?)')
    .bind(guildId, JSON.stringify({checkChannelIds: [checkChannel]}), now).run();

  // Forward the relay's HTTP calls into Miniflare.
  const bridge = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await mf.dispatchFetch('https://worker.example' + req.url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-') || k === 'content-type')),
      body: Buffer.concat(chunks)
    });
    res.writeHead(response.status, {'Content-Type': 'application/json'});
    res.end(await response.text());
  });
  const bridgePort = await listen(bridge);
  t.after(() => bridge.close());

  // Fake Discord REST + Gateway.
  let identify = null;
  const fake = http.createServer((req, res) => {
    if (req.url === '/api/v10/gateway/bot' && req.headers.authorization === 'Bot ' + token) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({url: `ws://127.0.0.1:${fake.address().port}`}));
      return;
    }
    res.writeHead(401); res.end('{}');
  });
  const wss = new WebSocketServer({server: fake});
  wss.on('connection', socket => {
    socket.send(JSON.stringify({op: 10, d: {heartbeat_interval: 45000}}));
    socket.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.op === 1) socket.send(JSON.stringify({op: 11}));
      if (msg.op === 2) {
        identify = msg.d;
        socket.send(JSON.stringify({op: 0, s: 1, t: 'READY', d: {session_id: 's', resume_gateway_url: `ws://127.0.0.1:${fake.address().port}`, user: {username: 'bot'}, guilds: [{id: guildId, unavailable: true}]}}));
        socket.send(JSON.stringify({op: 0, s: 2, t: 'GUILD_MEMBER_ADD', d: {guild_id: guildId, user: newcomer}}));
        // After the relay has learned the /check channels, members post in two channels.
        setTimeout(() => {
          socket.send(JSON.stringify({op: 0, s: 3, t: 'MESSAGE_CREATE', d: {guild_id: guildId, channel_id: checkChannel, id: '900000000000000001', author: {id: existing.id}}}));
          socket.send(JSON.stringify({op: 0, s: 4, t: 'MESSAGE_CREATE', d: {guild_id: guildId, channel_id: otherChannel, id: '900000000000000002', author: {id: existing.id}}}));
          socket.send(JSON.stringify({op: 0, s: 5, t: 'MESSAGE_CREATE', d: {guild_id: guildId, channel_id: checkChannel, id: '900000000000000003', author: {id: botId}}}));
        }, 1500);
      }
    });
  });
  const fakePort = await listen(fake);
  t.after(() => { wss.close(); fake.close(); });

  const child = spawn(process.execPath, [relayScript], {
    env: {...process.env, DISCORD_BOT_TOKEN: token, RELAY_URL: `http://127.0.0.1:${bridgePort}/internal/gateway-relay`, DISCORD_API_BASE: `http://127.0.0.1:${fakePort}/api/v10`},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  t.after(() => child.kill('SIGTERM'));

  const joins = () => calls.filter(c => c.method === 'POST' && c.path === `/channels/${channelId}/messages`);
  assert.ok(await eventually(() => joins().length >= 1), 'join notification was not posted. relay output:\n' + output);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(joins().length, 1, 'the READY reconcile and the GUILD_MEMBER_ADD event must not double-notify');
  assert.match(JSON.stringify(joins()[0].body), /newbie|Newbie|323456789012345002/);
  assert.equal(identify?.intents, 1 | 2 | 512, 'GUILDS + GUILD_MEMBERS + GUILD_MESSAGES');
  const row = await db.prepare('SELECT user_id FROM member_activity_members WHERE guild_id=? AND user_id=?').bind(guildId, newcomer.id).first();
  assert.ok(row, 'newcomer is recorded in the snapshot');

  // A message in the /check channel is deleted right away; other channels and the bot's own posts are left alone.
  const deletes = () => calls.filter(c => c.method === 'DELETE' && /\/messages\//.test(c.path)).map(c => c.path);
  assert.ok(await eventually(() => deletes().length >= 1), 'check-channel message was not deleted. relay output:\n' + output);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.deepEqual(deletes(), [`/channels/${checkChannel}/messages/900000000000000001`]);
});

test('relay endpoint rejects bad signatures and stale timestamps', async t => {
  const mf = new Miniflare({
    modules: true, scriptPath: '.test-worker/index.js', compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: botId, DISCORD_PUBLIC_KEY: '00'.repeat(32), DASHBOARD_PASSWORD: 'x', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production', WEB_ORIGIN: 'https://d.example', WEB_PUBLIC_URL: 'https://d.example/'},
    outboundService: async () => Response.json({}, {status: 403})
  });
  t.after(() => mf.dispose());
  const key = createHash('sha256').update('gateway-relay:' + token).digest();
  const post = (body, ts, sig) => mf.dispatchFetch('https://worker.example/internal/gateway-relay', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Relay-Timestamp': ts, 'X-Relay-Signature': sig}, body
  });
  const body = JSON.stringify({t: 'RELAY_HEARTBEAT', d: {version: '1'}});
  const ts = String(Date.now());
  const good = createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
  assert.equal((await post(body, ts, good)).status, 200);
  assert.equal((await post(body, ts, good.replace(/.$/, c => c === '0' ? '1' : '0'))).status, 401);
  const wrongKey = createHmac('sha256', createHash('sha256').update('gateway-relay:other').digest()).update(`${ts}.${body}`).digest('hex');
  assert.equal((await post(body, ts, wrongKey)).status, 401);
  const old = String(Date.now() - 10 * 60_000);
  assert.equal((await post(body, old, createHmac('sha256', key).update(`${old}.${body}`).digest('hex'))).status, 401);
});
