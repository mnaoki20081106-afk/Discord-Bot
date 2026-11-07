import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const guildId = '123456789012345678';
const botId = '223456789012345678';
const userA = '323456789012345001';
const userB = '323456789012345002';
const staffUser = '323456789012345003';
const staffRole = '523456789012345001';
const blacklistRole = '523456789012345002';
const panelChannel = '423456789012345001';
const staffChannel = '423456789012345002';
const categoryId = '423456789012345003';
const resultChannel = '423456789012345004';
const logChannel = '423456789012345005';
const tradeChannel = '423456789012345099';
const oldJoin = '2020-01-01T00:00:00.000Z';

function payLink(code) { return 'https://pay.paypay.ne.jp/' + code; }

async function runtime(t) {
  const calls = [];
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const discordPublicKey = Buffer.from(publicKey.export({format:'der',type:'spki'})).subarray(-32).toString('hex');
  // PayPay link state: code -> {amount, status, passcode}
  const links = new Map();
  const accepted = [];
  const created = [];
  let tokenCalls = 0;
  let messageSeq = 1000;
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId, DISCORD_PUBLIC_KEY: discordPublicKey,
      DASHBOARD_PASSWORD: 'local-test-password', SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/'
    },
    outboundService: async request => {
      const url = new URL(request.url);
      const method = request.method;
      const raw = method === 'GET' || method === 'DELETE' ? '' : await request.clone().text().catch(() => '');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      calls.push({method, host: url.hostname, path: url.pathname, search: url.search, body, contentType: request.headers.get('content-type') ?? ''});

      if (url.hostname === 'www.paypay.ne.jp') {
        if (url.pathname === '/app/v1/oauth/token') {
          tokenCalls++;
          if (tokenCalls === 1) return Response.json({otp_reference_id: 'ref', otp_prefix: 'AB'});
          return Response.json({access_token: 'paypay-token'});
        }
        if (url.pathname === '/app/v2/p2p-api/getP2PLinkInfo') {
          const link = links.get(url.searchParams.get('verificationCode'));
          if (!link) return Response.json({header: {resultCode: 'S9999'}});
          return Response.json({header: {resultCode: 'S0000'}, payload: {
            orderStatus: link.status,
            pendingP2PInfo: {isSetPasscode: Boolean(link.passcode)},
            message: {messageId: 'm', chatRoomId: 'c', data: {amount: link.amount, requestId: 'r', orderId: 'o'}}
          }});
        }
        if (url.pathname === '/app/v2/p2p-api/acceptP2PSendMoneyLink') {
          const link = links.get(body.verificationCode);
          accepted.push(body);
          if (!link || link.status !== 'PENDING' || (link.passcode && body.passcode !== link.passcode)) {
            return Response.json({header: {resultCode: 'S1000'}});
          }
          link.status = 'COMPLETED';
          return Response.json({header: {resultCode: 'S0000'}});
        }
        if (url.pathname === '/app/v2/p2p-api/executeP2PSendMoneyLink') {
          created.push(body);
          return Response.json({header: {resultCode: 'S0000'}, payload: {link: payLink('payout' + created.length)}});
        }
        return Response.json({}, {status: 404});
      }

      assert.equal(url.hostname, 'discord.com', 'unexpected outbound host ' + url.hostname);
      const p = url.pathname.replace('/api/v10', '');
      if (method === 'GET' && p === `/guilds/${guildId}`) return Response.json({id: guildId, name: 'Fixture', icon: null});
      // Server members for /check (A, B, staff, plus an unrelated member and a bot)
      const roster = [
        {user: {id: userA, username: 'alice', global_name: 'Alice'}},
        {user: {id: userB, username: 'bob', global_name: 'Bob'}, nick: 'ボブ'},
        {user: {id: staffUser, username: 'staff'}},
        {user: {id: '323456789012345099', username: 'carol', global_name: 'Carol'}},
        {user: {id: '323456789012345098', username: 'somebot', bot: true}}
      ];
      if (method === 'GET' && p === `/guilds/${guildId}/members/search`) {
        const q = (url.searchParams.get('query') ?? '').toLowerCase();
        return Response.json(roster.filter(m => [m.user.username, m.user.global_name, m.nick].some(v => v && v.toLowerCase().startsWith(q))).slice(0, Number(url.searchParams.get('limit') ?? 25)));
      }
      if (method === 'GET' && p === `/guilds/${guildId}/members`) return Response.json(roster);
      const oneMember = p.match(new RegExp(`^/guilds/${guildId}/members/(\\d+)$`));
      if (method === 'GET' && oneMember) {
        const m = roster.find(x => x.user.id === oneMember[1]);
        return m ? Response.json(m) : Response.json({message: 'Unknown Member'}, {status: 404});
      }
      if (method === 'POST' && p === `/guilds/${guildId}/channels`) return Response.json({id: tradeChannel, type: 0});
      if (method === 'POST' && /^\/channels\/\d+\/messages$/.test(p)) return Response.json({id: String(++messageSeq)});
      if (method === 'PATCH' && /^\/channels\/\d+\/messages\/\d+$/.test(p)) return Response.json({id: 'x'});
      if (method === 'PUT' && /^\/channels\/\d+\/permissions\/\d+$/.test(p)) return new Response(null, {status: 204});
      if (method === 'GET' && /^\/channels\/\d+\/messages$/.test(p)) return Response.json([]);
      if (method === 'DELETE' && /^\/channels\/\d+$/.test(p)) return Response.json({id: p.split('/')[2]});
      if (method === 'PATCH' && /^\/channels\/\d+$/.test(p)) return Response.json({id: p.split('/')[2]});
      if (method === 'PUT' && p === `/applications/${botId}/commands`) return Response.json([]);
      if (method === 'PATCH' && p.startsWith('/webhooks/')) return Response.json({id: 'orig'});
      return Response.json({message: 'Missing Access'}, {status: 403});
    }
  });
  t.after(() => mf.dispose());
  return {mf, calls, links, accepted, created, privateKey, db: await mf.getD1Database('DB')};
}

