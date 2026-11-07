/**
 * 仲介bot（PayPay代金預かり方式・自動受け取り版）
 *
 * 流れ:
 *  パネル「取引を開始する」→ 相手を選択 → 2人だけのプライベートチャンネル作成
 *  → ⓪ 仲介費の負担者を選択（自分 / 相手 / 割り勘）→ 一致したら運営PayPayで受け取り
 *  → ① 両者が金額を入力（一致でスタート / 不一致で中止・チャンネル削除）
 *  → ② 両者が「買い手 / 売り手」を選択（重複したら選び直し）
 *  → ③ 買い手がPayPay送金リンクを提出 → 金額を確認 → 一致すれば運営アカウントで即受け取り
 *  → ④ チャット解放、当事者同士で商品の受け渡し
 *  → 片方が「取引完了」→ もう片方に合意を求める（同意 / まだ続ける / 通報）
 *  → ⑤ 両者合意 → 運営アカウントから売り手への送金リンクを作成 → 売り手だけが受け取れるボタンで渡す
 *  → 通報: 代金凍結 → スタッフが「売り手へ支払う / 買い手へ返金する」を判断 → 送金リンクを作成
 *
 * PayPayのAPI呼び出しが失敗したときは、スタッフ用チャンネルに通知して手動対応に切り替わります。
 * Cloudflare WorkersはGatewayに常駐しないため、待ち時間のある処理（自動同意・チャンネル削除・
 * 実績チャンネル名の更新）は1分ごとのCronで行います。
 */
import type { Env } from "./types";
import { DiscordApiError, botFetch, botJson } from "./discord";
import { getDashboardSession } from "./db";
import { openSecurityMaintenanceLease, securityBridgeConfigured } from "./security-bridge";
import { decrypt, encrypt, json, randomId, sha256Hex, snowflakeTime } from "./utils";
import {
  ensureVendingSchema, getPayPay, removePayPay, savePayChallenge, savePayPay, takePayChallenge
} from "./vending-db";
import {
  acceptPayPayLink, createPayPayLink, inspectPayPayLink, payPayLoginOtp, payPayLoginStart
} from "./vending-payments";
import {
  AMOUNT, CANCELLED, CLOSED, COMPLETE_PENDING, CONFIRMING, DISPUTE, FEE, FEE_RECEIVING, PAID, PAYMENT, PAYOUT, ROLE, TRADING,
  activeTradeBetween, addRecord, completedCount, countOpenTrades, createTrade, ensureMediationSchema, getMediationSettings, getStats, getTrade,
  guildSummary, listDirtyResultGuilds, listDueDeletions, listRecentTrades, listStuckTrades, markAlerted, markResultDirty,
  normalizeMediationSettings, saveMediationSettings, setResultRenameState, tradeByChannel, transition, updateTrade,
  type MediationSettings, type Trade
} from "./mediation-db";

export class MediationHttpError extends Error { constructor(public status:number,message:string){super(message);} }

