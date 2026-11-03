import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';

// Stateful stand-in for Discord's channel list so reorders can be read back.
async function runtime(t) {
  const calls = [];
  const channels = [
    {id: '400000000000000001', name: 'A', type: 4, position: 0},
    {id: '400000000000000002', name: 'B', type: 4, position: 1},
    {id: '400000000000000003', name: 'C', type: 4, position: 2},
    {id: '400000000000000004', name: 'D', type: 4, position: 3},
    {id: '500000000000000001', name: 'general', type: 0, position: 0, parent_id: '400000000000000001'},
    {id: '500000000000000002', name: 'news', type: 5, position: 1, parent_id: '400000000000000001'},
    {id: '500000000000000003', name: 'forum', type: 15, position: 2, parent_id: '400000000000000002'},
    {id: '500000000000000004', name: 'voice', type: 2, position: 3, parent_id: '400000000000000002'}
  ];
  let threadSeq = 0;
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId, DISCORD_PUBLIC_KEY: '00'.repeat(32),
      DASHBOARD_PASSWORD: 'local-test-password', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/'
    },
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'discord.com');
      const p = url.pathname.replace('/api/v10', '');
      const body = request.method === 'GET' ? null : await request.clone().json().catch(() => null);
      calls.push({method: request.method, path: p, body});
      if (request.method === 'GET' && p === `/guilds/${guildId}`) return Response.json({id: guildId, name: 'Fixture', icon: null});
      if (request.method === 'GET' && p === `/guilds/${guildId}/channels`) return Response.json(channels.map(c => ({...c})));
      if (request.method === 'GET' && p === `/guilds/${guildId}/roles`) {
        return Response.json([
          {id: guildId, name: '@everyone', position: 0, permissions: '1024', managed: false},
          {id: '700000000000000001', name: 'Bot', position: 1, permissions: '8', managed: true}
        ]);
      }
      if (request.method === 'GET' && p === `/guilds/${guildId}/members/${botId}`) {
        return Response.json({user: {id: botId}, roles: ['700000000000000001']});
      }
      if (request.method === 'PATCH' && p === `/guilds/${guildId}/channels`) {
        for (const item of body) {
          const c = channels.find(x => x.id === item.id);
          if (c) { c.position = item.position; if ('parent_id' in item) c.parent_id = item.parent_id; }
        }
        return new Response(null, {status: 204});
      }
      const one = p.match(/^\/channels\/(\d+)$/);
      if (request.method === 'GET' && one) {
        const c = channels.find(x => x.id === one[1]);
        return c ? Response.json({...c, guild_id: guildId}) : Response.json({message: 'Unknown Channel'}, {status: 404});
      }
      const th = p.match(/^\/channels\/(\d+)\/threads$/);
      if (request.method === 'POST' && th) {
        return Response.json({id: '6000000000000000' + String(++threadSeq).padStart(2, '0'), name: body.name, type: body.type ?? 11, parent_id: th[1]});
      }
      if (request.method === 'GET' && p === `/guilds/${guildId}/threads/active`) {
        return Response.json({threads: [
          {id: '600000000000000099', name: 'help', type: 12, parent_id: '500000000000000001', thread_metadata: {archived: false}}
        ]});
      }
      return Response.json({message: 'Missing Access'}, {status: 403});
    }
  });
  t.after(() => mf.dispose());
  const login = await request(mf, '/api/login', null, 'POST', {password: 'local-test-password'});
  return {mf, calls, channels, token: login.body.token};
}

async function request(mf, path, token, method = 'GET', body) {
  const response = await mf.dispatchFetch('https://worker.example' + path, {
    method,
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  return {status: response.status, body: await response.json()};
}

const categoryOrder = channels => channels.filter(c => c.type === 4).sort((a, b) => a.position - b.position).map(c => c.name).join('');

test('category reorder sends the full category order and verifies it', async t => {
  const env = await runtime(t);
  const down = await request(env.mf, `/api/guilds/${guildId}/channels/reorder`, env.token, 'PATCH',
    {id: '400000000000000001', targetId: '400000000000000003', placement: 'after'});
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.equal(categoryOrder(env.channels), 'BCAD');
  const patch = env.calls.filter(c => c.method === 'PATCH' && c.path === `/guilds/${guildId}/channels`).at(-1);
  assert.equal(patch.body.length, 4, 'every category gets an explicit position');

  const up = await request(env.mf, `/api/guilds/${guildId}/channels/reorder`, env.token, 'PATCH',
    {id: '400000000000000004', targetId: '400000000000000002', placement: 'before'});
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(categoryOrder(env.channels), 'DBCA');

  const legacy = await request(env.mf, `/api/guilds/${guildId}/channels/reorder`, env.token, 'PATCH',
    {id: '400000000000000001', position: 0});
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(categoryOrder(env.channels), 'ADBC');
});

test('threads: listed in meta and created under text, announcement and forum channels', async t => {
  const env = await runtime(t);
  const meta = await request(env.mf, `/api/guilds/${guildId}/meta`, env.token);
  assert.equal(meta.status, 200, JSON.stringify(meta.body));
  assert.deepEqual(meta.body.threads.map(x => [x.name, x.parentId, x.type]), [['help', '500000000000000001', 'private']]);

  const create = body => request(env.mf, `/api/guilds/${guildId}/channels`, env.token, 'POST', {type: 'thread', ...body});
  const threadCall = () => env.calls.filter(c => c.method === 'POST' && c.path.endsWith('/threads')).at(-1);

  assert.equal((await create({name: 'q1', parentId: '500000000000000001'})).status, 200);
  assert.equal(threadCall().body.type, 11);
  assert.equal(threadCall().body.auto_archive_duration, 1440);

  assert.equal((await create({name: 'q2', parentId: '500000000000000001', privateThread: true, autoArchiveMinutes: 60})).status, 200);
  assert.equal(threadCall().body.type, 12);
  assert.equal(threadCall().body.auto_archive_duration, 60);

  assert.equal((await create({name: 'ann', parentId: '500000000000000002'})).status, 200);
  assert.equal(threadCall().body.type, 10);
  assert.equal((await create({name: 'ann2', parentId: '500000000000000002', privateThread: true})).status, 400);

  assert.equal((await create({name: 'post', parentId: '500000000000000003'})).status, 400, 'forum posts need a first message');
  assert.equal((await create({name: 'post', parentId: '500000000000000003', message: 'hello'})).status, 200);
  assert.deepEqual(threadCall().body.message, {content: 'hello'});

  assert.equal((await create({name: 'nope', parentId: '500000000000000004'})).status, 400, 'voice channels cannot have threads');
});