async function request(mf, path, token, method = 'GET', body) {
  const response = await mf.dispatchFetch('https://worker.example' + path, {
    method,
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  return {status: response.status, body: await response.json()};
}

let interactionSeq = 0;
async function interact(env, payload) {
  const token = 'itok' + (++interactionSeq);
  const full = {id: String(interactionSeq), application_id: botId, token, guild_id: guildId, ...payload};
  const body = JSON.stringify(full);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signMessage(null, Buffer.from(timestamp + body), env.privateKey).toString('hex');
  const response = await env.mf.dispatchFetch('https://worker.example/interactions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp},
    body
  });
  const result = await response.json();
  if (result.type === 5 || result.type === 6) {
    // Deferred: wait for the background PATCH to @original.
    const patched = await eventually(() => env.calls.find(c => c.method === 'PATCH' && c.path.includes(`/webhooks/${botId}/${token}/`)), 4000);
    assert.ok(patched, 'deferred interaction was never completed: ' + JSON.stringify(payload.data));
    return {type: 'deferred', content: patched.body.content, data: patched.body};
  }
  return {type: result.type, content: result.data?.content, data: result.data};
}

function member(userId, roles = []) {
  return {user: {id: userId, username: 'user' + userId.slice(-3)}, roles, joined_at: oldJoin, permissions: '0'};
}
function button(userId, customId, extra = {}) {
  return {type: 3, channel_id: tradeChannel, member: member(userId, extra.roles), data: {custom_id: customId, component_type: 2}, ...extra.payload};
}
function submit(userId, customId, values) {
  return {
    type: 5, channel_id: tradeChannel, member: member(userId),
    data: {custom_id: customId, components: Object.entries(values).map(([k, v]) => ({type: 1, components: [{type: 4, custom_id: k, value: v}]}))}
  };
}

async function eventually(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  return fn();
}

async function trade(env) {
  return env.db.prepare('SELECT * FROM mediation_trades ORDER BY id DESC LIMIT 1').first();
}

async function setup(t) {
  const env = await runtime(t);
  const login = await request(env.mf, '/api/login', null, 'POST', {password: 'local-test-password'});
  assert.equal(login.status, 200);
  const token = login.body.token;
  const saved = await request(env.mf, `/api/guilds/${guildId}/mediation/settings`, token, 'PUT', {
    feeAmount: 200, staffRoleIds: [staffRole], staffChannelId: staffChannel, categoryId,
    resultChannelId: resultChannel, logChannelId: logChannel, blacklistRoleIds: [blacklistRole],
    minAmount: 100, maxAmount: 100000, autoAgreeHours: 24, cancelDeleteSeconds: 30, closeDeleteMinutes: 10,
    panelChannelId: '999999999999999999'
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.panelChannelId, null, 'panel location only changes through the panel API');
  return {...env, token};
}

async function loginPayPay(env) {
  const start = await request(env.mf, `/api/guilds/${guildId}/mediation/paypay/login/start`, env.token, 'POST', {phone: '09000000000', password: 'pw'});
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const verify = await request(env.mf, `/api/guilds/${guildId}/mediation/paypay/login/verify`, env.token, 'POST', {challengeId: start.body.challengeId, otp: '1234'});
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
}

async function openTrade(env) {
  const start = await interact(env, {type: 3, channel_id: panelChannel, member: member(userA), data: {custom_id: 'md:start', component_type: 2}});
  assert.equal(start.type, 4);
  assert.equal(start.data.components[0].components[0].custom_id, 'md:partner');
  const partner = await interact(env, {
    type: 3, channel_id: panelChannel, member: member(userA),
    data: {custom_id: 'md:partner', component_type: 5, values: [userB], resolved: {users: {[userB]: {id: userB, username: 'b'}}, members: {[userB]: {roles: [], joined_at: oldJoin}}}}
  });
  assert.match(partner.content, /取引チャンネルを作成しました/);
  const t = await trade(env);
  assert.equal(t.channel_id, tradeChannel);
  return t;
}

test('full mediation trade: fee, amount, roles, escrow with passcode, agreement, payout, cleanup', async t => {
  const env = await setup(t);
  await loginPayPay(env);

  const panel = await request(env.mf, `/api/guilds/${guildId}/mediation/panel`, env.token, 'POST', {channelId: panelChannel});
  assert.equal(panel.status, 200, JSON.stringify(panel.body));
  const panelMessage = env.calls.find(c => c.method === 'POST' && c.path === `/api/v10/channels/${panelChannel}/messages`);
  assert.equal(panelMessage.body.components[0].components[0].custom_id, 'md:start');
  assert.ok(env.calls.some(c => c.method === 'PUT' && c.path.endsWith('/commands') && c.body.some(cmd => cmd.name === 'check')));

  const blocked = await interact(env, {type: 3, channel_id: panelChannel, member: member(userA, [blacklistRole]), data: {custom_id: 'md:start', component_type: 2}});
  assert.match(blocked.content, /利用できません/);

  const t0 = await openTrade(env);
  assert.equal(t0.status, 'FEE');
  const again = await interact(env, {
    type: 3, channel_id: panelChannel, member: member(userB),
    data: {custom_id: 'md:partner', component_type: 5, values: [userA], resolved: {users: {[userA]: {id: userA, username: 'a'}}, members: {[userA]: {roles: [], joined_at: oldJoin}}}}
  });
  assert.match(again.content, /すでに取引が進行中/);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM mediation_trades').first()).n, 1);
  assert.equal(t0.fee_total, 200);
  const createCall = env.calls.find(c => c.method === 'POST' && c.path === `/api/v10/guilds/${guildId}/channels`);
  assert.equal(createCall.body.parent_id, categoryId);
  assert.ok(createCall.body.permission_overwrites.some(o => o.id === staffRole));
  const id = t0.id;

  // ⓪ fee: A pays it all, B chooses "other"
  env.links.set('fee1', {amount: 200, status: 'PENDING'});
  const badHost = await interact(env, submit(userA, `md:feem:self:${id}`, {link: 'https://www.paypay.ne.jp/fee1', passcode: ''}));
  assert.match(badHost.content, /送金リンクではない/);
  const feeModal = await interact(env, button(userA, `md:fee:self:${id}`));
  assert.equal(feeModal.type, 9);
  await interact(env, submit(userA, `md:feem:self:${id}`, {link: payLink('fee1'), passcode: ''}));
  assert.equal(env.accepted.length, 0, 'fee must not be received before both choices match');
  await interact(env, button(userB, `md:fee:other:${id}`));
  assert.equal((await trade(env)).status, 'AMOUNT');
  assert.equal(env.links.get('fee1').status, 'COMPLETED');
  assert.equal((await trade(env)).fee_paid_a, 200);

  // ① amount
  const tooSmall = await interact(env, submit(userA, `md:amountm:${id}`, {amount: '50'}));
  assert.match(tooSmall.content, /以上/);
  await interact(env, submit(userA, `md:amountm:${id}`, {amount: '5,000円'}));
  await interact(env, submit(userB, `md:amountm:${id}`, {amount: '5000'}));
  assert.equal((await trade(env)).status, 'ROLE');

  // ② roles
  await interact(env, button(userA, `md:role:buyer:${id}`));
  await interact(env, button(userB, `md:role:seller:${id}`));
  let cur = await trade(env);
  assert.equal(cur.status, 'PAYMENT');
  assert.equal(cur.buyer_id, userA);

  // ③ payment link with passcode: missing passcode is bounced, correct passcode is received
  env.links.set('pay1', {amount: 5000, status: 'PENDING', passcode: '1234'});
  const notBuyer = await interact(env, button(userB, `md:pay:${id}`));
  assert.match(notBuyer.content, /買い手のみ/);
  const missing = await interact(env, submit(userA, `md:paym:${id}`, {link: payLink('pay1'), passcode: ''}));
  assert.match(missing.content, /パスコード/);
  assert.equal((await trade(env)).status, 'PAYMENT');
  const wrongPass = await interact(env, submit(userA, `md:paym:${id}`, {link: payLink('pay1'), passcode: '9999'}));
  assert.match(wrongPass.content, /パスコードが間違っている/);
  assert.equal((await trade(env)).status, 'PAYMENT', 'a wrong passcode goes back to the buyer, not to staff');
  assert.equal(env.links.get('pay1').status, 'PENDING');
  assert.ok(!env.calls.some(c => c.method === 'POST' && c.path === `/api/v10/channels/${staffChannel}/messages`));
  await interact(env, submit(userA, `md:paym:${id}`, {link: payLink('pay1'), passcode: '1234'}));
  cur = await trade(env);
  assert.equal(cur.status, 'TRADING');
  assert.equal(cur.paylink_enc, null, 'escrow link is dropped once received');
  assert.equal(env.accepted.at(-1).passcode, '1234');
  assert.ok(env.calls.some(c => c.method === 'PUT' && c.path === `/api/v10/channels/${tradeChannel}/permissions/${userA}` && c.body.allow === String(1024n|65536n|2048n|32768n)));

  // ④ completion
  // The buyer completing directly gets a confirmation; cancelling it changes nothing.
  const direct = await interact(env, {type: 2, channel_id: tradeChannel, member: member(userA), data: {name: 'complete'}});
  assert.equal(direct.type, 4);
  assert.match(direct.content, /取引は終了し、相手（売り手 <@\d+> さん）には代金 \*\*¥5,000\*\* が支払われます。よろしいですか？/);
  assert.equal((await interact(env, button(userA, `md:opcancel:${id}`))).type, 7);
  assert.equal((await trade(env)).status, 'TRADING');

  // The seller can request completion; nothing is paid until the buyer agrees and confirms.
  const sellerRequest = await interact(env, button(userB, `md:complete:${id}`));
  assert.match(sellerRequest.content, /依頼しました/);
  assert.equal((await trade(env)).status, 'COMPLETE_PENDING');
  const requestMsg = env.calls.filter(c => c.method === 'POST' && c.path === `/api/v10/channels/${tradeChannel}/messages`).at(-1);
  assert.deepEqual(requestMsg.body.components[0].components.map(b => b.custom_id), [`md:agree:${id}`, `md:continue:${id}`, `md:report:${id}`]);
  assert.match((await interact(env, button(userB, `md:complete:${id}`))).content, /すでに取引完了を依頼/);
  assert.match((await interact(env, button(userB, `md:agree:${id}`))).content, /買い手が行います/);
  assert.match((await interact(env, button(userB, `md:continue:${id}`))).content, /依頼した本人/);
  assert.match((await interact(env, button(userB, `md:completeok:${id}`))).content, /買い手だけ/);
  assert.equal((await trade(env)).status, 'COMPLETE_PENDING');
  assert.equal(env.created.length, 0, 'a seller request alone never pays');

  // The buyer's "同意する" opens the confirmation; only the second tap pays.
  const agreeAsk = await interact(env, button(userA, `md:agree:${id}`));
  assert.equal(agreeAsk.type, 4, 'agree is answered immediately with a confirmation');
  assert.match(agreeAsk.content, /取引は終了し、相手.*が支払われます。よろしいですか？/);
  assert.deepEqual(agreeAsk.data.components[0].components.map(b => b.custom_id), [`md:completeok:${id}`, `md:opcancel:${id}`]);
  assert.equal((await trade(env)).status, 'COMPLETE_PENDING');
  assert.equal(env.created.length, 0);
  const done = await interact(env, button(userA, `md:completeok:${id}`));
  assert.match(done.content, /終了しました/);
  assert.deepEqual(done.data.components, [], 'the confirmation buttons are removed');
  const doubleTap = await interact(env, button(userA, `md:completeok:${id}`));
  assert.match(doubleTap.content, /すでに処理/);
  cur = await trade(env);
  assert.equal(cur.decision, '両者合意');
  assert.equal(cur.status, 'PAID');
  assert.equal(cur.payout_target, userB);
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].amount, 5000);
  const stats = await env.db.prepare('SELECT * FROM mediation_stats WHERE guild_id=? ORDER BY user_id').bind(guildId).all();
  assert.deepEqual(stats.results.map(r => [r.user_id, r.buyer_count, r.seller_count]), [[userA, 1, 0], [userB, 0, 1]]);
  assert.ok(env.calls.some(c => c.method === 'POST' && c.path === `/api/v10/channels/${resultChannel}/messages`));

  // ⑤ pickup: only the seller sees the link
  const wrong = await interact(env, button(userA, `md:pickup:${id}`));
  assert.match(wrong.content, /受取人ではありません/);
  const pickup = await interact(env, button(userB, `md:pickup:${id}`));
  assert.match(pickup.content, /payout1/);
  cur = await trade(env);
  assert.equal(cur.status, 'CLOSED');
  assert.ok(cur.delete_at > Date.now());

  // /check: search the whole server, not just people who can see this channel
  const auto = q => interact(env, {type: 4, channel_id: tradeChannel, member: member(userA), data: {name: 'check', options: [{name: 'member', type: 3, value: q, focused: true}]}});
  const byName = await auto('car');
  assert.equal(byName.type, 8);
  assert.deepEqual(byName.data.choices.map(c => c.value), ['323456789012345099'], 'a member outside the trade channel can be found');
  const empty = await auto('');
  assert.deepEqual(empty.data.choices.slice(0, 2).map(c => c.value).sort(), [userA, userB].sort(), 'members with trade records come first');
  assert.match(empty.data.choices.find(c => c.value === userB).name, /ボブ \(@bob\) ― 買い手0件 \/ 売り手1件/);
  assert.ok(!empty.data.choices.some(c => c.value === '323456789012345098'), 'bots are not offered');
  const check = await interact(env, {type: 2, channel_id: panelChannel, member: member(userA), data: {name: 'check', options: [{name: 'member', type: 3, value: userB}]}});
  assert.equal(check.data.embeds[0].fields[1].value, '1 件');
  assert.match(check.data.embeds[0].title, /ボブ/);
  const typed = await interact(env, {type: 2, channel_id: panelChannel, member: member(userA), data: {name: 'check', options: [{name: 'member', type: 3, value: 'bob'}]}});
  assert.equal(typed.data.embeds[0].fields[1].value, '1 件', 'a typed name without picking a choice still resolves');
  const notFound = await interact(env, {type: 2, channel_id: panelChannel, member: member(userA), data: {name: 'check', options: [{name: 'member', type: 3, value: 'nobody-here'}]}});
  assert.match(notFound.content, /見つかりませんでした/);

  // cleanup by cron: transcript to the log channel, channel deletion, result channel rename
  await env.db.prepare('UPDATE mediation_trades SET delete_at=? WHERE id=?').bind(Date.now() - 1000, id).run();
  const worker = await env.mf.getWorker();
  assert.equal((await worker.scheduled({cron: '* * * * *'})).outcome, 'ok');
  await eventually(async () => (await trade(env)).channel_deleted === 1);
  assert.equal((await trade(env)).transcript_saved, 1);
  const logUpload = env.calls.find(c => c.method === 'POST' && c.path === `/api/v10/channels/${logChannel}/messages`);
  assert.ok(logUpload);
  assert.match(logUpload.contentType, /^multipart\/form-data/, 'transcript must be uploaded as multipart');
  assert.ok(env.calls.some(c => c.method === 'DELETE' && c.path === `/api/v10/channels/${tradeChannel}`));
  const rename = env.calls.find(c => c.method === 'PATCH' && c.path === `/api/v10/channels/${resultChannel}`);
  assert.equal(rename?.body?.name, '仲介実績ー実績1件');

  const overview = await request(env.mf, `/api/guilds/${guildId}/mediation`, env.token);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.summary.completed, 1);
  assert.equal(overview.body.summary.feeCollected, 200);
  assert.equal(overview.body.paypay.registered, true);
});

