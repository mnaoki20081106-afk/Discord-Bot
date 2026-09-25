import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';
const verificationUserId = '323456789012345679';
const bannedUserId = '323456789012345680';
const botRoleId = '623456789012345678';
const targetRoleId = '523456789012345678';
const chatChannelId = '423456789012345678';
const guild = { id: guildId, name: 'Regression server', icon: null };
const nonAdminBotPermissions = (
  1n|32n|1024n|2048n|16384n|32768n|65536n|8192n|16n|134217728n|268435456n|
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
  const forceVerificationRole403 = options.forceVerificationRole403 ?? false;
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
      if (
        request.method === 'POST' &&
        url.pathname === '/api/v10/oauth2/token'
      ) {
        return Response.json({
          access_token:'verification-access-token',
          refresh_token:'verification-refresh-token',
          expires_in:3600
        });
      }
      if (url.pathname.endsWith('/users/@me')) {
        const auth=request.headers.get('Authorization') ?? '';
        if (auth.startsWith('Bearer ')) {
          return Response.json({
            id:verificationUserId,
            username:'Verifier',
            global_name:'Verifier'
          });
        }
        return Response.json({id:botId,username:'Test bot'});
      }
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
        url.pathname === `/api/v10/guilds/${guildId}/bans`
      ) {
        return Response.json([{
          user:{id:bannedUserId,username:'BlockedUser',global_name:'Blocked User'},
          reason:'Regression ban'
        }]);
      }
      if (
        request.method === 'PUT' &&
        url.pathname === `/api/v10/guilds/${guildId}/bans/${bannedUserId}`
      ) {
        return new Response(null,{status:204});
      }
      if (url.pathname === `/api/v10/guilds/${guildId}/welcome-screen`) {
        if (request.method === 'PATCH') {
          return Response.json(await request.clone().json());
        }
        return Response.json({
          description:'Welcome to the regression server',
          welcome_channels:[{
            channel_id:chatChannelId,
            description:'Start here',
            emoji_id:null,
            emoji_name:'👋'
          }]
        });
      }
      if (url.pathname === `/api/v10/guilds/${guildId}/widget`) {
        if (request.method === 'PATCH') {
          return Response.json(await request.clone().json());
        }
        return Response.json({enabled:true,channel_id:chatChannelId});
      }
      if (
        request.method === 'PATCH' &&
        /^\/api\/v10\/guilds\/\d+\/roles\/\d+$/.test(url.pathname)
      ) {
        const id=url.pathname.split('/').at(-1);
        const body=await request.clone().json().catch(()=>({}));
        return Response.json({
          id,
          name:id===targetRoleId?'Customer':'@everyone',
          position:id===targetRoleId?targetRolePosition:0,
          managed:false,
          permissions:String(body.permissions??'0'),
          color:Number(body.color??0),
          hoist:Boolean(body.hoist),
          mentionable:Boolean(body.mentionable)
        });
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v10/guilds/${guildId}/members`
      ) {
        return Response.json([{
          user:{id:verificationUserId,username:'Verifier',global_name:'Verifier',bot:false},
          nick:'Recovery Tester',
          roles:[targetRoleId],
          joined_at:'2026-01-01T00:00:00.000Z',
          communication_disabled_until:'2099-01-01T00:00:00.000Z'
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
        calls[calls.length-1].body=await request.clone().json().catch(()=>null);
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
        if (forceVerificationRole403) {
          return Response.json({message:'Missing Permissions',code:50013},{status:403});
        }
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

test('verification panel deployment points directly to unified oauth', async t => {
  const {mf,calls,db} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);
  const token=login.body.token;

  const rejected=await request(
    mf,
    `/api/guilds/${guildId}/verification/panel`,
    token,
    'POST',
    {channelId:chatChannelId}
  );
  assert.equal(rejected.status,409,JSON.stringify(rejected.body));
  assert.match(rejected.body.message,/認証後ロール/);
  assert.equal(
    calls.some(call=>call.method==='POST'&&call.path===`/api/v10/channels/${chatChannelId}/messages`),
    false,
    'an unusable verification panel must not be posted'
  );

  const settings=await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    token,
    'PUT',
    {verifiedRoleId:targetRoleId,minAccountAgeDays:0}
  );
  assert.equal(settings.status,200,JSON.stringify(settings.body));

  const deployed=await request(
    mf,
    `/api/guilds/${guildId}/verification/panel`,
    token,
    'POST',
    {channelId:chatChannelId}
  );
  assert.equal(deployed.status,200,JSON.stringify(deployed.body));

  const post=calls.find(call=>
    call.method==='POST'&&call.path===`/api/v10/channels/${chatChannelId}/messages`
  );
  assert.ok(post?.body,'verification panel payload must be sent to Discord');
  const button=post.body.components?.[0]?.components?.[0];
  assert.equal(button?.style,5);
  assert.equal(button?.custom_id,undefined);
  const panelUrl=new URL(button?.url);
  assert.equal(panelUrl.origin,'https://worker.example');
  assert.equal(panelUrl.pathname,'/auth/verification/start');
  assert.equal(panelUrl.searchParams.get('guild_id'),guildId);
  assert.match(post.body.embeds?.[0]?.description??'',/復旧/);

  const deployment=await db.prepare(
    "SELECT channel_id,message_id FROM panel_deployments WHERE guild_id=? AND kind='verification'"
  ).bind(guildId).first();
  assert.equal(deployment?.channel_id,chatChannelId);
  assert.ok(deployment?.message_id);
});

test('verification panel oauth stores recovery access before assigning the role', async t => {
  const {mf,calls,db,interactionPrivateKey,verificationMemberRoles} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  const settings = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    login.body.token,
    'PUT',
    {verifiedRoleId:targetRoleId,minAccountAgeDays:0}
  );
  assert.equal(settings.status,200,JSON.stringify(settings.body));

  // This is the actual URL used by newly deployed verification panels.
  const started=await mf.dispatchFetch(
    'https://worker.example/auth/verification/start?guild_id='+encodeURIComponent(guildId)
  );
  assert.equal(started.status,302);
  const authorizeUrl=new URL(started.headers.get('location'));
  assert.equal(authorizeUrl.hostname,'discord.com');
  assert.ok(authorizeUrl.searchParams.get('scope')?.includes('guilds.join'));
  const state=authorizeUrl.searchParams.get('state');
  assert.ok(state);
  assert.equal(verificationMemberRoles.includes(targetRoleId),false);

  const stateRow=await db.prepare(
    'SELECT purpose,expected_user_id FROM member_recovery_oauth_states WHERE state=?'
  ).bind(state).first();
  assert.equal(stateRow?.purpose,'verification');
  assert.equal(stateRow?.expected_user_id,null);

  const callback=await mf.dispatchFetch(
    'https://worker.example/auth/discord/callback?code=ok&state='+encodeURIComponent(state)
  );
  assert.equal(callback.status,200);
  assert.equal(callback.headers.get('cache-control'),'no-store');
  assert.match(callback.headers.get('content-security-policy')??'',/default-src 'none'/);

  const saved = await db.prepare(
    'SELECT user_id,revoked_at FROM member_recovery_tokens WHERE guild_id=? AND user_id=?'
  ).bind(guildId,verificationUserId).first();
  assert.equal(saved?.user_id,verificationUserId);
  assert.equal(saved?.revoked_at,null);
  assert.ok(verificationMemberRoles.includes(targetRoleId));

  const grantPath=
    `/api/v10/guilds/${guildId}/members/${verificationUserId}/roles/${targetRoleId}`;
  assert.ok(calls.some(call=>call.method==='PUT'&&call.path===grantPath));

  // Restored/legacy verification panels still use an interaction button.
  // It must create the same verification-purpose OAuth state and bind it to
  // the Discord user who pressed the button.
  const interactionStart = await signedInteraction(mf,interactionPrivateKey,{
    type:3,
    guild_id:guildId,
    member:{user:{id:verificationUserId,username:'Verifier'}},
    data:{custom_id:`verify:start:${guildId}`}
  });
  assert.equal(interactionStart.status,200,JSON.stringify(interactionStart.body));
  const interactionUrl=new URL(interactionStart.body.data.components[0].components[0].url);
  const interactionState=interactionUrl.searchParams.get('state');
  assert.ok(interactionState);
  const interactionStateRow=await db.prepare(
    'SELECT purpose,expected_user_id FROM member_recovery_oauth_states WHERE state=?'
  ).bind(interactionState).first();
  assert.equal(interactionStateRow?.purpose,'verification');
  assert.equal(interactionStateRow?.expected_user_id,verificationUserId);

  const remaining = await db.prepare(
    'SELECT COUNT(*) AS count FROM verification_challenges'
  ).first();
  assert.equal(remaining.count,0);

  const legacyStart=await mf.dispatchFetch(
    'https://worker.example/auth/recovery/start?guild_id='+encodeURIComponent(guildId)
  );
  assert.equal(legacyStart.status,302);
  const legacyAuthorizeUrl=new URL(legacyStart.headers.get('location'));
  const legacyState=legacyAuthorizeUrl.searchParams.get('state');
  assert.ok(legacyState);
  const legacyStateRow=await db.prepare(
    'SELECT purpose FROM member_recovery_oauth_states WHERE state=?'
  ).bind(legacyState).first();
  assert.equal(
    legacyStateRow?.purpose,
    'verification',
    'legacy recovery links must use the unified verification flow'
  );
});

test('cancelled discord verification consumes state without registering', async t => {
  const {mf,db,verificationMemberRoles} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  const settings = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    login.body.token,
    'PUT',
    {verifiedRoleId:targetRoleId,minAccountAgeDays:0}
  );
  assert.equal(settings.status,200,JSON.stringify(settings.body));

  const started=await mf.dispatchFetch(
    'https://worker.example/auth/verification/start?guild_id='+encodeURIComponent(guildId)
  );
  const state=new URL(started.headers.get('location')).searchParams.get('state');
  assert.ok(state);

  const cancelled=await mf.dispatchFetch(
    'https://worker.example/auth/discord/callback?error=access_denied&state='+encodeURIComponent(state)
  );
  assert.equal(cancelled.status,400);
  assert.match(await cancelled.text(),/認証をキャンセルしました/);

  const remaining=await db.prepare(
    'SELECT COUNT(*) AS count FROM member_recovery_oauth_states WHERE state=?'
  ).bind(state).first();
  assert.equal(remaining.count,0);
  const saved=await db.prepare(
    'SELECT COUNT(*) AS count FROM member_recovery_tokens WHERE guild_id=? AND user_id=?'
  ).bind(guildId,verificationUserId).first();
  assert.equal(saved.count,0);
  assert.equal(verificationMemberRoles.includes(targetRoleId),false);
});

test('verification rejection does not create recovery registration', async t => {
  const {mf,db,verificationMemberRoles} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  const settings = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    login.body.token,
    'PUT',
    {verifiedRoleId:targetRoleId,minAccountAgeDays:36500}
  );
  assert.equal(settings.status,200,JSON.stringify(settings.body));

  const started=await mf.dispatchFetch(
    'https://worker.example/auth/verification/start?guild_id='+encodeURIComponent(guildId)
  );
  assert.equal(started.status,302);
  const state=new URL(started.headers.get('location')).searchParams.get('state');
  assert.ok(state);

  const callback=await mf.dispatchFetch(
    'https://worker.example/auth/discord/callback?code=too-young&state='+encodeURIComponent(state)
  );
  assert.equal(callback.status,403);
  const body=await callback.json();
  assert.match(body.message,/認証条件/);

  const saved=await db.prepare(
    'SELECT COUNT(*) AS count FROM member_recovery_tokens WHERE guild_id=? AND user_id=?'
  ).bind(guildId,verificationUserId).first();
  assert.equal(saved.count,0);
  assert.equal(verificationMemberRoles.includes(targetRoleId),false);
});

test('verification role grant failure is not reported as success', async t => {
  const {mf,db,verificationMemberRoles} = await runtime(t,{
    forceVerificationRole403:true
  });
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  const settings = await request(
    mf,
    `/api/guilds/${guildId}/settings`,
    login.body.token,
    'PUT',
    {verifiedRoleId:targetRoleId,minAccountAgeDays:0}
  );
  assert.equal(settings.status,200,JSON.stringify(settings.body));

  const started=await mf.dispatchFetch(
    'https://worker.example/auth/verification/start?guild_id='+encodeURIComponent(guildId)
  );
  const state=new URL(started.headers.get('location')).searchParams.get('state');
  assert.ok(state);
  const callback=await mf.dispatchFetch(
    'https://worker.example/auth/discord/callback?code=role-fail&state='+encodeURIComponent(state)
  );
  assert.equal(callback.status,403);
  const body=await callback.json();
  assert.match(body.message,/認証ロールを付与できませんでした/);
  assert.equal(verificationMemberRoles.includes(targetRoleId),false);

  const saved=await db.prepare(
    'SELECT user_id,revoked_at FROM member_recovery_tokens WHERE guild_id=? AND user_id=?'
  ).bind(guildId,verificationUserId).first();
  assert.equal(saved?.user_id,verificationUserId);
  assert.equal(saved?.revoked_at,null);
});

test('backup snapshot is encrypted, listed, previewable, and recovery uses verification', async t => {
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
  assert.equal(preview.body.counts.bans,1);

  const recovery = await request(
    mf,
    `/api/guilds/${guildId}/recovery/status`,
    token
  );
  assert.equal(recovery.status,200,JSON.stringify(recovery.body));
  assert.equal(recovery.body.registered,0);
  assert.equal(recovery.body.registrationMode,'verification');
  assert.equal(recovery.body.separatePanelAvailable,false);
  assert.equal(
    recovery.body.authorizePath,
    '/auth/verification/start?guild_id='+encodeURIComponent(guildId)
  );

  const panel = await request(
    mf,
    `/api/guilds/${guildId}/recovery/panel`,
    token,
    'POST',
    {channelId:chatChannelId}
  );
  assert.equal(panel.status,410,JSON.stringify(panel.body));
  assert.match(panel.body.message,/認証パネルへ統合/);
  const deployment = await db.prepare(
    "SELECT COUNT(*) AS count FROM panel_deployments WHERE guild_id=? AND kind='recovery'"
  ).bind(guildId).first();
  assert.equal(deployment.count,0);
});

test('restore job replays guild extras and bans without deleting existing structure', async t => {
  const {mf,calls} = await runtime(t);
  const login = await request(mf, '/api/login', null, 'POST', {
    password:'local-test-password'
  });
  assert.equal(login.status,200);
  const token=login.body.token;

  const created=await request(
    mf,
    `/api/guilds/${guildId}/backups`,
    token,
    'POST',
    {label:'Restore regression'}
  );
  assert.equal(created.status,201,JSON.stringify(created.body));

  const started=await request(
    mf,
    `/api/backups/${created.body.id}/restore`,
    token,
    'POST',
    {targetGuildId:guildId}
  );
  assert.equal(started.status,202,JSON.stringify(started.body));

  const worker=await mf.getWorker();
  let job=started.body;
  for(let tick=0;tick<24 && !['completed','failed','cancelled'].includes(job.status);tick++){
    const scheduled=await worker.scheduled({cron:'* * * * *'});
    assert.equal(scheduled.outcome,'ok');
    const current=await request(mf,`/api/restore-jobs/${job.id}`,token);
    assert.equal(current.status,200,JSON.stringify(current.body));
    job=current.body;
  }

  assert.equal(job.status,'completed',JSON.stringify(job));
  assert.equal(job.result.bansRestored,1);
  assert.ok(job.result.guildExtrasRestored>=2);
  assert.ok(
    calls.some(call=>
      call.method==='PUT'&&
      call.path===`/api/v10/guilds/${guildId}/bans/${bannedUserId}`
    ),
    'restore must recreate the backed-up ban'
  );
  assert.ok(
    calls.some(call=>
      call.method==='PATCH'&&
      call.path===`/api/v10/guilds/${guildId}/welcome-screen`
    ),
    'restore must replay the welcome screen'
  );
  assert.ok(
    calls.some(call=>
      call.method==='PATCH'&&
      call.path===`/api/v10/guilds/${guildId}/widget`
    ),
    'restore must replay widget settings'
  );
  assert.equal(
    calls.some(call=>call.method==='DELETE'&&/\/channels\/\d+$/.test(call.path)),
    false,
    'safe restore must never delete existing channels'
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
