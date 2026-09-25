import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Exercise the actual React form and HTTP payload; no production requests.
test('typed ID separators, save-in-flight edits, reload persistence, and backup creation',async t=>{
 const dir=await mkdtemp(path.resolve('.audit-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await build({entryPoints:['src/App.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(dir,'App.mjs'),define:{'import.meta.env.VITE_API_BASE_URL':'"https://fixture.example"'},jsx:'automatic'});
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.example'});
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage','sessionStorage','location','getComputedStyle']) Object.defineProperty(globalThis,key,{value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key],configurable:true});
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 t.after(()=>dom.window.close());
 const React=await import('react');
 const {render,screen,waitFor,cleanup}=await import('@testing-library/react');
 const {default:userEvent}=await import('@testing-library/user-event');
 t.after(cleanup);
 const {default:App}=await import(pathToFileURL(path.join(dir,'App.mjs')).href);
 const user=userEvent.setup();
 localStorage.setItem('dsm_session','fixture-only');
 let saved={securityEnabled:false,antiSpam:true,spamMax:7,spamWindowSeconds:10,blockInvites:true,mentionLimit:5,antiRaid:true,raidJoins:10,raidWindowSeconds:10,antiNuke:true,nukeActions:4,nukeWindowSeconds:15,logChannelId:null,verifiedRoleId:null,minAccountAgeDays:0,ticketSupportRoleIds:[],trustedUserIds:[],trustedRoleIds:[]};
 let backups=[],writes=[],releaseSave;
 const nativeFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=nativeFetch});
 globalThis.fetch=async(input,init={})=>{
  const p=new URL(String(input)).pathname;
  let value;
  if(p==='/api/status')value={discordReady:true,dashboardPasswordConfigured:true,payPayConfigured:false,payPayEnvironment:'sandbox',inviteUrl:''};
  else if(p==='/api/me')value={id:'fixture',username:'Fixture'};
  else if(p==='/api/guilds')value=[{id:'100000000000000001',name:'Fixture server',botInstalled:true}];
  else if(p.endsWith('/meta'))value={id:'100000000000000001',name:'Fixture server',botAdministrator:true,channels:[{id:'300000000000000001',name:'general',type:'text',position:0,botCanPost:true}],categories:[],roles:[{id:'100000000000000001',name:'@everyone',position:0,color:0,permissions:'0',isEveryone:true},{id:'200000000000000001',name:'Verified',position:1,color:0,permissions:'1024',isEveryone:false}]};
  else if(p.endsWith('/settings')){
   if(init.method==='PUT'){const payload=JSON.parse(init.body);writes.push(payload);await new Promise(r=>{releaseSave=r});saved=payload;}
   value={...saved};
  }
  else if(p==='/api/backups')value=backups;
  else if(p.endsWith('/backups')){const payload=JSON.parse(init.body);value={id:'fixture-backup',sourceGuildId:'100000000000000001',sourceGuildName:'Fixture server',label:payload.label,createdAt:Date.now(),schemaVersion:2,roleCount:2,channelCount:1,memberCount:1,recoveryMemberCount:0,warnings:[]};backups=[value];}
  else if(p==='/api/restore-jobs')value=[];
  else if(p.endsWith('/recovery/status'))value={registered:0,authorizePath:'/auth/recovery/start',redirectPath:'/auth/discord/callback'};
  else if(p==='/api/vending/payments/status')value={paypay:false,kyash:false};
  else if(p.endsWith('/vending/achievement-room'))value={rooms:[]};
  else if(p.endsWith('/products')||p.endsWith('/vending'))value=[];
  else throw new Error('Unexpected request: '+p);
  return Response.json(value);
 };
 render(React.createElement(App));
 const trusted=await screen.findByLabelText(/信頼ユーザーID/);
 await user.type(trusted,'400000000000000001,400000000000000002');
 assert.equal(trusted.value,'400000000000000001,400000000000000002','typing comma must not erase separator');
 const verificationTab=screen.getByRole('tab',{name:'認証'});
 await user.click(verificationTab);
 assert.equal(verificationTab.getAttribute('aria-selected'),'true');
 const age=screen.getByLabelText(/アカウント.*日|最低.*日/);
 await user.clear(age);await user.type(age,'31');
 await user.click(screen.getByRole('button',{name:'認証設定を保存'}));
 await waitFor(()=>assert.equal(writes.length,1));
 assert.deepEqual(writes[0].trustedUserIds,['400000000000000001','400000000000000002']);
 await user.clear(age);await user.type(age,'42');
 await React.act(async()=>{releaseSave();});
 await screen.findByText('認証設定を保存しました');
 assert.equal(age.value,'42','server response must not erase later edits');
 await user.click(screen.getByRole('button',{name:'認証設定を保存'}));
 await waitFor(()=>assert.equal(writes.length,2));
 await React.act(async()=>{releaseSave();});
 cleanup();render(React.createElement(App));
 const verificationTabAfterReload=await screen.findByRole('tab',{name:'認証'});
 await user.click(verificationTabAfterReload);
 assert.equal(screen.getByLabelText(/アカウント.*日|最低.*日/).value,'42');
 assert.equal(screen.getByLabelText(/信頼ユーザーID/).value,'400000000000000001,400000000000000002');
 await user.click(screen.getByRole('tab',{name:'バックアップ管理'}));
 await user.type(await screen.findByLabelText('メモ / 名前'),'入力保存テスト');
 await user.click(screen.getByRole('button',{name:'今すぐバックアップを作成'}));
 await screen.findByText('入力保存テスト');
 assert.equal(backups[0].label,'入力保存テスト');
 assert.equal(screen.getByLabelText('メモ / 名前').value,'');
});