// 受け取り処理は pay.paypay.ne.jp/<コード> の形しか解釈できないので、それ以外は入力の時点で弾く
const PAYPAY_LINK_RE=/^https:\/\/pay\.paypay\.ne\.jp\/[A-Za-z0-9_-]+\/?(?:[?#]\S*)?$/;
const COLOR={blurple:0x5865f2,green:0x57f287,red:0xed4245,orange:0xe67e22,gold:0xf1c40f,teal:0x1abc9c};
const VIEW=1024n,SEND=2048n,EMBED=16384n,ATTACH=32768n,HISTORY=65536n,MANAGE_MESSAGES=8192n,MANAGE_CHANNELS=16n,MANAGE_ROLES=268435456n,ADMIN=8n;
const MEMBER_READ=(VIEW|HISTORY).toString();
const MEMBER_CHAT=(VIEW|HISTORY|SEND|ATTACH).toString();
const MEMBER_MUTED=(SEND|ATTACH).toString();
const BOT_ALLOW=(VIEW|SEND|EMBED|ATTACH|HISTORY|MANAGE_MESSAGES|MANAGE_CHANNELS|MANAGE_ROLES).toString();
const STAFF_ALLOW=(VIEW|SEND|EMBED|ATTACH|HISTORY).toString();

const FEE_LABELS:Record<string,string>={self:"自分が負担",other:"相手が負担",split:"割り勘"};
const REPORT_TYPES:Array<[string,string]>=[
  ["詐欺","お金や商品をだまし取られた"],
  ["説明と異なる商品","受け取った商品が説明・合意内容と違う"],
  ["持ち逃げ","相手が受け取った後に応答しない・逃げた"],
  ["商品が届かない","商品を受け取れていない"],
  ["買い手が/completeを押さない","商品を渡したのに、買い手が取引完了しない"],
  ["その他","上記以外のトラブル"]
];
const STAFF_LABELS:Record<string,[string,number]>={
  confirm:["運営で預かり完了",3],
  reject:["差し戻し",2],
  payseller:["売り手へ支払う",1],
  refund:["買い手へ返金する",4],
  done:["支払い完了",3],
  feeok:["仲介費の受け取り完了",3],
  feeng:["仲介費の差し戻し",2]
};

// ---- 小さなヘルパー -----------------------------------------------------------
const yen=(n:number|null|undefined)=>"¥"+Number(n??0).toLocaleString("ja-JP");
const no=(t:Trade)=>"#"+String(t.number).padStart(4,"0");
const hoursLabel=(h:number)=>String(Math.round(h*100)/100);

function embed(title:string,description="",color=COLOR.blurple,extra:Record<string,unknown>={}){
  return {title:title.slice(0,256),description:description.slice(0,4096),color,...extra};
}
function button(customId:string,label:string,style:number){
  return {type:2,custom_id:customId,label,style};
}
function row(...components:unknown[]){ return {type:1,components}; }
function ires(data:unknown){ return new Response(JSON.stringify(data),{headers:{"Content-Type":"application/json"}}); }
function reply(content:string,extra:Record<string,unknown>={}){ return ires({type:4,data:{content,flags:64,...extra}}); }
function modal(customId:string,title:string,inputs:unknown[]){
  return ires({type:9,data:{custom_id:customId,title:title.slice(0,45),components:inputs.map(i=>row(i))}});
}
function textInput(customId:string,label:string,opts:Record<string,unknown>={}){
  return {type:4,custom_id:customId,label,style:1,required:true,...opts};
}
function modalValue(interaction:any,customId:string):string{
  for(const r of interaction?.data?.components??[]){
    for(const c of r?.components??[]){
      if(c?.custom_id===customId) return String(c.value??"");
    }
  }
  return "";
}

async function send(env:Env,channelId:string,payload:Record<string,unknown>){
  return botJson<{id:string}>(env,`/channels/${channelId}/messages`,{method:"POST",body:JSON.stringify(payload)});
}
async function trySend(env:Env,channelId:string|null,payload:Record<string,unknown>){
  if(!channelId) return null;
  try{ return await send(env,channelId,payload); }
  catch(error){ console.error("mediation send failed",channelId,error); return null; }
}

async function lease(env:Env,guildId:string,required=false):Promise<boolean>{
  if(!securityBridgeConfigured(env)) return true;
  try{ await openSecurityMaintenanceLease(env,guildId,"dashboard_edit",30); return true; }
  catch(error){
    console.error("mediation security lease failed",guildId,error);
    if(required) return false;
    return true;
  }
}

const enc=(env:Env,v:string|null)=>v?encrypt(env.SESSION_ENCRYPTION_KEY,v):Promise.resolve(null);
const dec=async(env:Env,v:string|null)=>v?decrypt(env.SESSION_ENCRYPTION_KEY,v):null;

function payOwner(guildId:string){ return "mediation:"+guildId; }
async function payAccount(env:Env,guildId:string){
  await ensureVendingSchema(env);
  return getPayPay(env,payOwner(guildId),env.SESSION_ENCRYPTION_KEY);
}

function memberRoles(member:any):string[]{
  return Array.isArray(member?.roles)?member.roles.map(String):[];
}
function isStaff(member:any,settings:MediationSettings):boolean{
  try{ if((BigInt(String(member?.permissions??"0"))&ADMIN)===ADMIN) return true; }catch{ /* ignore */ }
  const roles=memberRoles(member);
  return settings.staffRoleIds.some(id=>roles.includes(id));
}
function isBlacklisted(member:any,settings:MediationSettings):boolean{
  const roles=memberRoles(member);
  return settings.blacklistRoleIds.some(id=>roles.includes(id));
}
/** 取引できない理由（アカウント作成日・参加日など）。問題なければ null */
function eligibilityProblem(userId:string,member:any,settings:MediationSettings,who:"self"|"partner"):string|null{
  const subject=who==="self"?"あなた":"その相手";
  if(isBlacklisted(member,settings)) return who==="self"?"あなたは取引を利用できません。":"その相手とは取引できません。";
  if(settings.minAccountAgeDays>0&&Date.now()-snowflakeTime(userId)<settings.minAccountAgeDays*86_400_000){
    return `${subject}のDiscordアカウントは作成から${settings.minAccountAgeDays}日未満のため、取引できません。`;
  }
  if(settings.minMemberDays>0){
    const joined=Date.parse(String(member?.joined_at??""));
    if(!Number.isFinite(joined)||Date.now()-joined<settings.minMemberDays*86_400_000){
      return `${subject}はサーバー参加から${settings.minMemberDays}日未満のため、取引できません。`;
    }
  }
  return null;
}

function staffMentions(settings:MediationSettings){ return settings.staffRoleIds.map(id=>`<@&${id}>`).join(" "); }

async function notifyStaff(env:Env,settings:MediationSettings,title:string,description:string,actions:Array<[string,number]>=[],color=COLOR.red){
  const components=actions.length?[row(...actions.map(([action,tid])=>{
    const [label,style]=STAFF_LABELS[action]!;
    return button(`md:staff:${action}:${tid}`,label,style);
  }))]:[];
  const payload={content:staffMentions(settings)||undefined,embeds:[embed(title,description,color)],components,allowed_mentions:{parse:["roles"]}};
  const sent=await trySend(env,settings.staffChannelId,payload);
  if(!sent) console.error("mediation staff notification was not delivered",title);
  // 判断ボタン付きの通知を出した取引は「止まった取引」の検出対象から外す
  for(const tid of new Set(actions.map(([,id])=>id))) await markAlerted(env,tid).catch(()=>undefined);
}

async function setChat(env:Env,t:Trade,enabled:boolean){
  if(!t.channel_id) return;
  await lease(env,t.guild_id);
  for(const uid of [t.user_a,t.user_b]){
    try{
      await botJson(env,`/channels/${t.channel_id}/permissions/${uid}`,{
        method:"PUT",
        headers:{"X-Audit-Log-Reason":"Mediation: trade chat "+(enabled?"open":"close")},
        body:JSON.stringify({type:1,allow:enabled?MEMBER_CHAT:MEMBER_READ,deny:enabled?"0":MEMBER_MUTED})
      });
    }catch(error){ console.error("mediation set chat failed",t.id,uid,error); }
  }
}

function scheduleDelete(seconds:number){ return Date.now()+Math.max(0,seconds)*1000; }

// ---- 各段階の表示 -------------------------------------------------------------
function feeShare(t:Trade,uid:string,choice:string):number{
  if(choice==="self") return t.fee_total;
  if(choice==="split"){
    const half=Math.floor(t.fee_total/2);
    return uid===t.user_a?t.fee_total-half:half;
  }
  return 0;
}

function feeMessage(t:Trade){
  return {
    embeds:[embed(
      `取引 ${no(t)}｜⓪ 仲介費のお支払い`,
      `この取引の仲介費は **${yen(t.fee_total)}** です。誰が負担するかを、それぞれ選んでください。\n\n`+
      "・**自分が負担**：あなたが全額を払います（送金リンクの入力欄が出ます）\n"+
      "・**割り勘**：2人で半分ずつ払います（送金リンクの入力欄が出ます）\n"+
      "・**相手が負担**：相手が全額を払います\n\n"+
      "2人の選択が一致したら（「自分」と「相手」の組み合わせ、または両者「割り勘」）、仲介費を受け取って次へ進みます。\n"+
      "一致しなければ選び直しです。仲介費は取引が中止になっても返金されません。\n\n"+
      "⚠️ スタッフ・botがDMで送金を求めることは**絶対にありません**。"
    )],
    components:[
      row(button(`md:fee:other:${t.id}`,"相手が負担",2),button(`md:fee:split:${t.id}`,"割り勘",1),button(`md:fee:self:${t.id}`,"自分が負担",3)),
      row(button(`md:cancel:${t.id}`,"取引を中止",4))
    ]
  };
}

function amountMessage(t:Trade,settings:MediationSettings){
  const range=settings.maxAmount>0?`${yen(settings.minAmount)}〜${yen(settings.maxAmount)}`:`${yen(settings.minAmount)}以上`;
  return {
    embeds:[embed(
      `取引 ${no(t)}｜① 金額の合意`,
      "それぞれ「金額を入力」から、この取引の代金（円）を入力してください。\n"+
      "・相手の入力額は、両者が入力し終わるまで表示されません。\n"+
      "・**両者の金額が一致したらスタート**、一致しなければこの取引は中止になります。\n"+
      `・入力できる金額: ${range}`
    )],
    components:[row(button(`md:amount:${t.id}`,"金額を入力",1),button(`md:cancel:${t.id}`,"取引を中止",2))]
  };
}

function paymentMessage(t:Trade){
  return {
    content:`<@${t.buyer_id}>`,
    embeds:[embed(
      `取引 ${no(t)}｜③ 代金の送金`,
      `買い手: <@${t.buyer_id}>　売り手: <@${t.seller_id}>　金額: **${yen(t.amount)}**\n\n`+
      "**買い手の方へ**\n"+
      `1. PayPayアプリで「送る」→「リンクを作成」から **${yen(t.amount)}** の送金リンクを作成\n`+
      "2. 下の「送金リンクを提出」ボタンからリンクを提出（チャンネルには表示されません）\n"+
      "　パスコードを設定した場合は、パスコードも入力してください（なしでもOK）\n\n"+
      "botが金額を確認し、一致すれば運営が代金を預かります。売り手への支払いは、両者が取引完了に合意した後です。\n"+
      "⚠️ リンクをチャットやDMに貼らないでください。"
    )],
    components:[row(button(`md:pay:${t.id}`,"送金リンクを提出",3),button(`md:cancel:${t.id}`,"取引を中止",2))]
  };
}

function linkModal(customId:string,title:string){
  return modal(customId,title,[
    textInput("link","送金リンク",{placeholder:"https://pay.paypay.ne.jp/...",max_length:300}),
    textInput("passcode","パスコード（設定した場合のみ）",{required:false,max_length:4,placeholder:"未設定なら空欄のまま"})
  ]);
}

function linkProblem(info:{pending:boolean;amount:number;hasPasscode:boolean},expected:number,passcode:string|null,label:string):string|null{
  if(!info.pending) return "このリンクはすでに受け取り済みか、キャンセル・期限切れです。";
  if(info.amount!==expected) return `リンクの金額が ${yen(info.amount)} です（${label}は ${yen(expected)}）。`;
  if(info.hasPasscode&&!passcode) return "パスコード付きのリンクです。パスコードも入力してください。";
  return null;
}

/** 同じ取引で、本人の入力ミスとして再入力させる回数の上限。超えたらスタッフ対応 */
const MAX_RECEIVE_RETRIES=3;

/**
 * 結果の種類:
 *  ok      … 運営アカウントで受け取れた
 *  invalid … 受け取る前の確認で問題があった（金額違い・期限切れなど）。お金は動いていない
 *  retry   … 受け取りを断られたが、リンクはまだ受け取り待ちのまま＝お金は動いていない（パスコード間違いなど）
 *  staff   … 運営側の問題か、受け取れたかどうか分からない。スタッフが確認する
 */
type ReceiveResult={kind:"ok"}|{kind:"invalid"|"retry"|"staff";reason:string};

async function tryReceive(env:Env,guildId:string,link:string,passcode:string|null,expected:number,label:string):Promise<ReceiveResult>{
  const account=await payAccount(env,guildId);
  if(!account) return {kind:"staff",reason:"運営PayPayが未ログインです（管理画面の 仲介 → 支払い からログインしてください）"};
  const info=await inspectPayPayLink(link).catch(()=>null);
  if(!info) return {kind:"invalid",reason:"送金リンクを確認できませんでした。リンクが正しいか確認してください。"};
  const problem=linkProblem(info,expected,passcode,label);
  if(problem) return {kind:"invalid",reason:problem};
  let result;
  try{ result=await acceptPayPayLink(link,account,passcode); }
  catch(error){ return {kind:"staff",reason:"受け取りの途中でエラー: "+errorText(error)}; }
  if(result.ok) return {kind:"ok"};
  if(result.status==="LOGIN_REQUIRED") return {kind:"staff",reason:"運営PayPayの再ログインが必要です（管理画面の 仲介 → 支払い）"};
  // リンクがまだ受け取り待ちなら、運営には入金されていない。本人にもう一度入力してもらえば安全
  const after=await inspectPayPayLink(link).catch(()=>null);
  if(after?.pending){
    return {kind:"retry",reason:info.hasPasscode
      ?"受け取れませんでした。パスコードが間違っている可能性があります。"
      :"受け取れませんでした。リンクが正しいか確認してください。"};
  }
  return {kind:"staff",reason:"受け取りに失敗しました ("+result.status+")"};
}

/** 再入力の回数を1つ増やし、まだ上限内なら true */
async function allowRetry(env:Env,t:Trade):Promise<boolean>{
  const used=Number(t.receive_failures??0);
  if(used>=MAX_RECEIVE_RETRIES) return false;
  await updateTrade(env,t.id,{receive_failures:used+1});
  return true;
}

// ---- 取引の取得とチェック -----------------------------------------------------
type Ctx={interaction:any;guildId:string;userId:string;member:any;settings:MediationSettings};

async function ctxOf(env:Env,interaction:any):Promise<Ctx|null>{
  const guildId=String(interaction.guild_id??"");
  const member=interaction.member;
  const userId=String(member?.user?.id??"");
  if(!guildId||!userId) return null;
  return {interaction,guildId,userId,member,settings:await getMediationSettings(env,guildId)};
}

async function tradeFor(env:Env,c:Ctx,tid:number|null,participantsOnly=true):Promise<Trade|string>{
  const t=tid?await getTrade(env,tid):await tradeByChannel(env,String(c.interaction.channel_id??""));
  if(!t||t.guild_id!==c.guildId||(t.channel_id&&String(c.interaction.channel_id??"")!==t.channel_id)){
    return "このチャンネルの取引が見つかりません。";
  }
  if(participantsOnly&&c.userId!==t.user_a&&c.userId!==t.user_b) return "この取引の当事者のみ操作できます。";
  return t;
}

// ---- パネル → 取引チャンネル作成 -------------------------------------------------
export function panelPayload(settings:MediationSettings){
  const lines=[
    settings.panelDescription,
    "",
    "**流れ**",
    "1. 取引相手を選ぶ → 2人だけの取引チャンネルが作られます",
    settings.feeAmount>0?`2. 仲介費（${yen(settings.feeAmount)}）の負担者を選んで支払い（自分・相手・割り勘）`:"2. 仲介費は無料です",
    "3. 両者が金額を入力（一致したらスタート）",
    "4. 買い手 / 売り手を選択",
    "5. 買い手がPayPay送金リンクを提出 → 金額を確認して運営が代金を預かります",
    "6. チャンネル内で商品を受け渡し",
    "7. 買い手が取引完了 → 売り手に代金を支払い",
    "",
    "⚠️ スタッフ・botがDMで送金を求めることは絶対にありません。"
  ];
  return {
    embeds:[embed(settings.panelTitle,lines.join("\n").trim())],
    components:[row({...button("md:start","取引を開始する",3),emoji:{name:"🤝"}})]
  };
}

async function onStart(env:Env,c:Ctx){
  const problem=eligibilityProblem(c.userId,c.member,c.settings,"self");
  if(problem) return reply(problem);
  if(c.settings.maxOpenTrades>0&&await countOpenTrades(env,c.guildId,c.userId)>=c.settings.maxOpenTrades){
    return reply(`同時に進められる取引は${c.settings.maxOpenTrades}件までです。進行中の取引を終えてからお試しください。`);
  }
  return reply("取引相手を選んでください。",{components:[row({type:5,custom_id:"md:partner",placeholder:"取引相手を選択",min_values:1,max_values:1})]});
}

async function onPartner(env:Env,c:Ctx){
  const partnerId=String(c.interaction.data?.values?.[0]??"");
  const resolved=c.interaction.data?.resolved??{};
  const partnerUser=resolved.users?.[partnerId];
  const partnerMember=resolved.members?.[partnerId];
  if(!partnerId||partnerId===c.userId||partnerUser?.bot) return reply("その相手とは取引できません。");
  if(!partnerMember) return reply("相手がサーバーにいません。");
  const selfProblem=eligibilityProblem(c.userId,c.member,c.settings,"self");
  if(selfProblem) return reply(selfProblem);
  const partnerProblem=eligibilityProblem(partnerId,partnerMember,c.settings,"partner");
  if(partnerProblem) return reply(partnerProblem);
  if(c.settings.maxOpenTrades>0){
    if(await countOpenTrades(env,c.guildId,c.userId)>=c.settings.maxOpenTrades){
      return reply(`同時に進められる取引は${c.settings.maxOpenTrades}件までです。`);
    }
    if(await countOpenTrades(env,c.guildId,partnerId)>=c.settings.maxOpenTrades){
      return reply("その相手は進行中の取引が上限に達しています。");
    }
  }

  // 相手選択メニューは何度でも押せるので、同じ2人の取引が二重にできないようにする
  const existing=await activeTradeBetween(env,c.guildId,c.userId,partnerId);
  if(existing){
    return reply(existing.channel_id
      ?`この相手とはすでに取引が進行中です: <#${existing.channel_id}>`
      :"この相手とはすでに取引が進行中です。");
  }

  const feeTotal=c.settings.feeAmount;
  const t=await createTrade(env,c.guildId,c.userId,partnerId,feeTotal,feeTotal>0?FEE:AMOUNT);
  const overwrites:Array<Record<string,unknown>>=[
    {id:c.guildId,type:0,deny:VIEW.toString()},
    {id:c.userId,type:1,allow:MEMBER_READ,deny:MEMBER_MUTED},
    {id:partnerId,type:1,allow:MEMBER_READ,deny:MEMBER_MUTED},
    {id:env.DISCORD_APPLICATION_ID.trim(),type:1,allow:BOT_ALLOW}
  ];
  for(const roleId of c.settings.staffRoleIds) overwrites.push({id:roleId,type:0,allow:STAFF_ALLOW});
  const name=String(c.member?.user?.username??c.userId);
  const partnerName=String(partnerUser?.username??partnerId);
  await lease(env,c.guildId);
  let channel:{id:string};
  try{
    channel=await botJson<{id:string}>(env,`/guilds/${c.guildId}/channels`,{
      method:"POST",
      headers:{"X-Audit-Log-Reason":"Mediation: trade channel created"},
      body:JSON.stringify({
        name:`取引-${String(t.number).padStart(4,"0")}`,
        type:0,
        topic:`取引 ${no(t)} / ${name} × ${partnerName}`.slice(0,1024),
        ...(c.settings.categoryId?{parent_id:c.settings.categoryId}:{}),
        permission_overwrites:overwrites
      })
    });
  }catch(error){
    await updateTrade(env,t.id,{status:CANCELLED,channel_deleted:1});
    throw error;
  }
  await updateTrade(env,t.id,{channel_id:channel.id});
  const fresh={...t,channel_id:channel.id};
  if(feeTotal>0){
    await send(env,channel.id,{
      content:`<@${c.userId}> <@${partnerId}>\n**取引を開始します。** まずは仲介費の負担方法を選んでください。`,
      ...feeMessage(fresh)
    });
  }else{
    await send(env,channel.id,{content:`<@${c.userId}> <@${partnerId}>\n**取引を開始します。**`});
    await send(env,channel.id,amountMessage(fresh,c.settings));
  }
  return reply(`取引チャンネルを作成しました: <#${channel.id}>`);
}

// ---- ⓪ 仲介費 ---------------------------------------------------------------
function feeKeys(t:Trade,uid:string){
  const side=uid===t.user_a?"a":"b";
  return {choice:`fee_choice_${side}`,link:`fee_link_${side}_enc`,pass:`fee_pass_${side}_enc`} as const;
}

/**
 * 割り勘で片方だけ受け取れて、もう片方が再入力するときの制限。
 * 支払い済みの人は選び直せず、残りの人は「割り勘」のまま再提出する。
 */
function feeChoiceGuard(t:Trade,uid:string,choice:string):string|null{
  const mine=uid===t.user_a?t.fee_paid_a:t.fee_paid_b;
  const theirs=uid===t.user_a?t.fee_paid_b:t.fee_paid_a;
  if(mine) return "あなたの仲介費は受け取り済みです。相手の提出を待ってください。";
  if(theirs&&choice!=="split") return "相手は割り勘分の仲介費を支払い済みです。「割り勘」を選んで、送金リンクを提出してください。";
  return null;
}

async function onFeeButton(env:Env,c:Ctx,choice:string,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(t.status!==FEE) return reply("仲介費の選択は終了しています。");
  if(choice!=="other"&&choice!=="self"&&choice!=="split") return reply("不正な選択です。");
  const guard=feeChoiceGuard(t,c.userId,choice);
  if(guard) return reply(guard);
  // 仲介費が1円だと割り勘で片方の負担が0円になり、0円の送金リンクは作れない
  if(choice==="split"&&Math.floor(t.fee_total/2)<=0){
    return reply("仲介費が少額のため割り勘はできません。「自分が負担」か「相手が負担」を選んでください。");
  }
  if(choice==="other"){
    const k=feeKeys(t,c.userId);
    await updateTrade(env,t.id,{[k.choice]:"other",[k.link]:null,[k.pass]:null} as Partial<Trade>);
    await send(env,t.channel_id!,{content:`✅ <@${c.userId}> が仲介費の負担方法を選びました。`,allowed_mentions:{parse:[]}});
    await finalizeFee(env,c.settings,t.id);
    return reply("「相手が負担」を選びました。");
  }
  return linkModal(`md:feem:${choice}:${t.id}`,`仲介費 ${yen(feeShare(t,c.userId,choice))} の送金リンク`);
}

async function onFeeModal(env:Env,c:Ctx,choice:string,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(t.status!==FEE) return reply("仲介費の選択は終了しています。");
  if(choice!=="self"&&choice!=="split") return reply("不正な選択です。");
  const guard=feeChoiceGuard(t,c.userId,choice);
  if(guard) return reply(guard);
  const link=modalValue(c.interaction,"link").trim();
  const passcode=modalValue(c.interaction,"passcode").trim()||null;
  if(!PAYPAY_LINK_RE.test(link)) return reply("PayPayの送金リンクではないようです。");
  const amount=feeShare(t,c.userId,choice);
  if(amount<=0) return reply("あなたの負担額は0円です。もう一度ボタンから選び直してください。");
  // 割り勘で2人が同じリンクを出すと、1回分しか受け取れない
  const otherLinkEnc=c.userId===t.user_a?t.fee_link_b_enc:t.fee_link_a_enc;
  if(otherLinkEnc&&await dec(env,otherLinkEnc)===link){
    return reply("相手が提出したものと同じリンクです。自分で作った送金リンクを提出してください。");
  }
  // 金額だけ確認する。受け取るのは2人の選択が一致してから
  let info=null;
  try{ info=await inspectPayPayLink(link); }catch{ info=null; }
  if(info){
    const problem=linkProblem(info,amount,passcode,"必要な金額");
    if(problem) return reply(problem+"\n作り直して、もう一度ボタンから提出してください。");
  }
  const k=feeKeys(t,c.userId);
  await updateTrade(env,t.id,{[k.choice]:choice,[k.link]:await enc(env,link),[k.pass]:await enc(env,passcode)} as Partial<Trade>);
  await send(env,t.channel_id!,{content:`✅ <@${c.userId}> が仲介費の負担方法を選びました。`,allowed_mentions:{parse:[]}});
  await finalizeFee(env,c.settings,t.id);
  return reply(`「${FEE_LABELS[choice]}」で送金リンクを受け付けました。`);
}

async function finalizeFee(env:Env,settings:MediationSettings,tid:number){
  const t=await getTrade(env,tid);
  if(!t||t.status!==FEE) return;
  const ca=t.fee_choice_a,cb=t.fee_choice_b;
  if(!ca||!cb) return;
  const ok=(ca==="self"&&cb==="other")||(ca==="other"&&cb==="self")||(ca==="split"&&cb==="split");
  if(!ok){
    await updateTrade(env,tid,{fee_choice_a:null,fee_choice_b:null,fee_link_a_enc:null,fee_pass_a_enc:null,fee_link_b_enc:null,fee_pass_b_enc:null});
    const msg=feeMessage(t);
    await send(env,t.channel_id!,{
      embeds:[embed("負担者が一致しませんでした",
        `<@${t.user_a}>: ${FEE_LABELS[ca]}\n<@${t.user_b}>: ${FEE_LABELS[cb]}\n\n`+
        "仲介費は受け取っていません。提出した送金リンクはPayPayアプリでキャンセルし、話し合ってから選び直してください。",COLOR.orange)],
      components:msg.components
    });
    return;
  }
  if(!await transition(env,tid,[FEE],FEE_RECEIVING)) return;

  const payers:Array<{uid:string;link:string;pass:string|null;amount:number;side:"a"|"b";paid:boolean}>=[];
  for(const [uid,choice,linkEnc,passEnc,side] of [
    [t.user_a,ca,t.fee_link_a_enc,t.fee_pass_a_enc,"a"],
    [t.user_b,cb,t.fee_link_b_enc,t.fee_pass_b_enc,"b"]
  ] as const){
    if(choice!=="self"&&choice!=="split") continue;
    if(feeShare(t,uid,choice)<=0) continue;
    const alreadyPaid=side==="a"?t.fee_paid_a:t.fee_paid_b;
    payers.push({uid,link:alreadyPaid?"":(await dec(env,linkEnc))??"",pass:alreadyPaid?null:await dec(env,passEnc),amount:feeShare(t,uid,choice),side,paid:Boolean(alreadyPaid)});
  }

  for(const p of payers){
    if(p.paid) continue; // 前回までに受け取り済み（割り勘で片方だけ再入力した場合）
    const result=await tryReceive(env,t.guild_id,p.link,p.pass,p.amount,"必要な金額");
    if(result.kind==="ok"){
      p.paid=true;
      await updateTrade(env,tid,{[p.side==="a"?"fee_paid_a":"fee_paid_b"]:p.amount} as Partial<Trade>);
      continue;
    }
    // お金が動いていないなら、その人だけもう一度提出してもらう
    if(result.kind==="invalid"||(result.kind==="retry"&&await allowRetry(env,t))){
      const k=feeKeys(t,p.uid);
      await transition(env,tid,[FEE_RECEIVING],FEE,{[k.choice]:null,[k.link]:null,[k.pass]:null} as Partial<Trade>);
      const paidNote=payers.filter(x=>x.paid).map(x=>`<@${x.uid}> の ${yen(x.amount)} は受け取り済みです。`).join("\n");
      await send(env,t.channel_id!,{
        content:`<@${p.uid}>`,
        embeds:[embed("仲介費を受け取れませんでした",
          `${result.reason}\n<@${p.uid}> さん、もう一度「${FEE_LABELS[p.side==="a"?ca:cb]}」を押して送金リンクを提出してください。`+
          (result.kind==="retry"?"リンクはそのまま使えます（パスコードを確認してください）。":"")+
          (paidNote?`\n\n${paidNote}`:""),COLOR.orange)],
        components:feeMessage(t).components
      });
      return;
    }
    // 運営側の問題、または受け取れたかどうか分からないときだけスタッフが確認する
    const lines=payers.map(x=>x.paid
      ?`<@${x.uid}> ${yen(x.amount)} ← 受け取り済み`
      :`<@${x.uid}> ${yen(x.amount)}: ||${x.link}||（パスコード: ||${x.pass??"なし"}||）`).join("\n");
    await send(env,t.channel_id!,{embeds:[embed("確認中","仲介費の受け取りをスタッフが確認しています。しばらくお待ちください。")]});
    await notifyStaff(env,settings,`⚠️ 取引 ${no(t)}｜仲介費の自動受け取りに失敗`,
      `チャンネル: <#${t.channel_id}>\n${lines}\nエラー: \`${result.reason}\`\n\n`+
      "未受け取りのリンクを運営PayPayで**すぐ受け取って**から「仲介費の受け取り完了」。\n"+
      "受け取れない（無効・金額違い）なら「仲介費の差し戻し」。",
      [["feeok",tid],["feeng",tid]],COLOR.gold);
    return;
  }
  if(!await transition(env,tid,[FEE_RECEIVING],AMOUNT)) return;
  await startAmount(env,settings,tid);
}

async function startAmount(env:Env,settings:MediationSettings,tid:number){
  // 再入力の回数は、仲介費と代金で別々に数える
  await updateTrade(env,tid,{status:AMOUNT,fee_link_a_enc:null,fee_pass_a_enc:null,fee_link_b_enc:null,fee_pass_b_enc:null,receive_failures:0});
  const t=(await getTrade(env,tid))!;
  const payers=[
    t.fee_paid_a?`<@${t.user_a}> ${yen(t.fee_paid_a)}`:null,
    t.fee_paid_b?`<@${t.user_b}> ${yen(t.fee_paid_b)}`:null
  ].filter(Boolean).join("、")||"スタッフ確認済み";
  await send(env,t.channel_id!,{embeds:[embed("✅ 仲介費を受け取りました",payers,COLOR.green)],allowed_mentions:{parse:[]}});
  await send(env,t.channel_id!,amountMessage(t,settings));
}

// ---- 中止 ---------------------------------------------------------------------
async function onCancel(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  const seconds=c.settings.cancelDeleteSeconds;
  if(!await transition(env,t.id,[FEE,AMOUNT,ROLE,PAYMENT],CANCELLED,{delete_at:scheduleDelete(seconds)})){
    return reply("この段階では中止できません。");
  }
  await send(env,t.channel_id!,{embeds:[embed("取引中止",`<@${c.userId}> が取引を中止しました。\n${deleteNotice(seconds)}`,COLOR.red)]});
  return reply("取引を中止しました。");
}

function deleteNotice(seconds:number){
  if(seconds<=0) return "このチャンネルはまもなく削除されます。";
  if(seconds<120) return `約${seconds}秒後にこのチャンネルは削除されます。`;
  return `約${Math.round(seconds/60)}分後にこのチャンネルは削除されます。`;
}

// ---- ① 金額 ------------------------------------------------------------------
async function onAmountButton(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(t.status!==AMOUNT) return reply("金額入力の段階は終了しています。");
  return modal(`md:amountm:${t.id}`,"取引金額の入力",[textInput("amount","金額（円）",{placeholder:"例: 5000",max_length:12})]);
}

async function onAmountModal(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(t.status!==AMOUNT) return reply("金額入力の段階は終了しています。");
  const raw=modalValue(c.interaction,"amount").replace(/[０-９]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xfee0)).replace(/[,，、¥￥円\s]/g,"");
  if(!/^\d+$/.test(raw)||Number(raw)<=0||!Number.isSafeInteger(Number(raw))) return reply("1以上の整数で入力してください。");
  const value=Number(raw);
  if(value<c.settings.minAmount) return reply(`取引金額は ${yen(c.settings.minAmount)} 以上で入力してください。`);
  if(c.settings.maxAmount>0&&value>c.settings.maxAmount) return reply(`取引金額の上限は ${yen(c.settings.maxAmount)} です。`);
  await updateTrade(env,t.id,c.userId===t.user_a?{amount_a:value}:{amount_b:value});
  const cur=(await getTrade(env,t.id))!;
  if(cur.amount_a===null||cur.amount_b===null){
    await send(env,t.channel_id!,{content:`✅ <@${c.userId}> が金額を入力しました。相手の入力を待っています。`,allowed_mentions:{parse:[]}});
    return reply(`${yen(value)} で入力しました。`);
  }
  if(cur.amount_a===cur.amount_b){
    if(await transition(env,t.id,[AMOUNT],ROLE,{amount:cur.amount_a})){
      await send(env,t.channel_id!,{
        embeds:[embed(`取引 ${no(t)}｜② 役割の選択`,`金額が **${yen(cur.amount_a)}** で一致しました。\nそれぞれ自分が「買い手」か「売り手」かを選んでください。`,COLOR.green)],
        components:[row(button(`md:role:buyer:${t.id}`,"買い手",1),button(`md:role:seller:${t.id}`,"売り手",1),button(`md:cancel:${t.id}`,"取引を中止",2))]
      });
    }
  }else{
    const seconds=c.settings.cancelDeleteSeconds;
    if(await transition(env,t.id,[AMOUNT],CANCELLED,{delete_at:scheduleDelete(seconds)})){
      await send(env,t.channel_id!,{
        embeds:[embed("金額が一致しませんでした",
          `<@${t.user_a}>: ${yen(cur.amount_a)}\n<@${t.user_b}>: ${yen(cur.amount_b)}\n\n`+
          `この取引は中止します。金額を話し合ってから、パネルで取引を作り直してください。\n${deleteNotice(seconds)}`,COLOR.red)],
        allowed_mentions:{parse:[]}
      });
    }
  }
  return reply(`${yen(value)} で入力しました。`);
}

// ---- ② 役割 ------------------------------------------------------------------
async function onRole(env:Env,c:Ctx,role:string,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(t.status!==ROLE) return reply("役割選択の段階は終了しています。");
  if(role!=="buyer"&&role!=="seller") return reply("不正な選択です。");
  await updateTrade(env,t.id,c.userId===t.user_a?{role_a:role}:{role_b:role});
  const cur=(await getTrade(env,t.id))!;
  const label=role==="buyer"?"買い手":"売り手";
  if(!cur.role_a||!cur.role_b){
    await send(env,t.channel_id!,{content:`✅ <@${c.userId}> が役割を選びました。`,allowed_mentions:{parse:[]}});
    return reply(`「${label}」を選びました。`);
  }
  if(cur.role_a===cur.role_b){
    await updateTrade(env,t.id,{role_a:null,role_b:null});
    await send(env,t.channel_id!,{
      embeds:[embed("役割が重複しています","2人とも同じ役割を選びました。もう一度選び直してください。",COLOR.orange)],
      components:[row(button(`md:role:buyer:${t.id}`,"買い手",1),button(`md:role:seller:${t.id}`,"売り手",1),button(`md:cancel:${t.id}`,"取引を中止",2))]
    });
    return reply(`「${label}」を選びました。`);
  }
  const buyer=cur.role_a==="buyer"?cur.user_a:cur.user_b;
  const seller=buyer===cur.user_a?cur.user_b:cur.user_a;
  if(await transition(env,t.id,[ROLE],PAYMENT,{buyer_id:buyer,seller_id:seller})){
    await send(env,t.channel_id!,paymentMessage({...cur,buyer_id:buyer,seller_id:seller}));
  }
  return reply(`「${label}」を選びました。`);
}

// ---- ③ 送金リンク --------------------------------------------------------------
async function onPayButton(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(c.userId!==t.buyer_id) return reply("買い手のみ提出できます。");
  if(t.status!==PAYMENT) return reply("現在は提出できません。");
  return linkModal(`md:paym:${t.id}`,"PayPay送金リンクの提出");
}

async function onPayModal(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(c.userId!==t.buyer_id) return reply("買い手のみ提出できます。");
  const link=modalValue(c.interaction,"link").trim();
  const passcode=modalValue(c.interaction,"passcode").trim()||null;
  if(!PAYPAY_LINK_RE.test(link)) return reply("PayPayの送金リンクではないようです。もう一度確認してください。");
  // 二重提出を防ぐため、先にステータスを確保する
  if(!await transition(env,t.id,[PAYMENT],CONFIRMING,{paylink_enc:await enc(env,link),passcode_enc:await enc(env,passcode)})){
    return reply("現在は提出できません。");
  }
  // 金額と状態を確認してから、運営アカウントで受け取る（これ以降、買い手は取り消せない）
  const result=await tryReceive(env,t.guild_id,link,passcode,Number(t.amount),"合意した金額");
  if(result.kind==="ok"){
    await startTrading(env,(await getTrade(env,t.id))!);
    return reply("代金を運営が預かりました。");
  }
  // お金が動いていないなら、買い手にもう一度提出してもらう（パスコード間違いなど）
  if(result.kind==="invalid"||(result.kind==="retry"&&await allowRetry(env,t))){
    await updateTrade(env,t.id,{status:PAYMENT,paylink_enc:null,passcode_enc:null});
    const hint=result.kind==="retry"
      ?"パスコードを確認して、もう一度「送金リンクを提出」から提出してください。リンクはそのまま使えます。"
      :"間違ったリンクはPayPayアプリでキャンセルし、正しいリンクを作り直して再提出してください。";
    await send(env,t.channel_id!,{
      content:`<@${t.buyer_id}>`,
      embeds:[embed("送金リンクを受け付けられませんでした",`${result.reason}\n${hint}`,COLOR.orange)],
      components:paymentMessage(t).components
    });
    return reply(`${result.reason}\n${hint}`);
  }
  // 運営側の問題、または受け取れたかどうか分からないときだけスタッフが確認する
  await payFallback(env,c.settings,t,link,passcode,result.kind==="retry"
    ?`${result.reason}（再入力が${MAX_RECEIVE_RETRIES}回を超えました）`
    :result.reason);
  return reply("送金リンクを受け付けました。スタッフが確認します。");
}

async function payFallback(env:Env,settings:MediationSettings,t:Trade,link:string,passcode:string|null,reason:string){
  await send(env,t.channel_id!,{embeds:[embed("確認中","送金リンクの確認に時間がかかっています。スタッフが確認しますので、しばらくお待ちください。")]});
  await notifyStaff(env,settings,`⚠️ 取引 ${no(t)}｜送金リンクの自動処理に失敗`,
    `チャンネル: <#${t.channel_id}>\n買い手: <@${t.buyer_id}>　売り手: <@${t.seller_id}>\n`+
    `金額: **${yen(t.amount)}**\nリンク: ||${link}||\nパスコード: ||${passcode??"なし"}||\n`+
    `エラー: \`${reason}\`\n\n`+
    "運営PayPayで受け取り状況を確認してください。受け取れていない場合は**すぐ受け取って**から「運営で預かり完了」。\n"+
    "無効・金額違いなら「差し戻し」。",
    [["confirm",t.id],["reject",t.id]],COLOR.gold);
}

// ---- ④ 受け渡し ----------------------------------------------------------------
function tradingComponents(t:Trade){
  return [row(button(`md:complete:${t.id}`,"取引完了",3),button(`md:report:${t.id}`,"通報",4))];
}

async function startTrading(env:Env,t:Trade){
  await updateTrade(env,t.id,{status:TRADING,paylink_enc:null,passcode_enc:null});
  await setChat(env,t,true);
  await send(env,t.channel_id!,{
    content:`<@${t.seller_id}> <@${t.buyer_id}>`,
    embeds:[embed(
      `取引 ${no(t)}｜④ 受け渡しスタート`,
      `運営が代金 **${yen(t.amount)}** を預かりました。（売り手にはまだ支払われていません）\n`+
      `<@${t.seller_id}> さん、商品の受け渡しを始めてください。\n\n`+
      "・アカウント情報やファイルは**このチャンネル内で**渡してください（記録が判断材料になります）。\n"+
      `・商品を受け取ったら、**買い手の <@${t.buyer_id}> さん**が「取引完了」ボタンか /complete を実行してください。売り手に代金が支払われます。\n`+
      "・取引完了は買い手だけが実行できます。商品を渡したのに買い手が完了しない場合は、売り手が /report の「買い手が/completeを押さない」で通報してください。\n"+
      "・トラブルがあれば「通報」ボタンか /report で通報してください。取引が保留になり、スタッフが対応します。",
      COLOR.green
    )],
    components:tradingComponents(t)
  });
}

async function onReportOpen(env:Env,c:Ctx,tid:number|null){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(t.status!==TRADING&&t.status!==COMPLETE_PENDING) return reply("現在は通報できません（受け渡し中のみ通報できます）。");
  return reply("トラブルの内容を選んでください。",{components:[row({
    type:3,custom_id:`md:rtype:${t.id}`,placeholder:"トラブルの内容を選択",
    options:REPORT_TYPES.map(([label,description],i)=>({label,description,value:String(i)}))
  })]});
}

async function onReportType(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  const idx=Number(c.interaction.data?.values?.[0]??-1);
  const type=REPORT_TYPES[idx];
  if(!type) return reply("不正な選択です。");
  return modal(`md:reportm:${idx}:${t.id}`,`通報：${type[0]}`,[
    textInput("detail","詳しい内容（任意）",{style:2,required:false,max_length:1000,placeholder:"何が起きたか、いつ、どの商品か など"})
  ]);
}

async function onReportModal(env:Env,c:Ctx,idx:number,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  const type=REPORT_TYPES[idx]?.[0]??"その他";
  const detail=modalValue(c.interaction,"detail").trim()||"（記載なし）";
  if(!await transition(env,t.id,[TRADING,COMPLETE_PENDING],DISPUTE,{
    report_by:c.userId,report_reason:`[${type}] ${detail}`.slice(0,1500),complete_requester:null,complete_requested_at:null
  })){
    return reply("現在は通報できません。");
  }
  await send(env,t.channel_id!,{
    content:`${staffMentions(c.settings)} <@${t.user_a}> <@${t.user_b}>`.trim(),
    embeds:[embed(`🚨 通報：${type}｜取引を保留しました`,
      `通報者: <@${c.userId}>\n内容: ${detail}\n\n`+
      "スタッフが確認するまで、代金はどちらにも渡されません。\n"+
      "**両者とも、このチャンネルに証拠（スクショ・録画など）を提出してください。**\n"+
      "このチャンネル以外でのやりとりは判断材料になりません。",COLOR.red)],
    allowed_mentions:{parse:["roles","users"]}
  });
  await notifyStaff(env,c.settings,`🚨 取引 ${no(t)}｜通報：${type}`,
    `チャンネル: <#${t.channel_id}>\n通報者: <@${c.userId}>\n`+
    `買い手: <@${t.buyer_id}>　売り手: <@${t.seller_id}>　金額: ${yen(t.amount)}\n\n`+
    `内容:\n${detail}\n\n証拠を確認して判断してください。判断後、botが送金リンクを作成します。`,
    [["payseller",t.id],["refund",t.id]]);
  return reply("通報を受け付けました。");
}

async function onComplete(env:Env,c:Ctx,tid:number|null){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  // 売り手が完了できると、商品を渡さずに代金だけ受け取れてしまうので、完了は買い手だけ
  if(c.userId!==t.buyer_id){
    return reply("取引完了は買い手だけが実行できます。\n商品を渡したのに買い手が完了しない場合は、/report で「買い手が/completeを押さない」を選んで通報してください。スタッフが確認して対応します。");
  }
  if(t.status!==TRADING&&t.status!==COMPLETE_PENDING) return reply("現在は取引完了できません。");
  return reply(
    `取引を完了して、売り手 <@${t.seller_id}> さんに **${yen(t.amount)}** を支払います。\n`+
    "商品を受け取って、内容に問題がないことを確認しましたか？ **支払い後は取り消せません。**",
    {components:[row(button(`md:completeok:${t.id}`,"完了して支払う",3),button(`md:opcancel:${t.id}`,"キャンセル",2))],allowed_mentions:{parse:[]}}
  );
}

async function onCompleteConfirmed(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t,{components:[]});
  if(c.userId!==t.buyer_id) return reply("取引完了は買い手だけが実行できます。",{components:[]});
  if(!await transition(env,t.id,[TRADING,COMPLETE_PENDING],PAYOUT,{complete_requester:c.userId,complete_requested_at:Date.now()})){
    return reply("この取引はすでに処理されています。",{components:[]});
  }
  await send(env,t.channel_id!,{embeds:[embed("✅ 買い手が取引を完了しました",
    `<@${t.buyer_id}> に買い手実績、<@${t.seller_id}> に売り手実績が付きました。\n売り手への支払いを準備しています…`,COLOR.green)]});
  await finishAgreed(env,c.settings,t,"買い手完了");
  return reply("取引を完了しました。売り手への支払いを進めています。",{components:[]});
}

