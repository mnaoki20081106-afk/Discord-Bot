import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Miniflare} from 'miniflare';

const source='100000000000000001', target='100000000000000002', bot='100000000000000003';
const roleA='200000000000000001',roleB='200000000000000002';
const category='300000000000000001',channelA='300000000000000002',channelB='300000000000000003';
const member='400000000000000001';
async function fixture(t){
  const state={calls:[],failRoles:false,cancelOnRole:null,next:0,autoRules:null,failAutoMod:false};
  const roles={
    [source]:[{id:source,name:'@everyone',permissions:'0',position:0},
      {id:roleA,name:'Same name',permissions:'1024',position:1},
      {id:roleB,name:'Same name',permissions:'2048',position:2}],
    [target]:[{id:target,name:'@everyone',permissions:'0',position:0}]
  };
  const channels={
    [source]:[{id:category,name:'Category',type:4,position:0,permission_overwrites:[]},
      {id:channelA,name:'same',type:0,parent_id:category,position:1,permission_overwrites:[{id:roleA,type:0,allow:'1024',deny:'0'}]},
      {id:channelB,name:'same',type:0,parent_id:category,position:2,permission_overwrites:[{id:roleB,type:0,allow:'2048',deny:'0'}]}],
    [target]:[]
  };
  let db;
  const mf=new Miniflare({modules:true,scriptPath:'.test-worker/index.js',compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{
    DISCORD_BOT_TOKEN:'test-only',DISCORD_APPLICATION_ID:bot,DASHBOARD_PASSWORD:'test-only',
    SESSION_ENCRYPTION_KEY:'audit-test-only-encryption-key-32-characters',WEB_ORIGIN:'https://dashboard.example',WEB_PUBLIC_URL:'https://dashboard.example/',PAYPAY_ENV:'sandbox'
  },outboundService:async req=>{
    const u=new URL(req.url),p=u.pathname.replace('/api/v10',''),method=req.method;
    assert.equal(u.hostname,'discord.com');
    const body=method==='GET'?null:await req.clone().json().catch(()=>null);
    state.calls.push({p,method,body});
    if(p==='/users/@me') return Response.json({id:bot,username:'Audit bot'});
    if(p==='/users/@me/guilds') return Response.json([{id:source,name:'Source'},{id:target,name:'Target'}]);
    const g=p.match(/^\/guilds\/(\d+)(.*)$/);
    if(g){
      const [,id,path]=g;
      if(!roles[id]) return Response.json({message:'Unknown Guild'},{status:404});
      if(!path) return Response.json({id,name:id===source?'Source':'Target',...body});
      if(path==='/roles'){
        if(method==='GET') return Response.json(roles[id]);
        if(method==='PATCH') return Response.json(roles[id]);
        if(state.failRoles) return Response.json({message:'Missing Permissions'},{status:403});
        const row={id:String(500000000000000000n+BigInt(++state.next)),...body,position:state.next};roles[id].push(row);
        if(state.cancelOnRole) await db.prepare("UPDATE guild_restore_jobs SET status='cancelled' WHERE id=?").bind(state.cancelOnRole).run();
        return Response.json(row);
      }
      if(path.startsWith('/roles/')) return Response.json({id:path.split('/').at(-1),...body});
      if(path==='/channels'){
        if(method==='GET'||method==='PATCH') return Response.json(channels[id]);
        const row={id:String(600000000000000000n+BigInt(++state.next)),...body};channels[id].push(row);return Response.json(row);
      }
      if(path==='/members') return Response.json([{user:{id:member,username:'Existing'},roles:[roleA,roleB],nick:'Saved nick'}]);
      if(path===`/members/${member}`) return Response.json({roles:[]});
      if(path.startsWith(`/members/${member}/roles/`)) return new Response(null,{status:204});
      if(path===`/members/${bot}`) return Response.json({roles:[]});
      if(['/emojis','/stickers','/bans'].includes(path)) return Response.json([]);
      if(path==='/welcome-screen') return Response.json({description:'Welcome',welcome_channels:[]});
      if(path==='/widget') return Response.json({enabled:false,channel_id:null});
      if(path.startsWith('/auto-moderation/rules')){
        if(state.autoRules===null||state.failAutoMod) return Response.json({message:'Missing Permissions'},{status:403});
        if(method==='GET') return Response.json(state.autoRules);
        return method==='DELETE'?new Response(null,{status:204}):Response.json({id:'automod',...body});
      }
    }
    if(/^\/channels\/\d+\/messages$/.test(p)) return Response.json([]);
    if(/^\/channels\/\d+$/.test(p)){
      const channelId=p.split('/').at(-1);
      const guildEntry=Object.entries(channels).find(([,rows])=>rows.some(x=>x.id===channelId));
      if(!guildEntry) return Response.json({message:'Unknown Channel'},{status:404});
      const row=guildEntry[1].find(x=>x.id===channelId);
      if(method==='GET') return Response.json({...row,guild_id:guildEntry[0]});
      if(method==='PATCH'){Object.assign(row,body);return Response.json(row);}
    }
    if(p.endsWith('/audit-logs')) return Response.json({audit_log_entries:[]});
    return Response.json({message:'Unexpected fixture request: '+method+' '+p},{status:404});
  }});
  t.after(()=>mf.dispose()); db=await mf.getD1Database('DB');
  const login=await mf.dispatchFetch('https://worker.test/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-only'})});
  const {token}=await login.json();assert.ok(token);
  const request=async(path,method='GET',body)=>{
    const res=await mf.dispatchFetch('https://worker.test'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,body:await res.json()};
  };
  const snapshot=async()=>{const r=await request(`/api/guilds/${source}/backups`,'POST',{label:'Audit'});assert.equal(r.status,201,JSON.stringify(r));return r.body;};
  const start=async(backup,guild=target)=>{const r=await request(`/api/backups/${backup.id}/restore`,'POST',{targetGuildId:guild});assert.equal(r.status,202,JSON.stringify(r));return r.body;};
  const tick=async()=>{await (await mf.getWorker()).scheduled({cron:'* * * * *'});};
  const finish=async(job)=>{for(let n=0;n<22;n++){await tick();job=(await request('/api/restore-jobs/'+job.id)).body;if(['completed','failed','cancelled'].includes(job.status)) return job;}assert.fail(JSON.stringify(job));};
  return {mf,db,request,snapshot,start,tick,finish,state,roles,channels};
}