test('PayPay failures fall back to staff, and disputes are settled by staff only', async t => {
  const env = await setup(t);
  await request(env.mf, `/api/guilds/${guildId}/mediation/settings`, env.token, 'PUT', {feeAmount: 0});
  const t0 = await openTrade(env);
  assert.equal(t0.status, 'AMOUNT', 'free trades skip the fee step');
  const id = t0.id;
  await interact(env, submit(userA, `md:amountm:${id}`, {amount: '1000'}));
  await interact(env, submit(userB, `md:amountm:${id}`, {amount: '1000'}));
  await interact(env, button(userA, `md:role:seller:${id}`));
  await interact(env, button(userB, `md:role:buyer:${id}`));

  // No operator PayPay login → receiving fails → staff confirmation
  env.links.set('pay2', {amount: 1000, status: 'PENDING'});
  await interact(env, submit(userB, `md:paym:${id}`, {link: payLink('pay2'), passcode: ''}));
  assert.equal((await trade(env)).status, 'CONFIRMING');
  const staffNotice = env.calls.find(c => c.method === 'POST' && c.path === `/api/v10/channels/${staffChannel}/messages`);
  assert.deepEqual(staffNotice.body.components[0].components.map(b => b.custom_id), [`md:staff:confirm:${id}`, `md:staff:reject:${id}`]);

  const notStaff = await interact(env, {...button(userA, `md:staff:confirm:${id}`), channel_id: staffChannel, message: {id: '1', embeds: [{title: 'x'}]}});
  assert.match(notStaff.content, /スタッフのみ/);
  await interact(env, {...button(staffUser, `md:staff:confirm:${id}`, {roles: [staffRole]}), channel_id: staffChannel, message: {id: '1', embeds: [{title: 'x'}]}});
  assert.equal((await trade(env)).status, 'TRADING');

  // Report → dispute → staff refunds the buyer; payout link creation fails (no login) → manual "done"
  const select = await interact(env, button(userA, `md:report:${id}`));
  assert.equal(select.data.components[0].components[0].custom_id, `md:rtype:${id}`);
  await interact(env, submit(userA, `md:reportm:0:${id}`, {detail: '商品が違う'}));
  assert.equal((await trade(env)).status, 'DISPUTE');
  const complete = await interact(env, button(userB, `md:complete:${id}`));
  assert.match(complete.content, /できません/);

  // The staff button only asks for confirmation; nothing moves until it is confirmed.
  const confirm = await interact(env, {...button(staffUser, `md:staff:refund:${id}`, {roles: [staffRole]}), channel_id: staffChannel, message: {id: '222222222222222222', embeds: [{title: 'x'}]}});
  assert.match(confirm.content, new RegExp(`<@${userB}>.*¥1,000.*返金します。よろしいですか`));
  assert.equal((await trade(env)).status, 'DISPUTE');
  const okId = confirm.data.components[0].components[0].custom_id;
  assert.equal(okId, `md:payok:refund:222222222222222222:${id}`);
  const notStaffOk = await interact(env, {...button(userB, okId), channel_id: staffChannel});
  assert.match(notStaffOk.content, /スタッフのみ/);
  await interact(env, {...button(staffUser, okId, {roles: [staffRole]}), channel_id: staffChannel});
  let cur = await trade(env);
  assert.equal(cur.status, 'PAYOUT');
  assert.equal(cur.payout_target, userB);
  assert.equal(cur.decision.startsWith('スタッフ判断→買い手へ返金'), true);
  await interact(env, {...button(staffUser, `md:staff:done:${id}`, {roles: [staffRole]}), channel_id: staffChannel, message: {id: '3', embeds: [{title: 'x'}]}});
  cur = await trade(env);
  assert.equal(cur.status, 'CLOSED');
  const stats = await env.db.prepare('SELECT COUNT(*) AS n FROM mediation_stats').first();
  assert.equal(stats.n, 0, 'staff-settled trades do not count as records');
});