function agreedEmbed(t:Trade,settings:MediationSettings,auto=false){
  const head=auto?`完了申請から${hoursLabel(settings.autoAgreeHours)}時間返事がなかったため、自動で同意として扱いました。\n`:"";
  return embed(auto?"✅ 自動で取引完了しました":"✅ 両者が合意しました",
    `${head}<@${t.buyer_id}> に買い手実績、<@${t.seller_id}> に売り手実績が付きました。\n売り手への支払いを準備しています…`,COLOR.green);
}

async function confirmGuard(env:Env,c:Ctx,tid:number):Promise<Trade|Response>{
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if(t.status!==COMPLETE_PENDING) return reply("この申請はすでに処理されています。");
  if(c.userId===t.complete_requester) return reply("申請した本人は操作できません。相手の回答を待ってください。");
  return t;
}

async function agree(env:Env,c:Ctx,t:Trade){
  // 以前の「売り手が申請 → 買い手が同意」の残り。売り手が自分への支払いに同意することはできない
  if(c.userId!==t.buyer_id&&t.complete_requester!==t.buyer_id){
    return reply("取引完了は買い手だけが実行できます。");
  }
  if(!await transition(env,t.id,[COMPLETE_PENDING],PAYOUT)) return reply("この申請はすでに処理されています。");
  await send(env,t.channel_id!,{embeds:[agreedEmbed(t,c.settings)]});
  await finishAgreed(env,c.settings,t,"両者合意");
  return reply("同意しました。");
}