test('restore preserves duplicate names, permission mappings, existing member roles, and is repeatable',async t=>{
  const f=await fixture(t),backup=await f.snapshot();
  const preview=await f.request(`/api/backups/${backup.id}/restore/preview`,'POST',{targetGuildId:target});
  assert.equal(preview.body.counts.missingRoles,2);assert.equal(preview.body.counts.missingChannels,3);
  let job=await f.finish(await f.start(backup));
  assert.equal(job.status,'completed',JSON.stringify(job));
  assert.equal(f.roles[target].filter(x=>x.name==='Same name').length,2);
  assert.equal(f.channels[target].filter(x=>x.name==='same').length,2);
  const permissions=f.channels[target].filter(x=>x.type===0).map(x=>x.permission_overwrites[0].id);
  assert.equal(new Set(permissions).size,2);
  assert.equal(job.result.membersAlreadyPresent,1);
  assert.equal(job.result.membersSkippedNoConsent,0);
  assert.equal(f.state.calls.filter(x=>x.method==='PUT'&&x.p.includes(`/members/${member}/roles/`)).length,2);
  job=await f.finish(await f.start(backup));
  assert.equal(job.status,'completed');
  assert.equal(f.roles[target].length,3);
  assert.equal(f.channels[target].length,3);
});

test('permanent Discord failures stop instead of queuing forever',async t=>{
  const f=await fixture(t),backup=await f.snapshot();f.state.failRoles=true;
  const job=await f.finish(await f.start(backup));assert.equal(job.status,'failed');assert.match(job.error,/403/);
});

test('cancellation during a role batch stays cancelled and stops further role creation',async t=>{
  const f=await fixture(t),backup=await f.snapshot(),job=await f.start(backup);
  f.state.cancelOnRole=job.id;
  const ended=await f.finish(job);assert.equal(ended.status,'cancelled');assert.equal(f.roles[target].length,2);
});

test('active backups cannot be deleted and overlapping ticks honor the lease',async t=>{
  const f=await fixture(t),backup=await f.snapshot(),job=await f.start(backup);
  const deletion=await f.request('/api/backups/'+backup.id,'DELETE');assert.equal(deletion.status,409);
  await f.db.prepare('INSERT INTO backup_sweep_lease VALUES (1,?,?)').bind('other-worker',Date.now()+60000).run();
  await f.tick();
  assert.equal((await f.request('/api/restore-jobs/'+job.id)).body.phase,'preflight');
  await f.request('/api/restore-jobs/'+job.id,'DELETE');
  assert.equal((await f.request('/api/backups/'+backup.id,'DELETE')).status,200);
});