test('mismatched amounts cancel; a seller reports a silent buyer and staff pays with /payment', async t => {
  const env = await setup(t);
  await request(env.mf, `/api/guilds/${guildId}/mediation/settings`, env.token, 'PUT', {feeAmount: 0});
  const first = await openTrade(env);
  await interact(env, submit(userA, `md:amountm:${first.id}`, {amount: '1000'}));
  await interact(env, submit(userB, `md:amountm:${first.id}`, {amount: '2000'}));
  assert.equal((await trade(env)).status, 'CANCELLED');

  await loginPayPay(env);
  const second = await openTrade(env);
  const id = second.id;
  await interact(env, submit(userA, `md:amountm:${id}`, {amount: '3000'}));
  await interact(env, submit(userB, `md:amountm:${id}`, {amount: '3000'}));
  await interact(env, button(userA, `md:role:buyer:${id}`));
  await interact(env, button(userB, `md:role:seller:${id}`));
  env.links.set('pay3', {amount: 3000, status: 'PENDING'});
  await interact(env, submit(userA, `md:paym:${id}`, {link: payLink('pay3'), passcode: ''}));
  assert.equal((await trade(env)).status, 'TRADING');

  // Nothing pays out on its own any more, however long it waits.
  await env.db.prepare('UPDATE mediation_trades SET complete_requested_at=?, complete_requester=? WHERE id=?').bind(Date.now() - 48 * 3600_000, userB, id).run();
  const worker = await env.mf.getWorker();
  assert.equal((await worker.scheduled({cron: '* * * * *'})).outcome, 'ok');
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await trade(env)).status, 'TRADING');
  assert.equal(env.created.length, 0);

  // The seller reports that the buyer will not complete.
  const report = await interact(env, button(userB, `md:report:${id}`));
  const options = report.data.components[0].components[0].options;
  const idx = options.findIndex(o => o.label === '買い手が/completeを押さない');
  assert.ok(idx >= 0, 'report type exists');
  await interact(env, submit(userB, `md:reportm:${idx}:${id}`, {detail: '渡しました'}));
  let cur = await trade(env);
  assert.equal(cur.status, 'DISPUTE');
  assert.match(cur.report_reason, /買い手が\/completeを押さない/);

  // /payment is staff only, asks for confirmation, then pays.
  const payment = action => ({type: 2, channel_id: tradeChannel, data: {name: 'payment', options: [{name: 'action', type: 3, value: action}]}});
  const byMember = await interact(env, {...payment('payseller'), member: member(userB)});
  assert.match(byMember.content, /スタッフだけ/);
  const ask = await interact(env, {...payment('payseller'), member: member(staffUser, [staffRole])});
  assert.equal(ask.type, 4);
  assert.match(ask.content, new RegExp(`売り手 <@${userB}> さんに \\*\\*¥3,000\\*\\* を支払います。よろしいですか`));
  assert.equal((await trade(env)).status, 'DISPUTE');
  const ok = ask.data.components[0].components[0].custom_id;
  assert.equal(ok, `md:payok:payseller:0:${id}`);
  await interact(env, {...button(staffUser, ok, {roles: [staffRole]})});
  cur = await trade(env);
  assert.equal(cur.status, 'PAID');
  assert.equal(cur.payout_target, userB);
  assert.match(cur.decision, /^スタッフ判断→売り手へ支払い/);
  assert.equal(env.created.at(-1).amount, 3000);
  const twice = await interact(env, {...button(staffUser, ok, {roles: [staffRole]})});
  assert.match(twice.content, /すでに処理/);
  assert.equal(env.created.length, 1, 'no second payout');
  const notInTrade = await interact(env, {...payment('refund'), channel_id: panelChannel, member: member(staffUser, [staffRole])});
  assert.match(notInTrade.content, /取引のプライベートチャンネルの中でだけ/);
});

