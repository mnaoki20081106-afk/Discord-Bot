import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';
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
  let rateLimitGuild = true;
  const botPermissions = options.botPermissions ?? nonAdminBotPermissions;
  const channelOverwrites = options.channelOverwrites ?? [];
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    // Latest stable Miniflare 4 runtime; production keeps its newer date.
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId,
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
        {id:targetRoleId,name:'Customer',position:1,managed:false,permissions:'0'},
        {
          id:botRoleId,
          name:'Test bot',
          position:2,
          managed:true,
          permissions:botPermissions,
          tags:{bot_id:botId}
        }
      ]);
      if (
        request.method === 'PUT' &&
        /^\/api\/v10\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)
      ) return new Response(null,{status:204});
      return Response.json({message:'Missing Access'}, {status:403});
    }
  });
  t.after(() => mf.dispose());
  return {mf, calls, db: await mf.getD1Database('DB')};
}

async function request(mf, path, token, method = 'GET', body) {
  const response = await mf.dispatchFetch('https://worker.example' + path, {
    method,
    headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  return { status: response.status, body: await response.json() };
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