async function onContinue(env:Env,c:Ctx,tid:number){
  const g=await confirmGuard(env,c,tid);
  if(g instanceof Response) return g;
  if(!await transition(env,g.id,[COMPLETE_PENDING],TRADING,{complete_requester:null,complete_requested_at:null})){
    return reply("この申請はすでに処理されています。");
  }
  await send(env,g.channel_id!,{embeds:[embed("取引を続行",`<@${c.userId}> はまだ終了しないと回答しました。受け渡しを続けてください。`)]});
  return reply("取引を続行します。");
}

/** 合意後の処理：実績付与・売り手へ支払い・運営の実績に投稿（ステータスはPAYOUTにしてから呼ぶ） */
async function finishAgreed(env:Env,settings:MediationSettings,t:Trade,decision:string){
  await addRecord(env,t.guild_id,t.buyer_id!,t.seller_id!);
  await payout(env,settings,t.id,t.seller_id!,decision);
  await postResult(env,settings,(await getTrade(env,t.id))!).catch(error=>console.error("mediation result post failed",t.id,error));
}

// ---- ⑤ 支払い ------------------------------------------------------------------
async function payout(env:Env,settings:MediationSettings,tid:number,target:string,decision:string){
  const t=(await getTrade(env,tid))!;
  const amount=Number(t.amount);
  const isSeller=target===t.seller_id;
  await updateTrade(env,tid,{status:PAYOUT,decision,payout_target:target,payout_amount:amount});
  await setChat(env,t,false);
  let link:string;
  try{
    const account=await payAccount(env,t.guild_id);
    if(!account) throw new Error("運営PayPayが未ログインです");
    link=await createPayPayLink(account,amount);
  }catch(error){ // API失敗 → 手動対応へ
    await notifyStaff(env,settings,`⚠️ 取引 ${no(t)}｜自動支払いに失敗`,
      `チャンネル: <#${t.channel_id}>\n<@${target}> へ **${yen(amount)}** を手動で送金し、「支払い完了」を押してください。\n`+
      `理由: ${decision}\nエラー: \`${errorText(error)}\``,
      [["done",tid]]);
    await trySend(env,t.channel_id,{embeds:[embed("支払い処理中","スタッフが送金します。しばらくお待ちください。")]});
    return;
  }
  await updateTrade(env,tid,{status:PAID,payout_link_enc:await enc(env,link)});
  const who=isSeller?"売り手":"買い手（返金）";
  await trySend(env,t.channel_id,{
    content:`<@${target}>`,
    embeds:[embed("💴 代金のお支払い",
      `${who} <@${target}> さんへ **${yen(amount)}** の送金リンクを用意しました。\n`+
      "下のボタンを押すと、あなたにだけ送金リンクが表示されます。PayPayで受け取ってください。",COLOR.green)],
    components:[row(button(`md:pickup:${tid}`,"代金を受け取る",3))]
  });
}