test('trades stuck mid-way alert staff once', async t => {
  const env = await setup(t);
  await request(env.mf, `/api/guilds/${guildId}/mediation/settings`, env.token, 'PUT', {feeAmount: 0});
  const t0 = await openTrade(env);
  await env.db.prepare("UPDATE mediation_trades SET status='CONFIRMING',amount=1000,buyer_id=?,seller_id=?,updated_at=? WHERE id=?").bind(userA, userB, Date.now() - 20 * 60_000, t0.id).run();
  const worker = await env.mf.getWorker();
  const staffPosts = () => env.calls.filter(c => c.method === 'POST' && c.path === `/api/v10/channels/${staffChannel}/messages`);
  assert.equal((await worker.scheduled({cron: '* * * * *'})).outcome, 'ok');
  await eventually(() => staffPosts().length === 1);
  assert.deepEqual(staffPosts()[0].body.components[0].components.map(b => b.custom_id), [`md:staff:confirm:${t0.id}`, `md:staff:reject:${t0.id}`]);
  assert.equal((await worker.scheduled({cron: '* * * * *'})).outcome, 'ok');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(staffPosts().length, 1, 'alert is sent only once per stuck status');
});

test('split fee keeps the received share when the other member mistypes, and repeated wrong passcodes go to staff', async t => {
  const env = await setup(t);
  await loginPayPay(env);
  const t0 = await openTrade(env);
  const id = t0.id;
  env.links.set('feeA', {amount: 100, status: 'PENDING'});
  env.links.set('feeB', {amount: 100, status: 'PENDING', passcode: '4321'});
  await interact(env, submit(userA, `md:feem:split:${id}`, {link: payLink('feeA'), passcode: ''}));
  await interact(env, submit(userB, `md:feem:split:${id}`, {link: payLink('feeB'), passcode: '0000'}));
  let cur = await trade(env);
  assert.equal(cur.status, 'FEE');
  assert.equal(cur.fee_paid_a, 100, 'A\'s share stays received');
  assert.equal(cur.fee_choice_b, null);
  assert.equal(env.links.get('feeB').status, 'PENDING');
  const aAgain = await interact(env, button(userA, `md:fee:self:${id}`));
  assert.match(aAgain.content, /受け取り済み/);
  const bOther = await interact(env, button(userB, `md:fee:other:${id}`));
  assert.match(bOther.content, /割り勘/);
  await interact(env, submit(userB, `md:feem:split:${id}`, {link: payLink('feeB'), passcode: '4321'}));
  cur = await trade(env);
  assert.equal(cur.status, 'AMOUNT');
  assert.equal(cur.fee_paid_b, 100);
  assert.equal(cur.receive_failures, 0);
  assert.equal(env.accepted.filter(a => a.verificationCode === 'feeA').length, 1, 'A\'s link is received only once');

  await interact(env, submit(userA, `md:amountm:${id}`, {amount: '2000'}));
  await interact(env, submit(userB, `md:amountm:${id}`, {amount: '2000'}));
  await interact(env, button(userA, `md:role:buyer:${id}`));
  await interact(env, button(userB, `md:role:seller:${id}`));
  env.links.set('pay4', {amount: 2000, status: 'PENDING', passcode: '1111'});
  for (let i = 0; i < 3; i++) {
    const r = await interact(env, submit(userA, `md:paym:${id}`, {link: payLink('pay4'), passcode: '2222'}));
    assert.match(r.content, /パスコード/);
    assert.equal((await trade(env)).status, 'PAYMENT');
  }
  await interact(env, submit(userA, `md:paym:${id}`, {link: payLink('pay4'), passcode: '2222'}));
  assert.equal((await trade(env)).status, 'CONFIRMING', 'after 3 retries staff takes over');
  assert.ok(env.calls.some(c => c.method === 'POST' && c.path === `/api/v10/channels/${staffChannel}/messages`));
});