test('same-server restore does not duplicate available stock or resurrect sold stock',async t=>{
  const f=await fixture(t);await f.request(`/api/guilds/${source}/vending`);
  await f.db.prepare('INSERT INTO vending_machines(id,guild_id,owner_id,name,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind('vm',source,'test','Shop').run();
  await f.db.prepare('INSERT INTO vending_products(id,vending_machine_id,name,created_at,updated_at) VALUES (?,?,?,1,1)').bind('product','vm','Item').run();
  await f.db.batch(['stock-available','stock-sold-later'].map(id=>f.db.prepare("INSERT INTO vending_stock(id,product_id,content,state,created_at) VALUES (?,?,'CODE','available',1)").bind(id,'product')));
  const backup=await f.snapshot();
  await f.db.prepare("UPDATE vending_stock SET state='sold' WHERE id='stock-sold-later'").run();
  const job=await f.finish(await f.start(backup,source));assert.equal(job.status,'completed',JSON.stringify(job));
  const rows=(await f.db.prepare('SELECT id,state FROM vending_stock').all()).results;
  assert.equal(rows.length,2);assert.equal(rows.find(x=>x.id==='stock-sold-later').state,'sold');
});

test('invalid settings are rejected, persisted settings roundtrip, and Discord apply failure is visible',async t=>{
  const f=await fixture(t);
  for(const body of [{mentionLimit:'bad'},{antiSpam:'false'},{trustedUserIds:'123'},{trustedRoleIds:['bad']},{minAccountAgeDays:null}]){
    const r=await f.request(`/api/guilds/${source}/settings`,'PUT',body);assert.equal(r.status,400,JSON.stringify(r));
  }
  const payload={minAccountAgeDays:31,mentionLimit:7,trustedUserIds:[member],trustedRoleIds:[roleA,roleB],securityEnabled:true};
  const saved=await f.request(`/api/guilds/${source}/settings`,'PUT',payload);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.ok(saved.body.applyWarnings.length);
  const fresh=await f.request(`/api/guilds/${source}/settings`);
  for(const [key,value] of Object.entries(payload)) assert.deepEqual(fresh.body[key],value);
  assert.equal(fresh.body.applyWarnings,undefined);
});

test('backup chunk failure rolls back the record instead of exposing an incomplete archive',async t=>{
 const f=await fixture(t);await f.request('/api/backups');
 await f.db.prepare("CREATE TRIGGER reject_backup_chunk BEFORE INSERT ON guild_backup_chunks BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END").run();
 const res=await f.request(`/api/guilds/${source}/backups`,'POST',{label:'Must rollback'});
 assert.equal(res.status,500);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM guild_backups').first()).n,0);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM guild_backup_chunks').first()).n,0);
});

test('database read failures abort backup creation instead of silently saving empty products',async t=>{
 const f=await fixture(t);await f.snapshot();
 await f.db.prepare('DROP TABLE products').run();
 const res=await f.request(`/api/guilds/${source}/backups`,'POST',{label:'Incomplete'});
 assert.equal(res.status,500);
 assert.equal((await f.request('/api/backups')).body.length,1);
});

test('a second backup cannot silently substitute an active restore job',async t=>{
 const f=await fixture(t),first=await f.snapshot(),second=await f.snapshot();
 await f.start(first);
 const res=await f.request(`/api/backups/${second.id}/restore`,'POST',{targetGuildId:target});
 assert.equal(res.status,409);
});