async function onPickup(env:Env,c:Ctx,tid:number){
  const t=await tradeFor(env,c,tid);
  if(typeof t==="string") return reply(t);
  if((t.status!==PAID&&t.status!==CLOSED)||!t.payout_link_enc) return reply("受け取れる代金はありません。");
  if(c.userId!==t.payout_target) return reply("この代金の受取人ではありません。");
  const link=await dec(env,t.payout_link_enc);
  if(t.status===PAID){
    // 受け取り忘れに備えて、削除までは猶予を置く
    await closeTrade(env,c.settings,t,"代金の受け渡しが完了しました。ご利用ありがとうございました。");
  }
  return reply(`**${yen(t.payout_amount)}** の送金リンクです。PayPayで受け取ってください。\n||${link}||\n※このメッセージはあなたにしか見えていません。`);
}

async function closeTrade(env:Env,settings:MediationSettings,t:Trade,message:string){
  const minutes=settings.closeDeleteMinutes;
  await updateTrade(env,t.id,{status:CLOSED,delete_at:scheduleDelete(minutes*60)});
  await trySend(env,t.channel_id,{embeds:[embed("取引終了",`${message}\nこのチャンネルは約${minutes}分後に削除されます（ログは運営が保管します）。`,COLOR.green)]});
}

// ---- 運営の実績 ----------------------------------------------------------------
async function postResult(env:Env,settings:MediationSettings,t:Trade){
  if(!settings.resultChannelId) return;
  await markResultDirty(env,t.guild_id);
  if(!settings.resultPostEnabled) return;
  const count=await completedCount(env,t.guild_id);
  await send(env,settings.resultChannelId,{
    content:`<@${t.buyer_id}> <@${t.seller_id}>`,
    embeds:[embed("🤝 取引完了","ご利用ありがとうございました！",COLOR.green,{
      fields:[{name:"買い手",value:`<@${t.buyer_id}>`,inline:true},{name:"売り手",value:`<@${t.seller_id}>`,inline:true}],
      footer:{text:`取引 ${no(t)}｜仲介実績 ${count} 件目`},
      timestamp:new Date().toISOString()
    })]
  });
}