test('commands only run where they belong: trade commands in trade channels, /check in its channel', async t => {
  const env = await setup(t);
  const saved = await request(env.mf, `/api/guilds/${guildId}/mediation/settings`, env.token, 'PUT', {checkChannelIds: [logChannel]});
  assert.deepEqual(saved.body.settings.checkChannelIds, [logChannel]);
  const slash = (userId, channel, name, options = [], roles = []) =>
    interact(env, {type: 2, channel_id: channel, member: member(userId, roles), data: {name, options}});

  for (const name of ['complete', 'report']) {
    const r = await slash(userA, panelChannel, name);
    assert.match(r.content, /取引のプライベートチャンネルの中でだけ/, name);
  }
  const pay = await slash(staffUser, panelChannel, 'payment', [{name: 'action', type: 3, value: 'refund'}], [staffRole]);
  assert.match(pay.content, /取引のプライベートチャンネルの中でだけ/);

  const memberOpt = [{name: 'member', type: 3, value: userB}];
  const elsewhere = await slash(userA, panelChannel, 'check', memberOpt);
  assert.match(elsewhere.content, new RegExp(`<#${logChannel}> で使ってください`));
  const auto = await interact(env, {type: 4, channel_id: panelChannel, member: member(userA), data: {name: 'check', options: [{name: 'member', type: 3, value: 'b', focused: true}]}});
  assert.match(auto.data.choices[0].name, /このチャンネルでは使えません/);
  const here = await slash(userA, logChannel, 'check', memberOpt);
  assert.ok(here.data.embeds?.[0], 'works in the configured channel');
  const staffAnywhere = await slash(staffUser, panelChannel, 'check', memberOpt, [staffRole]);
  assert.ok(staffAnywhere.data.embeds?.[0], 'staff can use it anywhere');
});
