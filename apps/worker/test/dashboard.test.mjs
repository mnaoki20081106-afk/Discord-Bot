import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';
const verificationUserId = '323456789012345679';
const botRoleId = '623456789012345678';
const targetRoleId = '523456789012345678';
const chatChannelId = '423456789012345678';
const guild = { id: guildId, name: 'Regression server', icon: null };
const nonAdminBotPermissions = (
  1024n|2048n|16384n|32768n|65536n|8192n|16n|268435456n|
  2n|4n|1099511627776n|128n
).toString();

async function runtime(t, options = {}) {
  const calls = [];
  const {privateKey:interactionPrivateKey,publicKey:interactionPublicKey} =
    generateKeyPairSync('ed25519');
  const publicKeyDer = interactionPublicKey.export({format:'der',type:'spki'});
  const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');
  let verificationMemberRoles = [...(options.verificationMemberRoles ?? [])];
  let rateLimitGuild = true;
  const botPermissions = options.botPermissions ?? nonAdminBotPermissions;
  const botRolePosition = options.botRolePosition ?? 2;
  const targetRolePosition = options.targetRolePosition ?? 1;
  let channelOverwrites = [...(options.channelOverwrites ?? [])];
  const forceBotOverwrite403 = options.forceBotOverwrite403 ?? false;
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    // Latest stable Miniflare 4 runtime; production keeps its newer date.
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId,
      DISCORD_PUBLIC_KEY: discordPublicKey,
      DASHBOARD_PASSWORD: 'local-test-password', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/', PAYPAY_ENV: 'sandbox'
    },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname });
      assert.equal(url.hostname, 'discord.com', 'tests must never contact payment providers');
      if (url.pathname.endsWith('/users/@me')) return Response.json({id: botId, username: 'Test bot'});
      if (url.pathname.endsWith('/users/@me/guilds')) return Response.json([guild]);
      if (url.pathname === `/api/v10/guilds/${guildId}`) {
        if (rateLimitGuild) { rateLimitGuild = false; return Response.json({ retry_after: 0.001 }, {status: 429}); }
        return Response.json(guild);
      }
      if (url.pathname.endsWith('/channels')) return Response.json([
        {id:'323456789012345678',name:'General',type:4,position:0},
        {
          id:chatChannelId,
          name:'chat',
          type:0,
          parent_id:'323456789012345678',
          position:1,
          permission_overwrites:channelOverwrites
        }
      ]);
      if (url.pathname.endsWith('/roles')) return Response.json([
        {id:guildId,name:'@everyone',position:0,managed:false,permissions:'0'},
        {id:targetRoleId,name:'Customer',position:targetRolePosition,managed:false,permissions:'0'},
        {
          id:botRoleId,
          name:'Test bot',
          position:botRolePosition,
          managed:true,
          permissions:botPermissions,
          tags:{bot_id:botId}
        }
      ]);
      if (url.pathname === `/api/v10/guilds/${guildId}/emojis`) return Response.json([]);
      if (url.pathname === `/api/v10/guilds/${guildId}/stickers`) return Response.json([]);
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/guilds/${guildId}/members`
      ) {
        return Response.json([{
          user:{id:verificationUserId,username:'Verifier',global_name:'Verifier',bot:false},
          nick:'Recovery Tester',
          roles:[targetRoleId],
          joined_at:'2026-01-01T00:00:00.000Z'
        }]);
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/channels/${chatChannelId}`
      ) {
        return Response.json({id:chatChannelId,guild_id:guildId,name:'chat',type:0});
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/channels/${chatChannelId}/messages`
      ) {
        return Response.json([]);
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v10/channels/${chatChannelId}/messages`
      ) {
        return Response.json({id:'723456789012345678',channel_id:chatChannelId},{status:200});
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/guilds/${guildId}/members/${verificationUserId}`
      ) {
        return Response.json({roles:[...verificationMemberRoles]});
      }
      if (
        request.method === 'PUT' &&
        url.pathname === `/api/v10/guilds/${guildId}/members/${verificationUserId}/roles/${targetRoleId}`
      ) {
        if (!verificationMemberRoles.includes(targetRoleId)) {
          verificationMemberRoles.push(targetRoleId);
        }
        return new Response(null,{status:204});
      }
      if (
        request.method === 'PUT' &&
        /^\/api\/v10\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)
      ) {
        if (forceBotOverwrite403 && url.pathname.endsWith(`/permissions/${botId}`)) {
          return Response.json({message:'Missing Access',code:50001},{status:403});
        }
        const parts = url.pathname.split('/');
        const channelId = parts[4];
        const overwriteId = parts[6];
        if (channelId === chatChannelId) {
          const body = await request.clone().json();
          channelOverwrites = [
            ...channelOverwrites.filter(
              overwrite => !(overwrite.id === overwriteId && overwrite.type === body.type)
            ),
            {
              id: overwriteId,
              type: body.type,
              allow: String(body.allow ?? '0'),
              deny: String(body.deny ?? '0')
            }
          ];
        }
        return new Response(null,{status:204});
      }
      if (
        request.method === 'DELETE' &&
        /^\/api\/v10\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)
      ) {
        const parts = url.pathname.split('/');
        const channelId = parts[4];
        const overwriteId = parts[6];
        if (channelId === chatChannelId) {
          channelOverwrites = channelOverwrites.filter(overwrite => overwrite.id !== overwriteId);
        }
        return new Response(null,{status:204});
      }
      if (
        request.method === 'PATCH' &&
        /^\/api\/v10\/channels\/\d+$/.test(url.pathname)
      ) {
        const id = url.pathname.split('/').at(-1);
        const body = await request.clone().json().catch(() => ({}));
        if (id === chatChannelId && Array.isArray(body.permission_overwrites)) {
          channelOverwrites = body.permission_overwrites.map(overwrite => ({
            id:String(overwrite.id),
            type:Number(overwrite.type),
            allow:String(overwrite.allow ?? '0'),
            deny:String(overwrite.deny ?? '0')
          }));
        }
        return Response.json({
          id,
          name:id===chatChannelId?'chat':'General',
          type:id===chatChannelId?0:4,
          permission_overwrites:id===chatChannelId?channelOverwrites:[]
        });
      }
      return Response.json({message:'Missing Access'}, {status:403});
    }
  });
  t.after(() => mf.dispose());
  return {
    mf,
    calls,
    db:await mf.getD1Database('DB'),
    interactionPrivateKey,
    verificationMemberRoles
  };
}

async function request(mf, path, token, method = 'GET', body) {
  const response = await mf.dispatchFetch('https://worker.example' + path, {
    method,
    headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  return { status: response.status, body: await response.json() };
}

async function signedInteraction(mf, privateKey, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = signMessage(
    null,
    Buffer.from(timestamp + body),
    privateKey
  ).toString('hex');
  const response = await mf.dispatchFetch('https://worker.example/interactions', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Signature-Ed25519':signature,
      'X-Signature-Timestamp':timestamp
    },
    body
  });
  return {status:response.status,body:await response.json()};
}

for (const legacy of [false, true]) {
  test(`dashboard bootstrap and persisted data on ${legacy ? 'legacy' : 'empty'} D1`, async t => {
    const {mf, db, calls} = await runtime(t);
    if (legacy) {
      await db.batch([
        db.prepare('CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)'),
        db.prepare("INSERT INTO meta VALUES ('schema_version','1')"),
        db.prepare("CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY,config TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)"),
        db.prepare('INSERT INTO guild_settings VALUES (?,?,?)').bind(guildId, JSON.stringify({spamMax:17}), 1)
      ]);
    }
    const rejected = await request(mf, '/api/login', null, 'POST', {password:'wrong'});
    assert.equal(rejected.status, 401);
    const login = await request(mf, '/api/login', null, 'POST', {password:'local-test-password'});
    assert.equal(login.status, 200);
    const token = login.body.token;
    assert.ok(token);
    for (const path of ['/api/me','/api/guilds',`/api/guilds/${guildId}/meta`]) {
      const result = await request(mf,path,token);
      assert.equal(result.status,200,JSON.stringify(result.body));
      if (path.endsWith('/meta')) { assert.equal(result.body.channels.length,1); assert.equal(result.body.categories.length,1); }
    }
    assert.equal(calls.filter(c=>c.path===`/api/v10/guilds/${guildId}`).length,2,'guild lookup retries 429');
    const results = await Promise.all(['settings','products','vending'].map(s=>request(mf,`/api/guilds/${guildId}/${s}`,token)));
    for (const result of results) assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(results[0].body.spamMax,legacy?17:6);
    assert.deepEqual(results[1].body,[]);
    assert.deepEqual(results[2].body,[]);
    const version = await db.prepare("SELECT value FROM meta WHERE key='schema_version'").first();
    assert.equal(version.value,'3');
    const vm = await request(mf,`/api/guilds/${guildId}/vending`,token,'POST',{name:'Local test machine'});
    assert.equal(vm.status,201,JSON.stringify(vm.body));
    const vmList = await request(mf,`/api/guilds/${guildId}/vending`,token);
    assert.equal(vmList.body.length,1);
    const product = await request(mf,`/api/guilds/${guildId}/products`,token,'POST',{
      name:'Local text product',priceYen:100,deliveryType:'text',deliveryText:'test only'
    });
    assert.equal(product.status,201,JSON.stringify(product.body));
    assert.equal((await request(mf,`/api/guilds/${guildId}/products`,token)).body.length,1);
    assert.equal((await request(mf,'/api/logout',token,'POST')).status,200);
    assert.equal((await request(mf,'/api/me',token)).status,401);
  });
}

test('verification arithmetic assigns the configured Discord role and confirms it', async t => {
  const {mf,calls,db,interactionPrivateKey,verificationMemberRoles} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);

  const settings = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    login.body.token,
    'PUT',
    {verifiedRoleId:targetRoleId,minAccountAgeDays:0}
  );
  assert.equal(settings.status,200,JSON.stringify(settings.body));

  const start = await signedInteraction(mf,interactionPrivateKey,{
    type:3,
    guild_id:guildId,
    member:{user:{id:verificationUserId,username:'Verifier'}},
    data:{custom_id:`verify:start:${guildId}`}
  });
  assert.equal(start.status,200,JSON.stringify(start.body));
  const answerButtonId = start.body.data.components[0].components[0].custom_id;
  assert.match(answerButtonId,/^verify:answer:/);
  const question = start.body.data.content.match(/\*\*(\d+) \+ (\d+) = \?\*\*/);
  assert.ok(question,'verification response must contain an addition question');
  const answer = Number(question[1]) + Number(question[2]);

  const openModal = await signedInteraction(mf,interactionPrivateKey,{
    type:3,
    guild_id:guildId,
    member:{user:{id:verificationUserId,username:'Verifier'}},
    data:{custom_id:answerButtonId}
  });
  assert.equal(openModal.status,200,JSON.stringify(openModal.body));
  assert.equal(openModal.body.type,9);
  const modalId = openModal.body.data.custom_id;

  const completed = await signedInteraction(mf,interactionPrivateKey,{
    type:5,
    guild_id:guildId,
    member:{user:{id:verificationUserId,username:'Verifier'}},
    data:{
      custom_id:modalId,
      components:[{components:[{custom_id:'code',value:String(answer)}]}]
    }
  });
  assert.equal(completed.status,200,JSON.stringify(completed.body));
  assert.match(completed.body.data.content,/認証が完了しました/);
  assert.equal(completed.body.data.components[0].components[0].style,5);
  assert.match(
    completed.body.data.components[0].components[0].url,
    new RegExp(`/auth/recovery/start\\?guild_id=${guildId}import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';
const verificationUserId = '323456789012345679';
const botRoleId = '623456789012345678';
const targetRoleId = '523456789012345678';
const chatChannelId = '423456789012345678';
const guild = { id: guildId, name: 'Regression server', icon: null };
const nonAdminBotPermissions = (
  1024n|2048n|16384n|32768n|65536n|8192n|16n|268435456n|
  2n|4n|1099511627776n|128n
).toString();

async function runtime(t, options = {}) {
  const calls = [];
  const {privateKey:interactionPrivateKey,publicKey:interactionPublicKey} =
    generateKeyPairSync('ed25519');
  const publicKeyDer = interactionPublicKey.export({format:'der',type:'spki'});
  const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');
  let verificationMemberRoles = [...(options.verificationMemberRoles ?? [])];
  let rateLimitGuild = true;
  const botPermissions = options.botPermissions ?? nonAdminBotPermissions;
  const botRolePosition = options.botRolePosition ?? 2;
  const targetRolePosition = options.targetRolePosition ?? 1;
  let channelOverwrites = [...(options.channelOverwrites ?? [])];
  const forceBotOverwrite403 = options.forceBotOverwrite403 ?? false;
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    // Latest stable Miniflare 4 runtime; production keeps its newer date.
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId,
      DISCORD_PUBLIC_KEY: discordPublicKey,
      DASHBOARD_PASSWORD: 'local-test-password', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/', PAYPAY_ENV: 'sandbox'
    },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname });
      assert.equal(url.hostname, 'discord.com', 'tests must never contact payment providers');
      if (url.pathname.endsWith('/users/@me')) return Response.json({id: botId, username: 'Test bot'});
      if (url.pathname.endsWith('/users/@me/guilds')) return Response.json([guild]);
      if (url.pathname === `/api/v10/guilds/${guildId}`) {
        if (rateLimitGuild) { rateLimitGuild = false; return Response.json({ retry_after: 0.001 }, {status: 429}); }
        return Response.json(guild);
      }
      if (url.pathname.endsWith('/channels')) return Response.json([
        {id:'323456789012345678',name:'General',type:4,position:0},
        {
          id:chatChannelId,
          name:'chat',
          type:0,
          parent_id:'323456789012345678',
          position:1,
          permission_overwrites:channelOverwrites
        }
      ]);
      if (url.pathname.endsWith('/roles')) return Response.json([
        {id:guildId,name:'@everyone',position:0,managed:false,permissions:'0'},
        {id:targetRoleId,name:'Customer',position:targetRolePosition,managed:false,permissions:'0'},
        {
          id:botRoleId,
          name:'Test bot',
          position:botRolePosition,
          managed:true,
          permissions:botPermissions,
          tags:{bot_id:botId}
        }
      ]);
      if (url.pathname === `/api/v10/guilds/${guildId}/emojis`) return Response.json([]);
      if (url.pathname === `/api/v10/guilds/${guildId}/stickers`) return Response.json([]);
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/guilds/${guildId}/members`
      ) {
        return Response.json([{
          user:{id:verificationUserId,username:'Verifier',global_name:'Verifier',bot:false},
          nick:'Recovery Tester',
          roles:[targetRoleId],
          joined_at:'2026-01-01T00:00:00.000Z'
        }]);
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/channels/${chatChannelId}`
      ) {
        return Response.json({id:chatChannelId,guild_id:guildId,name:'chat',type:0});
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/channels/${chatChannelId}/messages`
      ) {
        return Response.json([]);
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v10/channels/${chatChannelId}/messages`
      ) {
        return Response.json({id:'723456789012345678',channel_id:chatChannelId},{status:200});
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/guilds/${guildId}/members/${verificationUserId}`
      ) {
        return Response.json({roles:[...verificationMemberRoles]});
      }
      if (
        request.method === 'PUT' &&
        url.pathname === `/api/v10/guilds/${guildId}/members/${verificationUserId}/roles/${targetRoleId}`
      ) {
        if (!verificationMemberRoles.includes(targetRoleId)) {
          verificationMemberRoles.push(targetRoleId);
        }
        return new Response(null,{status:204});
      }
      if (
        request.method === 'PUT' &&
        /^\/api\/v10\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)
      ) {
        if (forceBotOverwrite403 && url.pathname.endsWith(`/permissions/${botId}`)) {
          return Response.json({message:'Missing Access',code:50001},{status:403});
        }
        const parts = url.pathname.split('/');
        const channelId = parts[4];
        const overwriteId = parts[6];
        if (channelId === chatChannelId) {
          const body = await request.clone().json();
          channelOverwrites = [
            ...channelOverwrites.filter(
              overwrite => !(overwrite.id === overwriteId && overwrite.type === body.type)
            ),
            {
              id: overwriteId,
              type: body.type,
              allow: String(body.allow ?? '0'),
              deny: String(body.deny ?? '0')
            }
          ];
        }
        return new Response(null,{status:204});
      }
      if (
        request.method === 'DELETE' &&
        /^\/api\/v10\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)
      ) {
        const parts = url.pathname.split('/');
        const channelId = parts[4];
        const overwriteId = parts[6];
        if (channelId === chatChannelId) {
          channelOverwrites = channelOverwrites.filter(overwrite => overwrite.id !== overwriteId);
        }
        return new Response(null,{status:204});
      }
      if (
        request.method === 'PATCH' &&
        /^\/api\/v10\/channels\/\d+$/.test(url.pathname)
      ) {
        const id = url.pathname.split('/').at(-1);
        const body = await request.clone().json().catch(() => ({}));
        if (id === chatChannelId && Array.isArray(body.permission_overwrites)) {
          channelOverwrites = body.permission_overwrites.map(overwrite => ({
            id:String(overwrite.id),
            type:Number(overwrite.type),
            allow:String(overwrite.allow ?? '0'),
            deny:String(overwrite.deny ?? '0')
          }));
        }
        return Response.json({
          id,
          name:id===chatChannelId?'chat':'General',
          type:id===chatChannelId?0:4,
          permission_overwrites:id===chatChannelId?channelOverwrites:[]
        });
      }
      return Response.json({message:'Missing Access'}, {status:403});
    }
  });
  t.after(() => mf.dispose());
  return {
    mf,
    calls,
    db:await mf.getD1Database('DB'),
    interactionPrivateKey,
    verificationMemberRoles
  };
}

async function request(mf, path, token, method = 'GET', body) {
  const response = await mf.dispatchFetch('https://worker.example' + path, {
    method,
    headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  return { status: response.status, body: await response.json() };
}

async function signedInteraction(mf, privateKey, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = signMessage(
    null,
    Buffer.from(timestamp + body),
    privateKey
  ).toString('hex');
  const response = await mf.dispatchFetch('https://worker.example/interactions', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Signature-Ed25519':signature,
      'X-Signature-Timestamp':timestamp
    },
    body
  });
  return {status:response.status,body:await response.json()};
}

for (const legacy of [false, true]) {
  test(`dashboard bootstrap and persisted data on ${legacy ? 'legacy' : 'empty'} D1`, async t => {
    const {mf, db, calls} = await runtime(t);
    if (legacy) {
      await db.batch([
        db.prepare('CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)'),
        db.prepare("INSERT INTO meta VALUES ('schema_version','1')"),
        db.prepare("CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY,config TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)"),
        db.prepare('INSERT INTO guild_settings VALUES (?,?,?)').bind(guildId, JSON.stringify({spamMax:17}), 1)
      ]);
    }
    const rejected = await request(mf, '/api/login', null, 'POST', {password:'wrong'});
    assert.equal(rejected.status, 401);
    const login = await request(mf, '/api/login', null, 'POST', {password:'local-test-password'});
    assert.equal(login.status, 200);
    const token = login.body.token;
    assert.ok(token);
    for (const path of ['/api/me','/api/guilds',`/api/guilds/${guildId}/meta`]) {
      const result = await request(mf,path,token);
      assert.equal(result.status,200,JSON.stringify(result.body));
      if (path.endsWith('/meta')) { assert.equal(result.body.channels.length,1); assert.equal(result.body.categories.length,1); }
    }
    assert.equal(calls.filter(c=>c.path===`/api/v10/guilds/${guildId}`).length,2,'guild lookup retries 429');
    const results = await Promise.all(['settings','products','vending'].map(s=>request(mf,`/api/guilds/${guildId}/${s}`,token)));
    for (const result of results) assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(results[0].body.spamMax,legacy?17:6);
    assert.deepEqual(results[1].body,[]);
    assert.deepEqual(results[2].body,[]);
    const version = await db.prepare("SELECT value FROM meta WHERE key='schema_version'").first();
    assert.equal(version.value,'3');
    const vm = await request(mf,`/api/guilds/${guildId}/vending`,token,'POST',{name:'Local test machine'});
    assert.equal(vm.status,201,JSON.stringify(vm.body));
    const vmList = await request(mf,`/api/guilds/${guildId}/vending`,token);
    assert.equal(vmList.body.length,1);
    const product = await request(mf,`/api/guilds/${guildId}/products`,token,'POST',{
      name:'Local text product',priceYen:100,deliveryType:'text',deliveryText:'test only'
    });
    assert.equal(product.status,201,JSON.stringify(product.body));
    assert.equal((await request(mf,`/api/guilds/${guildId}/products`,token)).body.length,1);
    assert.equal((await request(mf,'/api/logout',token,'POST')).status,200);
    assert.equal((await request(mf,'/api/me',token)).status,401);
  });
}

test('verification arithmetic assigns the configured Discord role and confirms it', async t => {
  const {mf,calls,db,interactionPrivateKey,verificationMemberRoles} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);

  const settings = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    login.body.token,
    'PUT',
    {verifiedRoleId:targetRoleId,minAccountAgeDays:0}
  );
  assert.equal(settings.status,200,JSON.stringify(settings.body));

  const start = await signedInteraction(mf,interactionPrivateKey,{
    type:3,
    guild_id:guildId,
    member:{user:{id:verificationUserId,username:'Verifier'}},
    data:{custom_id:`verify:start:${guildId}`}
  });
  assert.equal(start.status,200,JSON.stringify(start.body));
  const answerButtonId = start.body.data.components[0].components[0].custom_id;
  assert.match(answerButtonId,/^verify:answer:/);
  const question = start.body.data.content.match(/\*\*(\d+) \+ (\d+) = \?\*\*/);
  assert.ok(question,'verification response must contain an addition question');
  const answer = Number(question[1]) + Number(question[2]);

  const openModal = await signedInteraction(mf,interactionPrivateKey,{
    type:3,
    guild_id:guildId,
    member:{user:{id:verificationUserId,username:'Verifier'}},
    data:{custom_id:answerButtonId}
  });
  assert.equal(openModal.status,200,JSON.stringify(openModal.body));
  assert.equal(openModal.body.type,9);
  const modalId = openModal.body.data.custom_id;

  const completed = await signedInteraction(mf,interactionPrivateKey,{
    type:5,
    guild_id:guildId,
    member:{user:{id:verificationUserId,username:'Verifier'}},
    data:{
      custom_id:modalId,
      components:[{components:[{custom_id:'code',value:String(answer)}]}]
    }
  });
  assert.equal(completed.status,200,JSON.stringify(completed.body));
)
  );
  assert.ok(
    verificationMemberRoles.includes(targetRoleId),
    'Discord member state must contain the configured verification role'
  );

  const grantPath =
    `/api/v10/guilds/${guildId}/members/${verificationUserId}/roles/${targetRoleId}`;
  const grantIndex = calls.findIndex(call=>call.method==='PUT'&&call.path===grantPath);
  assert.ok(grantIndex>=0,'worker must call Discord role assignment endpoint');
  assert.ok(
    calls.slice(grantIndex+1).some(call=>
      call.method==='GET' &&
      call.path===`/api/v10/guilds/${guildId}/members/${verificationUserId}`
    ),
    'worker must re-fetch the member after role assignment to confirm persistence'
  );

  const remaining = await db.prepare(
    'SELECT COUNT(*) AS count FROM verification_challenges'
  ).first();
  assert.equal(remaining.count,0,'successful verification must consume its challenge');
});

test('backup snapshot is encrypted, listed, previewable, and recovery panel is tracked', async t => {
  const {mf,db,calls} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);
  const token = login.body.token;

  const created = await request(
    mf,
    `/api/guilds/${guildId}/backups`,
    token,
    'POST',
    {label:'Before major change'}
  );
  assert.equal(created.status,201,JSON.stringify(created.body));
  assert.equal(created.body.sourceGuildId,guildId);
  assert.equal(created.body.roleCount,3);
  assert.equal(created.body.channelCount,2);
  assert.equal(created.body.memberCount,1);

  const stored = await db.prepare(
    'SELECT payload_enc FROM guild_backups WHERE id=?'
  ).bind(created.body.id).first();
  assert.equal(stored?.payload_enc,'chunked:v1');
  const firstChunk = await db.prepare(
    'SELECT payload_chunk FROM guild_backup_chunks WHERE backup_id=? ORDER BY chunk_index LIMIT 1'
  ).bind(created.body.id).first();
  assert.ok(firstChunk?.payload_chunk);
  assert.equal(
    firstChunk.payload_chunk.includes('Regression server'),
    false,
    'snapshot chunks must remain encrypted at rest'
  );

  const listed = await request(
    mf,
    `/api/backups?sourceGuildId=${guildId}`,
    token
  );
  assert.equal(listed.status,200,JSON.stringify(listed.body));
  assert.equal(listed.body.length,1);
  assert.equal(listed.body[0].id,created.body.id);

  const preview = await request(
    mf,
    `/api/backups/${created.body.id}/restore/preview`,
    token,
    'POST',
    {targetGuildId:guildId}
  );
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(preview.body.behavior.destructive,false);
  assert.equal(preview.body.behavior.deletesExisting,false);
  assert.equal(preview.body.counts.members,1);

  const recovery = await request(
    mf,
    `/api/guilds/${guildId}/recovery/status`,
    token
  );
  assert.equal(recovery.status,200,JSON.stringify(recovery.body));
  assert.equal(recovery.body.registered,0);

  const panel = await request(
    mf,
    `/api/guilds/${guildId}/recovery/panel`,
    token,
    'POST',
    {channelId:chatChannelId}
  );
  assert.equal(panel.status,200,JSON.stringify(panel.body));
  const deployment = await db.prepare(
    "SELECT kind,channel_id,message_id FROM panel_deployments WHERE guild_id=? AND kind='recovery'"
  ).bind(guildId).first();
  assert.equal(deployment.channel_id,chatChannelId);
  assert.ok(deployment.message_id);
  assert.ok(
    calls.some(call=>
      call.method==='POST'&&call.path===`/api/v10/channels/${chatChannelId}/messages`
    ),
    'recovery panel must be posted through Discord API'
  );
});

test('verification settings persist account age and role values', async t => {
  const {mf} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);
  const token = login.body.token;

  const saved = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    token,
    'PUT',
    {
      verifiedRoleId:targetRoleId,
      minAccountAgeDays:37
    }
  );
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(saved.body.verifiedRoleId,targetRoleId);
  assert.equal(saved.body.minAccountAgeDays,37);

  const fresh = await request(mf,`/api/guilds/${guildId}/settings`,token);
  assert.equal(fresh.status,200,JSON.stringify(fresh.body));
  assert.equal(fresh.body.verifiedRoleId,targetRoleId);
  assert.equal(fresh.body.minAccountAgeDays,37);

  const invalid = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    token,
    'PUT',
    {minAccountAgeDays:-1}
  );
  assert.equal(invalid.status,400,JSON.stringify(invalid.body));
});

test('verification settings do not false-block equal Discord role positions', async t => {
  const {mf} = await runtime(t, {
    botRolePosition:1,
    targetRolePosition:1
  });
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);
  const token = login.body.token;

  const saved = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    token,
    'PUT',
    {
      verifiedRoleId:targetRoleId,
      minAccountAgeDays:7
    }
  );

  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(saved.body.verifiedRoleId,targetRoleId);
  assert.equal(saved.body.minAccountAgeDays,7);
});

test('D1 rejects multiline exec but migration uses complete prepared statements', async t => {
  const {db} = await runtime(t);
  await assert.rejects(db.exec('CREATE TABLE broken (\n id TEXT PRIMARY KEY\n);'), /incomplete input/);
});


test('channel permission edit does not require direct channel access', async t => {
  const {mf, calls} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);
  const token = login.body.token;

  const result = await request(
    mf,
    `/api/guilds/${guildId}/channels/${chatChannelId}/permissions/${targetRoleId}`,
    token,
    'PATCH',
    {
      targetType:'role',
      permissions:{send:'deny'}
    }
  );

  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.targetId,targetRoleId);
  assert.equal(result.body.deny,'2048');
  assert.equal(
    calls.some(call=>call.path===`/api/v10/channels/${chatChannelId}`),
    false,
    'permission editing must not GET the inaccessible channel directly'
  );
  assert.equal(
    calls.some(
      call=>
        call.method==='PUT' &&
        call.path===`/api/v10/channels/${chatChannelId}/permissions/${targetRoleId}`
    ),
    true,
    'permission overwrite should still be written'
  );
});


test('non-admin bot role allow overrides @everyone channel deny', async t => {
  const botPermissions = nonAdminBotPermissions;
  const {mf} = await runtime(t, {
    botPermissions,
    channelOverwrites:[
      {id:guildId,type:0,allow:'0',deny:'1024'},
      {id:botRoleId,type:0,allow:'1024',deny:'0'}
    ]
  });
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);
  const meta = await request(mf, `/api/guilds/${guildId}/meta`, login.body.token);
  assert.equal(meta.status,200,JSON.stringify(meta.body));
  const chat = meta.body.channels.find(channel=>channel.id===chatChannelId);
  assert.ok(chat);
  assert.equal(chat.botCanView,true);
  assert.equal(meta.body.botAdministrator,false);
  assert.ok(meta.body.botAccessRepair.repaired>=1);
  assert.equal(meta.body.botAccessRepair.failed.length,0);
});

test('editing @everyone protects the bot member before applying the deny', async t => {
  const botPermissions = (
    1024n|2048n|16384n|32768n|65536n|8192n|16n|268435456n
  ).toString();
  const {mf,calls} = await runtime(t,{botPermissions});
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);

  const result = await request(
    mf,
    `/api/guilds/${guildId}/channels/${chatChannelId}/permissions/${guildId}`,
    login.body.token,
    'PATCH',
    {
      targetType:'role',
      permissions:{view:'deny'}
    }
  );
  assert.equal(result.status,200,JSON.stringify(result.body));

  const botGuardIndex = calls.findIndex(call=>
    call.method==='PUT' &&
    call.path===`/api/v10/channels/${chatChannelId}/permissions/${botId}`
  );
  const everyoneIndex = calls.findIndex(call=>
    call.method==='PUT' &&
    call.path===`/api/v10/channels/${chatChannelId}/permissions/${guildId}`
  );
  assert.ok(botGuardIndex>=0,'bot member overwrite must be written');
  assert.ok(everyoneIndex>=0,'@everyone overwrite must be written');
  assert.ok(
    botGuardIndex<everyoneIndex,
    'bot protection must be applied before @everyone is denied'
  );
});


test('locked channel repair falls back to full channel overwrite patch', async t => {
  const {mf,calls} = await runtime(t,{forceBotOverwrite403:true});
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);

  const meta = await request(mf, `/api/guilds/${guildId}/meta`, login.body.token);
  assert.equal(meta.status,200,JSON.stringify(meta.body));
  assert.equal(meta.body.botAccessRepair.failed.length,0);
  assert.ok(
    calls.some(call=>
      call.method==='PATCH' &&
      call.path===`/api/v10/channels/${chatChannelId}`
    ),
    'locked channel should use the full-overwrite PATCH recovery path'
  );
});


test('bulk channel permission update persists and verifies the selected role overwrite', async t => {
  const {mf,calls} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);

  const result = await request(
    mf,
    `/api/guilds/${guildId}/channels/permissions/bulk`,
    login.body.token,
    'PATCH',
    {
      channelIds:[chatChannelId],
      targetId:targetRoleId,
      permissions:{view:'allow',send:'deny'}
    }
  );

  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.ok,true,JSON.stringify(result.body));
  assert.equal(result.body.updated,1,JSON.stringify(result.body));
  assert.deepEqual(result.body.failed,[]);
  assert.equal(typeof result.body.operationId,'string');
  assert.ok(result.body.operationId.length>0);
  assert.ok(
    calls.some(call=>
      call.method==='PUT' &&
      call.path===`/api/v10/channels/${chatChannelId}/permissions/${targetRoleId}`
    ),
    'bulk endpoint must write the selected role overwrite'
  );

  const meta = await request(mf,`/api/guilds/${guildId}/meta`,login.body.token);
  assert.equal(meta.status,200,JSON.stringify(meta.body));
  const chat = meta.body.channels.find(channel=>channel.id===chatChannelId);
  assert.ok(chat);
  const overwrite = chat.permissionOverwrites.find(
    item=>item.id===targetRoleId&&item.type===0
  );
  assert.ok(overwrite,'selected role overwrite must survive a fresh meta read');
  assert.equal(BigInt(overwrite.allow)&1024n,1024n,'view must be allowed');
  assert.equal(BigInt(overwrite.deny)&2048n,2048n,'send must be denied');
});