function resultChannelName(settings:MediationSettings,count:number){
  return `${settings.resultChannelBase}ー実績${count}件`.slice(0,100);
}

// ---- スタッフ操作 --------------------------------------------------------------
async function onStaff(env:Env,c:Ctx,action:string,tid:number){
  if(!isStaff(c.member,c.settings)) return reply("スタッフのみ操作できます。");
  const t=await getTrade(env,tid);
  if(!t||t.guild_id!==c.guildId) return reply("取引が見つかりません。");
  const wrong=()=>reply("この取引は現在その操作ができる状態ではありません。");
  const settings=c.settings;
  switch(action){
    case "confirm":
      if(!await transition(env,tid,[CONFIRMING],TRADING)) return wrong();
      await markStaffDone(env,c,"運営で預かり完了");
      await startTrading(env,t);
      return reply("預かり完了にしました。");
    case "reject":{
      if(!await transition(env,tid,[CONFIRMING],PAYMENT,{paylink_enc:null,passcode_enc:null})) return wrong();
      await markStaffDone(env,c,"差し戻し");
      await trySend(env,t.channel_id,{
        content:`<@${t.buyer_id}>`,
        embeds:[embed("送金リンクを確認できませんでした",`リンクが無効か、金額（${yen(t.amount)}）が違う可能性があります。作り直して再提出してください。`,COLOR.orange)],
        components:paymentMessage(t).components
      });
      return reply("差し戻しました。");
    }
    case "payseller":
    case "refund":
      // 押し間違いを防ぐため、確認を出してから実行する（スタッフ通知のメッセージは実行時に「処理済み」へ書き換える）
      return staffPaymentConfirm(t,action,String(c.interaction.message?.id??"0"));
    case "feeok":
      if(!await transition(env,tid,[FEE_RECEIVING],AMOUNT)) return wrong();
      await markStaffDone(env,c,"仲介費の受け取り完了");
      await startAmount(env,settings,tid);
      return reply("仲介費の受け取り完了にしました。");
    case "feeng":
      if(!await transition(env,tid,[FEE_RECEIVING],FEE,{
        fee_choice_a:null,fee_choice_b:null,fee_paid_a:null,fee_paid_b:null,
        fee_link_a_enc:null,fee_pass_a_enc:null,fee_link_b_enc:null,fee_pass_b_enc:null
      })) return wrong();
      await markStaffDone(env,c,"仲介費の差し戻し");
      await trySend(env,t.channel_id,{
        embeds:[embed("仲介費を受け取れませんでした","送金リンクが無効か、金額が違う可能性があります。受け取り済みの分があればスタッフが返金します。\nリンクを作り直して、もう一度選んでください。",COLOR.orange)],
        components:feeMessage(t).components
      });
      return reply("差し戻しました。");
    case "done":
      // 自動支払いに失敗し、スタッフが手動で送金した場合
      if(!await transition(env,tid,[PAYOUT],CLOSED)) return wrong();
      await markStaffDone(env,c,"手動で支払い完了");
      await closeTrade(env,settings,t,"代金の支払いが完了しました。ご利用ありがとうございました。");
      return reply("支払い完了にしました。");
  }
  return reply("未対応の操作です。");
}

const STAFF_PAY_STATUSES=[TRADING,COMPLETE_PENDING,DISPUTE];

function staffPaymentConfirm(t:Trade,action:string,originMessageId:string){
  if(action!=="payseller"&&action!=="refund") return reply("未対応の操作です。");
  if(!STAFF_PAY_STATUSES.includes(t.status)){
    return reply("この取引は現在、支払い・返金できる状態ではありません（受け渡し中か通報中の取引だけが対象です）。");
  }
  const toSeller=action==="payseller";
  const target=toSeller?t.seller_id:t.buyer_id;
  return reply(
    `取引 ${no(t)}：${toSeller?"売り手":"買い手"} <@${target}> さんに **${yen(t.amount)}** を${toSeller?"支払います":"返金します"}。よろしいですか？\n`+
    "実行すると送金リンクが作られ、取り消せません。",
    {components:[row(
      button(`md:payok:${action}:${/^\d+$/.test(originMessageId)?originMessageId:"0"}:${t.id}`,toSeller?"売り手に支払う":"買い手に返金する",toSeller?1:4),
      button(`md:opcancel:${t.id}`,"キャンセル",2)
    )],allowed_mentions:{parse:[]}}
  );
}

/** スタッフ用 /payment（取引チャンネルで使う） */
async function onPaymentCommand(env:Env,c:Ctx){
  if(!isStaff(c.member,c.settings)) return reply("このコマンドはスタッフだけが使えます。");
  const t=await tradeFor(env,c,null,false);
  if(typeof t==="string") return reply(t+"\n取引チャンネルの中で実行してください。");
  const action=String((c.interaction.data?.options??[]).find((o:any)=>o.name==="action")?.value??"");
  return staffPaymentConfirm(t,action,"0");
}

async function onStaffPaymentConfirmed(env:Env,c:Ctx,action:string,originMessageId:string,tid:number){
  if(!isStaff(c.member,c.settings)) return reply("スタッフのみ操作できます。",{components:[]});
  if(action!=="payseller"&&action!=="refund") return reply("未対応の操作です。",{components:[]});
  const t=await getTrade(env,tid);
  if(!t||t.guild_id!==c.guildId) return reply("取引が見つかりません。",{components:[]});
  if(!await transition(env,tid,STAFF_PAY_STATUSES,PAYOUT,{complete_requester:null,complete_requested_at:null})){
    return reply("この取引はすでに処理されているか、支払い・返金できる状態ではありません。",{components:[]});
  }
  const toSeller=action==="payseller";
  const who=String(c.member?.user?.username??c.userId);
  if(originMessageId!=="0"&&c.interaction.channel_id){
    await markStaffMessageDone(env,String(c.interaction.channel_id),originMessageId,toSeller?"売り手へ支払い":"買い手へ返金",c.userId);
  }
  await trySend(env,t.channel_id,{embeds:[embed("スタッフの判断",
    toSeller?`売り手 <@${t.seller_id}> さんへ支払うと判断しました。`:`買い手 <@${t.buyer_id}> さんへ返金すると判断しました。`)]});
  await payout(env,c.settings,tid,toSeller?t.seller_id!:t.buyer_id!,`スタッフ判断→${toSeller?"売り手へ支払い":"買い手へ返金"}（${who}）`);
  return reply(toSeller?"売り手への支払いを実行しました。":"買い手への返金を実行しました。",{components:[]});
}

async function markStaffMessageDone(env:Env,channelId:string,messageId:string,note:string,userId:string){
  try{
    const message=await botJson<any>(env,`/channels/${channelId}/messages/${messageId}`);
    await editStaffMessage(env,channelId,message,note,userId);
  }catch(error){ console.error("mediation staff message lookup failed",error); }
}

async function markStaffDone(env:Env,c:Ctx,note:string){
  const message=c.interaction.message;
  if(!message?.id||!c.interaction.channel_id) return;
  await editStaffMessage(env,String(c.interaction.channel_id),message,note,c.userId);
}