test('vending achievements can be split across multiple rooms without duplicate machine routing',async t=>{
 const f=await fixture(t);
 await f.request(`/api/guilds/${source}/vending`);
 for(const [id,name] of [
  ['achievement-vm-a','Shop A'],
  ['achievement-vm-b','Shop B'],
  ['achievement-vm-c','Shop C']
 ]){
  await f.db.prepare(
   'INSERT INTO vending_machines(id,guild_id,owner_id,name,created_at,updated_at) VALUES (?,?,?,?,1,1)'
  ).bind(id,source,'shared-dashboard',name).run();
 }
 const saved=await f.request(
  `/api/guilds/${source}/vending/achievement-room`,
  'PUT',
  {rooms:[
   {channelId:channelA,machineIds:['achievement-vm-a','achievement-vm-b']},
   {channelId:channelB,machineIds:['achievement-vm-c']}
  ]}
 );
 assert.equal(saved.status,200,JSON.stringify(saved));
 assert.equal(saved.body.rooms.length,2);
 assert.equal(saved.body.rooms[0].channel_id,channelA);
 assert.deepEqual(new Set(saved.body.rooms[0].machine_ids),new Set(['achievement-vm-a','achievement-vm-b']));
 assert.equal(saved.body.rooms[1].channel_id,channelB);
 assert.deepEqual(saved.body.rooms[1].machine_ids,['achievement-vm-c']);

 const fresh=await f.request(`/api/guilds/${source}/vending/achievement-room`);
 assert.equal(fresh.status,200,JSON.stringify(fresh));
 assert.equal(fresh.body.rooms.length,2);
 const rows=(await f.db.prepare(
  'SELECT channel_id,machine_ids_json FROM vending_achievement_routes WHERE guild_id=? AND owner_id=? ORDER BY created_at'
 ).bind(source,'shared-dashboard').all()).results;
 assert.equal(rows.length,2);
 assert.equal(rows[0].channel_id,channelA);
 assert.equal(rows[1].channel_id,channelB);

 const duplicate=await f.request(
  `/api/guilds/${source}/vending/achievement-room`,
  'PUT',
  {rooms:[
   {channelId:channelA,machineIds:['achievement-vm-a']},
   {channelId:channelB,machineIds:['achievement-vm-a']}
  ]}
 );
 assert.equal(duplicate.status,400,JSON.stringify(duplicate));

 const invalid=await f.request(
  `/api/guilds/${source}/vending/achievement-room`,
  'PUT',
  {rooms:[{channelId:channelA,machineIds:['missing-machine']}]}
 );
 assert.equal(invalid.status,400,JSON.stringify(invalid));

 const cleared=await f.request(
  `/api/guilds/${source}/vending/achievement-room`,
  'PUT',
  {rooms:[]}
 );
 assert.equal(cleared.status,200,JSON.stringify(cleared));
 assert.deepEqual(cleared.body.rooms,[]);
});

test('same-guild identity restores renamed and moved channels without making duplicates',async t=>{
 const f=await fixture(t),backup=await f.snapshot();
 f.channels[source].find(x=>x.id===channelA).name='Changed name';
 f.channels[source].find(x=>x.id===channelB).parent_id=null;
 f.roles[source].find(x=>x.id===roleA).name='Changed role';
 const result=await f.finish(await f.start(backup,source));
 assert.equal(result.status,'completed',JSON.stringify(result));
 assert.equal(f.channels[source].length,3);
 assert.equal(f.roles[source].length,3);
 assert.equal(f.channels[source].find(x=>x.id===channelA).name,'same');
 assert.equal(f.channels[source].find(x=>x.id===channelB).parent_id,category);
});


test('AutoMod updates existing rules without deleting active protection first',async t=>{
 const f=await fixture(t);
 f.state.autoRules=[{id:'rule-spam',name:'DSM Anti-Spam'},{id:'rule-invite',name:'DSM Invite Guard'},{id:'rule-mention',name:'DSM Mention Guard'}];
 const res=await f.request(`/api/guilds/${source}/settings`,'PUT',{securityEnabled:true,antiSpam:true,blockInvites:true,mentionLimit:12});
 assert.equal(res.status,200);assert.deepEqual(res.body.applyWarnings,[]);
 assert.equal(f.state.calls.filter(x=>x.method==='DELETE'&&x.p.includes('auto-moderation')).length,0);
 const patches=f.state.calls.filter(x=>x.method==='PATCH'&&x.p.includes('auto-moderation'));
 assert.equal(patches.length,3);assert.equal(patches.find(x=>x.p.endsWith('rule-mention')).body.trigger_metadata.mention_total_limit,12);
 assert.ok(patches.every(x=>x.body.trigger_type===undefined));
});

test('large product collections are captured completely and split into decryptable chunks',async t=>{
 const f=await fixture(t);await f.request(`/api/guilds/${source}/vending`);
 await f.db.prepare('INSERT INTO vending_machines(id,guild_id,owner_id,name,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind('vm',source,'test','Large shop').run();
 for(let start=0;start<105;start+=35){
  await f.db.batch(Array.from({length:35},(_,offset)=>f.db.prepare('INSERT INTO vending_products(id,vending_machine_id,name,description,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind('item-'+(start+offset),'vm','Item '+(start+offset),'x'.repeat(1500))));
 }
 const backup=await f.snapshot();
 const chunks=(await f.db.prepare('SELECT payload_chunk FROM guild_backup_chunks WHERE backup_id=? ORDER BY chunk_index').bind(backup.id).all()).results;
 assert.ok(chunks.length>1);
 const [iv,cipher]=chunks.map(x=>x.payload_chunk).join('').split('.');
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('audit-test-only-encryption-key-32-characters'));
 const key=await crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt']);
 const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(iv,'base64url')},key,Buffer.from(cipher,'base64url'));
 const snapshot=JSON.parse(new TextDecoder().decode(plaintext));
 assert.equal(snapshot.bot.vending.products.length,105);
 assert.equal(backup.schemaVersion,2);
});