async function editStaffMessage(env:Env,channelId:string,message:any,note:string,userId:string){
  const base=message?.embeds?.[0]??{};
  // 受け取った embed には送信できない読み取り専用の項目も含まれるので、必要な項目だけで作り直す
  const fields=[...(Array.isArray(base.fields)?base.fields:[]),{name:"処理",value:`${note}（<@${userId}>）`,inline:false}].slice(-25);
  const rebuilt={
    title:String(base.title??"処理済み").slice(0,256),
    ...(base.description?{description:String(base.description).slice(0,4096)}:{}),
    color:typeof base.color==="number"?base.color:COLOR.blurple,
    fields:fields.map((f:any)=>({name:String(f.name).slice(0,256),value:String(f.value).slice(0,1024),inline:Boolean(f.inline)}))
  };
  try{
    await botJson(env,`/channels/${channelId}/messages/${message.id}`,{
      method:"PATCH",body:JSON.stringify({embeds:[rebuilt],components:[]})
    });
  }catch(error){ console.error("mediation staff message edit failed",error); }
}

// ---- /check -------------------------------------------------------------------
async function onCheck(env:Env,c:Ctx){
  const option=(c.interaction.data?.options??[]).find((o:any)=>o.name==="member");
  const userId=String(option?.value??"");
  if(!userId) return reply("メンバーを指定してください。");
  const user=c.interaction.data?.resolved?.users?.[userId];
  const member=c.interaction.data?.resolved?.members?.[userId];
  const stats=await getStats(env,c.guildId,userId);
  const name=String(member?.nick??user?.global_name??user?.username??userId);
  const avatar=user?.avatar?`https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png?size=128`:undefined;
  return ires({type:4,data:{flags:64,embeds:[embed(`${name} さんの取引実績`,"",COLOR.teal,{
    ...(avatar?{thumbnail:{url:avatar}}:{}),
    fields:[{name:"買い手実績",value:`${stats.buyer} 件`,inline:true},{name:"売り手実績",value:`${stats.seller} 件`,inline:true}],
    footer:{text:"買い手の取引完了で正常に終わった取引の件数です"}
  })]}});
}

// ---- Interaction ルーティング --------------------------------------------------
export const MEDIATION_COMMANDS=[
  {name:"complete",description:"【買い手用】商品を受け取ったら取引を完了し、売り手に支払います（取引チャンネル内で使用）",type:1,dm_permission:false},
  {name:"report",description:"トラブルを通報し、取引を保留にします（取引チャンネル内で使用）",type:1,dm_permission:false},
  {name:"check",description:"メンバーの取引実績を確認します",type:1,dm_permission:false,options:[{type:6,name:"member",description:"実績を確認したいメンバー",required:true}]},
  {name:"payment",description:"【スタッフ用】取引の代金を売り手に支払う／買い手に返金する（取引チャンネル内で使用）",type:1,dm_permission:false,options:[
    {type:3,name:"action",description:"どちらに送金するか",required:true,choices:[
      {name:"売り手に支払い",value:"payseller"},
      {name:"買い手に返金",value:"refund"}
    ]}
  ]}
];

export function isMediationInteraction(interaction:any):boolean{
  if(interaction?.type===2) return MEDIATION_COMMANDS.some(c=>c.name===interaction?.data?.name);
  if(interaction?.type===3||interaction?.type===5) return String(interaction?.data?.custom_id??"").startsWith("md:");
  return false;
}

/** 応答を先に返して、裏で処理を続けるべきか（モーダルを開く操作は即答が必要） */
export function mediationShouldDefer(interaction:any):boolean{
  if(!isMediationInteraction(interaction)) return false;
  // スラッシュコマンドはどれも確認や一覧を返すだけなので即答する
  if(interaction.type===2) return false;
  if(interaction.type===5) return true;
  const id=String(interaction.data?.custom_id??"");
  if(id==="md:start"||id.startsWith("md:report:")||id.startsWith("md:rtype:")||id.startsWith("md:amount:")||id.startsWith("md:pay:")) return false;
  // 確認を出すだけ・取り消すだけの操作も即答する
  if(id.startsWith("md:complete:")||id.startsWith("md:opcancel:")) return false;
  if(id.startsWith("md:staff:payseller:")||id.startsWith("md:staff:refund:")) return false;
  if(id.startsWith("md:fee:")) return id.startsWith("md:fee:other:");
  return true;
}

/** 確認メッセージのボタンから実行する操作は、確認メッセージそのものを結果に書き換える（type 6） */
export function mediationDefersAsUpdate(interaction:any):boolean{
  const id=String(interaction?.data?.custom_id??"");
  return interaction?.type===3&&(id.startsWith("md:payok:")||id.startsWith("md:completeok:"));
}

function errorText(error:unknown){
  return (error instanceof Error?error.message:String(error)).replace(/`/g,"'").slice(0,300);
}

export async function handleMediationInteraction(interaction:any,env:Env):Promise<Response>{
  await ensureMediationSchema(env);
  const c=await ctxOf(env,interaction);
  if(!c) return reply("サーバー内でのみ使用できます。");

  if(interaction.type===2){
    const name=interaction.data?.name;
    if(name==="complete") return onComplete(env,c,null);
    if(name==="report") return onReportOpen(env,c,null);
    if(name==="check") return onCheck(env,c);
    if(name==="payment") return onPaymentCommand(env,c);
  }

  const id=String(interaction.data?.custom_id??"");
  const parts=id.split(":");
  const tail=Number(parts[parts.length-1]);
  const tid=Number.isSafeInteger(tail)&&tail>0?tail:0;

  if(interaction.type===3){
    if(id==="md:start") return onStart(env,c);
    if(id==="md:partner") return onPartner(env,c);
    if(!tid) return reply("未対応の操作です。");
    switch(parts[1]){
      case "fee": return onFeeButton(env,c,parts[2]!,tid);
      case "cancel": return onCancel(env,c,tid);
      case "amount": return onAmountButton(env,c,tid);
      case "role": return onRole(env,c,parts[2]!,tid);
      case "pay": return onPayButton(env,c,tid);
      case "complete": return onComplete(env,c,tid);
      case "completeok": return onCompleteConfirmed(env,c,tid);
      case "payok": return onStaffPaymentConfirmed(env,c,parts[2]!,parts[3]!,tid);
      case "opcancel": return ires({type:7,data:{content:"キャンセルしました。",components:[]}});
      case "report": return onReportOpen(env,c,tid);
      case "rtype": return onReportType(env,c,tid);
      case "agree":{
        const g=await confirmGuard(env,c,tid);
        return g instanceof Response?g:agree(env,c,g);
      }
      case "continue": return onContinue(env,c,tid);
      case "pickup": return onPickup(env,c,tid);
      case "staff": return onStaff(env,c,parts[2]!,tid);
    }
  }
  if(interaction.type===5&&tid){
    switch(parts[1]){
      case "feem": return onFeeModal(env,c,parts[2]!,tid);
      case "amountm": return onAmountModal(env,c,tid);
      case "paym": return onPayModal(env,c,tid);
      case "reportm": return onReportModal(env,c,Number(parts[2]),tid);
    }
  }
  return reply("未対応の操作です。");
}

// ---- Cron ---------------------------------------------------------------------
async function saveTranscript(env:Env,settings:MediationSettings,t:Trade){
  if(!settings.logChannelId||!t.channel_id) return;
  const messages:any[]=[];
  let after="0";
  for(let page=0;page<50;page++){
    const batch=await botJson<any[]>(env,`/channels/${t.channel_id}/messages?limit=100&after=${after}`);
    if(!batch.length) break;
    messages.push(...batch);
    after=batch.map(m=>BigInt(m.id)).reduce((a,b)=>a>b?a:b).toString();
    if(batch.length<100) break;
  }
  messages.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
  const jst=(iso:string)=>new Date(Date.parse(iso)+9*3600_000).toISOString().slice(0,19).replace("T"," ");
  const lines=[
    `取引 ${no(t)}  金額: ${yen(t.amount)}  買い手: ${t.buyer_id??"-"}  売り手: ${t.seller_id??"-"}`,
    `ステータス: ${t.status}  判断: ${t.decision??"-"}  報告理由: ${t.report_reason??"-"}`,
    `支払先: ${t.payout_target??"-"}  支払額: ${t.payout_amount??"-"}  仲介費: ${yen((t.fee_paid_a??0)+(t.fee_paid_b??0))}`,
    "-".repeat(60)
  ];
  // DiscordのファイルURLは期限切れになるので、小さな添付ファイルはログチャンネルに再アップロードしておく
  const files:Array<{name:string;blob:Blob}>=[];
  let totalBytes=0;
  for(const m of messages){
    let body=String(m.content??"");
    for(const e of m.embeds??[]) body+=` [embed] ${e.title??""} ${e.description??""}`;
    for(const a of m.attachments??[]){
      const size=Number(a.size??0);
      if(files.length<9&&totalBytes+size<=8*1024*1024){
        try{
          const res=await fetch(a.url);
          if(res.ok){
            const name=`${m.id}_${String(a.filename??"file")}`.slice(0,100);
            files.push({name,blob:await res.blob()});
            totalBytes+=size;
            body+=` [file] ${name}`;
            continue;
          }
        }catch{ /* fall through */ }
      }
      body+=` [file] ${a.url}`;
    }
    const author=m.author?`${m.author.username} (${m.author.id})`:"unknown";
    lines.push(`[${jst(m.timestamp)}] ${author}: ${body}`);
  }
  const form=new FormData();
  const filename=`trade-${String(t.number).padStart(4,"0")}.txt`;
  form.set("payload_json",JSON.stringify({content:`取引 ${no(t)} のログ（<#${t.channel_id}>）`,allowed_mentions:{parse:[]}}));
  form.set("files[0]",new File([lines.join("\n")],filename,{type:"text/plain;charset=utf-8"}));
  files.forEach((f,i)=>form.set(`files[${i+1}]`,new File([f.blob],f.name)));
  // botFetch はボディがあると Content-Type を application/json に固定するので、multipart は直接送る
  const res=await fetch(`https://discord.com/api/v10/channels/${settings.logChannelId}/messages`,{
    method:"POST",
    headers:{Authorization:`Bot ${env.DISCORD_BOT_TOKEN.trim()}`},
    body:form
  });
  if(!res.ok) throw new Error("transcript upload failed: "+res.status+" "+(await res.text().catch(()=>"")).slice(0,200));
}

export async function mediationSweep(env:Env){
  await ensureMediationSchema(env);
  const now=Date.now();
  const settingsCache=new Map<string,MediationSettings>();
  const settingsOf=async(guildId:string)=>{
    if(!settingsCache.has(guildId)) settingsCache.set(guildId,await getMediationSettings(env,guildId));
    return settingsCache.get(guildId)!;
  };

  // 完了申請への自動同意は廃止した（売り手が申請して放置すると、商品を渡さずに代金を受け取れてしまうため）。
  // 取引完了は買い手だけが実行し、買い手が完了しないときは売り手が /report で通報する。

  // 1b. PayPay処理の途中でWorkerが止まった取引を、スタッフに一度だけ知らせる
  for(const t of await listStuckTrades(env,now-15*60_000)){
    try{
      const s=await settingsOf(t.guild_id);
      const head=`チャンネル: <#${t.channel_id}>\n当事者: <@${t.user_a}> / <@${t.user_b}>　金額: ${yen(t.amount)}\n\n`;
      if(t.status===FEE_RECEIVING){
        await notifyStaff(env,s,`⚠️ 取引 ${no(t)}｜仲介費の受け取りが途中で止まっています`,
          head+"運営PayPayの受け取り履歴を確認し、受け取れていれば「仲介費の受け取り完了」、だめなら「仲介費の差し戻し」。",
          [["feeok",t.id],["feeng",t.id]],COLOR.gold);
      }else if(t.status===CONFIRMING){
        await notifyStaff(env,s,`⚠️ 取引 ${no(t)}｜代金の受け取りが途中で止まっています`,
          head+"運営PayPayの受け取り履歴を確認し、受け取れていれば「運営で預かり完了」、だめなら「差し戻し」。",
          [["confirm",t.id],["reject",t.id]],COLOR.gold);
      }else{
        const target=t.payout_target??t.seller_id;
        await notifyStaff(env,s,`⚠️ 取引 ${no(t)}｜支払いが途中で止まっています`,
          head+`支払先の候補: <@${target}>（${t.decision??"判断の記録なし"}）\n`+
          "送金リンクが作られていないか運営PayPayを確認し、手動で送金してから「支払い完了」を押してください。",
          [["done",t.id]]);
      }
    }catch(error){ console.error("mediation stuck alert failed",t.id,error); }
  }

  // 2. 終了・中止した取引チャンネルを、ログを保存してから削除する
  for(const t of await listDueDeletions(env,now)){
    try{
      const s=await settingsOf(t.guild_id);
      if(!t.transcript_saved){
        try{ await saveTranscript(env,s,t); }
        catch(error){
          if(error instanceof DiscordApiError&&error.status===404){
            await updateTrade(env,t.id,{channel_deleted:1,transcript_saved:1});
            continue;
          }
          console.error("mediation transcript failed",t.id,error);
          // 一時的な失敗でログを失わないよう、削除予定から30分までは5分ごとに保存をやり直す
          if(t.delete_at!==null&&now-t.delete_at<30*60_000){
            await updateTrade(env,t.id,{delete_at:now+5*60_000});
            continue;
          }
        }
        await updateTrade(env,t.id,{transcript_saved:1});
      }
      if(!await lease(env,t.guild_id,true)){
        await updateTrade(env,t.id,{delete_at:now+60_000});
        continue;
      }
      const res=await botFetch(env,`/channels/${t.channel_id}`,{method:"DELETE",headers:{"X-Audit-Log-Reason":"Mediation: trade finished"}});
      if(res.ok||res.status===404) await updateTrade(env,t.id,{channel_deleted:1});
      else{
        console.error("mediation channel delete failed",t.id,res.status);
        await updateTrade(env,t.id,{delete_at:now+5*60_000});
      }
    }catch(error){ console.error("mediation deletion failed",t.id,error); }
  }

  // 3. 実績チャンネルの名前を「仲介実績ー実績〇件」に更新する
  //    Discordはチャンネル名の変更を10分に2回までに制限しているので、5分以上あけて最新の件数で更新する
  for(const g of await listDirtyResultGuilds(env)){
    try{
      const s=normalizeMediationSettings(JSON.parse(g.settings_json));
      if(!s.resultChannelId||!s.resultRenameEnabled){ await setResultRenameState(env,g.guild_id,{dirty:false}); continue; }
      const name=resultChannelName(s,await completedCount(env,g.guild_id));
      if(name===g.result_renamed_name){ await setResultRenameState(env,g.guild_id,{dirty:false}); continue; }
      if(now-g.result_renamed_at<5*60_000+5_000) continue;
      await lease(env,g.guild_id);
      const res=await botFetch(env,`/channels/${s.resultChannelId}`,{
        method:"PATCH",headers:{"X-Audit-Log-Reason":"Mediation: result count"},body:JSON.stringify({name})
      });
      if(res.ok) await setResultRenameState(env,g.guild_id,{dirty:false,renamedAt:now,name});
      else if(res.status===429) continue;
      else{
        console.error("mediation result rename failed",g.guild_id,res.status);
        await setResultRenameState(env,g.guild_id,{dirty:res.status>=500,renamedAt:now,name:g.result_renamed_name});
      }
    }catch(error){ console.error("mediation result rename failed",g.guild_id,error); }
  }
}

// ---- 管理画面 API -----------------------------------------------------------------
async function requireDashboard(request:Request,env:Env,guildId:string){
  const auth=request.headers.get("Authorization");
  if(!auth?.startsWith("Bearer ")) throw new MediationHttpError(401,"ログインが必要です");
  const row=await getDashboardSession(env,await sha256Hex(auth.slice(7).trim()));
  if(!row) throw new MediationHttpError(401,"セッションが失効しています");
  await botJson(env,`/guilds/${guildId}`);
}

async function body<T>(request:Request):Promise<T>{
  try{ return await request.json() as T; }
  catch{ throw new MediationHttpError(400,"リクエストの形式が不正です"); }
}

export async function handleMediationApi(
  request:Request,env:Env,url:URL,hooks:{registerCommands:()=>Promise<void>}
):Promise<Response|null>{
  const m=url.pathname.match(/^\/api\/guilds\/(\d+)\/mediation(?:\/(.*))?$/);
  if(!m) return null;
  const guildId=m[1]!,sub=m[2]??"";
  await ensureMediationSchema(env);
  await requireDashboard(request,env,guildId);

  if(sub===""&&request.method==="GET"){
    const account=await payAccount(env,guildId).catch(()=>null);
    return json(env,{
      settings:await getMediationSettings(env,guildId),
      paypay:{registered:Boolean(account)},
      summary:await guildSummary(env,guildId),
      trades:await listRecentTrades(env,guildId,30)
    });
  }

  if(sub==="settings"&&request.method==="PUT"){
    const current=await getMediationSettings(env,guildId);
    const next=normalizeMediationSettings(await body<any>(request),current);
    // パネルの場所は設置APIだけが変える
    next.panelChannelId=current.panelChannelId;
    next.panelMessageId=current.panelMessageId;
    await saveMediationSettings(env,guildId,next);
    return json(env,{settings:next});
  }

  if(sub==="panel"&&request.method==="POST"){
    const b=await body<{channelId?:string}>(request);
    const channelId=String(b.channelId??"");
    if(!/^\d{15,22}$/.test(channelId)) throw new MediationHttpError(400,"パネルを設置するチャンネルを選んでください");
    const settings=await getMediationSettings(env,guildId);
    const message=await send(env,channelId,panelPayload(settings));
    settings.panelChannelId=channelId;
    settings.panelMessageId=message.id;
    await saveMediationSettings(env,guildId,settings);
    let commandWarning:string|null=null;
    try{ await hooks.registerCommands(); }
    catch(error){ console.error("mediation command registration failed",error); commandWarning="スラッシュコマンドの登録に失敗しました。サーバー管理タブからコマンドを再登録してください。"; }
    return json(env,{ok:true,settings,messageUrl:`https://discord.com/channels/${guildId}/${channelId}/${message.id}`,warning:commandWarning});
  }

  if(sub==="panel/update"&&request.method==="POST"){
    const settings=await getMediationSettings(env,guildId);
    if(!settings.panelChannelId||!settings.panelMessageId) throw new MediationHttpError(404,"まだパネルを設置していません");
    try{
      await botJson(env,`/channels/${settings.panelChannelId}/messages/${settings.panelMessageId}`,{
        method:"PATCH",body:JSON.stringify(panelPayload(settings))
      });
    }catch(error){
      if(error instanceof DiscordApiError&&error.status===404){
        throw new MediationHttpError(404,"設置済みのパネルが見つかりません。もう一度設置してください");
      }
      throw error;
    }
    return json(env,{ok:true});
  }

  if(sub==="result/sync"&&request.method==="POST"){
    await markResultDirty(env,guildId);
    return json(env,{ok:true});
  }

  if(sub==="paypay/login/start"&&request.method==="POST"){
    await ensureVendingSchema(env);
    const b=await body<{phone?:string;password?:string}>(request);
    const phone=String(b.phone??"").trim(),password=String(b.password??"");
    if(!phone||!password) throw new MediationHttpError(400,"電話番号とパスワードを入力してください");
    const uuid=randomId();
    const result:any=await payPayLoginStart(phone,password,uuid);
    if(result?.response_type==="ErrorResponse") throw new MediationHttpError(400,"PayPayログイン情報が一致しません");
    if(!result?.otp_reference_id||!result?.otp_prefix) throw new MediationHttpError(502,"PayPay OTP開始に失敗しました");
    const challengeId=await savePayChallenge(env,payOwner(guildId),JSON.stringify({phone,password,uuid,otpReferenceId:result.otp_reference_id,otpPrefix:result.otp_prefix}),env.SESSION_ENCRYPTION_KEY);
    return json(env,{challengeId,otpPrefix:result.otp_prefix});
  }

  if(sub==="paypay/login/verify"&&request.method==="POST"){
    await ensureVendingSchema(env);
    const b=await body<{challengeId?:string;otp?:string}>(request);
    const raw=await takePayChallenge(env,String(b.challengeId??""),payOwner(guildId),env.SESSION_ENCRYPTION_KEY);
    if(!raw) throw new MediationHttpError(410,"OTP認証が失効しました。もう一度ログインしてください");
    const p=JSON.parse(raw);
    const result:any=await payPayLoginOtp({uuid:p.uuid,otp:String(b.otp??"").trim(),otpReferenceId:p.otpReferenceId,otpPrefix:p.otpPrefix});
    if(result?.response_type==="ErrorResponse") throw new MediationHttpError(400,"OTPコードが正しくありません");
    await savePayPay(env,payOwner(guildId),p.phone,p.password,p.uuid,env.SESSION_ENCRYPTION_KEY);
    return json(env,{ok:true});
  }

  if(sub==="paypay/logout"&&request.method==="POST"){
    await ensureVendingSchema(env);
    await removePayPay(env,payOwner(guildId));
    return json(env,{ok:true});
  }

  return null;
}
