import type { Env, GuildSettings, PaymentRow, ProductRow, SessionRow } from "./types";
import {
  DEFAULT_SETTINGS,
  dashboardSessionStorageReady,
  cleanExpired,
  consumeChallenge,
  consumeOAuthState,
  createDashboardSession,
  createPayment,
  createProduct,
  createSession,
  deleteDashboardSession,
  deleteProduct,
  deleteSession,
  ensureSchema,
  getAuditCursor,
  getDashboardSession,
  getGuildSettings,
  getPaymentByMerchantId,
  getProduct,
  getSession,
  listAllGuildSettings,
  listPendingPayments,
  listProducts,
  markDelivered,
  putChallenge,
  putOAuthState,
  saveGuildSettings,
  setAuditCursor,
  setPaymentStatus
} from "./db";
import {
  DiscordApiError,
  botFetch,
  botJson,
  canManageGuild,
  exchangeCode,
  oauthAuthorizeUrl,
  syncAutoMod,
  userJson,
  validAccessToken,
  verifyInteraction,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordRole,
  type DiscordUser
} from "./discord";
import { createPayPayQr, getPayPayStatus, payPayConfigured } from "./paypay";
import {
  handleVendingApi,
  handleVendingInteraction,
  vendingSweep,
  VendingHttpError
} from "./vending";
import {
  accountCreatedAt,
  challengeCode,
  corsHeaders,
  encrypt,
  json,
  parseCookie,
  randomId,
  randomToken,
  sha256Hex,
  snowflakeTime,
  withCors
} from "./utils";

const BOT_PERMISSIONS=(
  1024n|2048n|16384n|32768n|65536n|8192n|16n|268435456n|
  2n|4n|1099511627776n|128n
).toString();

const DANGEROUS_PERMISSION_MASK=
  8n|32n|16n|268435456n|536870912n|4n|2n;

class HttpError extends Error {
  constructor(public status:number,message:string){super(message);}
}

type DashboardActor={
  user_id:string;
  username:string;
  avatar:null;
};

async function sessionFromRequest(request:Request,env:Env):Promise<DashboardActor>{
  const auth=request.headers.get("Authorization");
  if(!auth?.startsWith("Bearer ")) throw new HttpError(401,"ログインが必要です");
  const raw=auth.slice(7).trim();
  const row=await getDashboardSession(env,await sha256Hex(raw));
  if(!row) throw new HttpError(401,"セッションが失効しています");
  return {user_id:"shared-dashboard",username:"共同管理者",avatar:null};
}

async function requireGuild(
  request:Request,env:Env,guildId:string,_requireBot=true
):Promise<{session:DashboardActor;guild:{id:string;name:string;icon:string|null}}>{
  const session=await sessionFromRequest(request,env);
  const guild=await botJson<{id:string;name:string;icon:string|null}>(env,`/guilds/${guildId}`);
  return {session,guild};
}

function bodyObject<T=Record<string,unknown>>(request:Request):Promise<T>{
  return request.json() as Promise<T>;
}

async function discordMeta(env:Env,guildId:string){
  let channels:DiscordChannel[];
  let roles:DiscordRole[];

  try{
    channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    throw new HttpError(502,"Discordチャンネル一覧の取得に失敗しました: "+detail.slice(0,220));
  }

  try{
    roles=await botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`);
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    throw new HttpError(502,"Discordロール一覧の取得に失敗しました: "+detail.slice(0,220));
  }

  return {
    channels:channels
      .filter(c=>[0,2,5,13,15,16].includes(c.type))
      .sort((a,b)=>(a.position??0)-(b.position??0))
      .map(c=>({
        id:c.id,
        name:c.name,
        type:
          c.type===2?"voice":
          c.type===5?"announcement":
          c.type===13?"stage":
          c.type===15?"forum":
          c.type===16?"media":"text",
        parentId:c.parent_id??null,
        topic:c.topic??"",
        position:c.position??0,
        permissionOverwrites:(c.permission_overwrites??[]).map(overwrite=>({
          id:overwrite.id,
          type:overwrite.type,
          allow:overwrite.allow,
          deny:overwrite.deny
        }))
      })),
    categories:channels
      .filter(c=>c.type===4)
      .sort((a,b)=>(a.position??0)-(b.position??0))
      .map(c=>({
        id:c.id,
        name:c.name,
        position:c.position??0
      })),
    roles:roles
      .filter(r=>!r.managed)
      .sort((a,b)=>b.position-a.position)
      .map(r=>({
        id:r.id,
        name:r.name,
        position:r.position,
        color:r.color??0,
        permissions:r.permissions,
        isEveryone:r.id===guildId
      }))
  };
}

async function sendMessage(env:Env,channelId:string,payload:unknown):Promise<void>{
  await botJson(env,`/channels/${channelId}/messages`,{
    method:"POST",
    body:JSON.stringify(payload)
  });
}

async function publishVerificationPanel(env:Env,guildId:string,channelId:string){
  await sendMessage(env,channelId,{
    embeds:[{
      title:"サーバー認証",
      description:"下のボタンから認証を完了してください。",
      color:5793266
    }],
    components:[{
      type:1,
      components:[{
        type:2,
        custom_id:`verify:start:${guildId}`,
        label:"認証する",
        style:3
      }]
    }]
  });
}

async function publishTicketPanel(env:Env,channelId:string){
  await sendMessage(env,channelId,{
    embeds:[{
      title:"サポート",
      description:"問い合わせ用チケットを作成します。",
      color:5793266
    }],
    components:[{
      type:1,
      components:[{
        type:2,
        custom_id:"ticket:create",
        label:"チケットを作成",
        style:1
      }]
    }]
  });
}

async function requireMessageChannel(env:Env,guildId:string,channelId:string):Promise<void>{
  if(!/^\d+$/.test(channelId)) throw new HttpError(400,"設置先チャンネルが不正です");
  const channel=await botJson<{id:string;guild_id?:string;type:number}>(env,`/channels/${channelId}`);
  if(channel.guild_id&&channel.guild_id!==guildId){
    throw new HttpError(400,"別サーバーのチャンネルには設置できません");
  }
  if(![0,5].includes(channel.type)){
    throw new HttpError(400,"Ticketパネルはテキストまたはアナウンスチャンネルに設置してください");
  }
}

async function publishProductPanel(env:Env,channelId:string,product:ProductRow){
  await sendMessage(env,channelId,{
    embeds:[{
      title:product.name,
      description:product.description||"購入ボタンからPayPay決済へ進めます。",
      color:443221,
      fields:[{name:"価格",value:`¥${product.price_yen.toLocaleString("ja-JP")}`}]
    }],
    components:[{
      type:1,
      components:[{
        type:2,
        custom_id:`buy:${product.id}`,
        label:"PayPayで購入",
        style:3
      }]
    }]
  });
}

async function ensureRole(env:Env,guildId:string,name:string,permissions="0"):Promise<DiscordRole>{
  const roles=await botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`);
  const existing=roles.find(r=>r.name===name);
  if(existing) return existing;
  return botJson(env,`/guilds/${guildId}/roles`,{
    method:"POST",
    body:JSON.stringify({name,permissions})
  });
}

async function ensureCategory(env:Env,guildId:string,name:string):Promise<DiscordChannel>{
  const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  const existing=channels.find(c=>c.type===4&&c.name===name);
  if(existing) return existing;
  return botJson(env,`/guilds/${guildId}/channels`,{
    method:"POST",body:JSON.stringify({name,type:4})
  });
}

async function ensureText(
  env:Env,guildId:string,name:string,parentId:string,
  options?:{readOnly?:boolean;privateRoleId?:string}
):Promise<void>{
  const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  if(channels.some(c=>c.type===0&&c.name===name&&c.parent_id===parentId)) return;
  const overwrites:Array<Record<string,unknown>>=[];
  if(options?.readOnly){
    overwrites.push({id:guildId,type:0,deny:"2048"});
  }
  if(options?.privateRoleId){
    overwrites.push(
      {id:guildId,type:0,deny:"1024"},
      {id:options.privateRoleId,type:0,allow:(1024n|2048n|65536n).toString()}
    );
  }
  await botJson(env,`/guilds/${guildId}/channels`,{
    method:"POST",
    body:JSON.stringify({
      name,type:0,parent_id:parentId,
      permission_overwrites:overwrites
    })
  });
}

async function applyTemplate(env:Env,guildId:string,template:string){
  if(template==="community"){
    const verified=await ensureRole(env,guildId,"Verified");
    const moderator=await ensureRole(env,guildId,"Moderator",(8192n|1099511627776n|2n).toString());
    const start=await ensureCategory(env,guildId,"START HERE");
    const community=await ensureCategory(env,guildId,"COMMUNITY");
    const staff=await ensureCategory(env,guildId,"STAFF");
    await ensureText(env,guildId,"welcome",start.id,{readOnly:true});
    await ensureText(env,guildId,"rules",start.id,{readOnly:true});
    await ensureText(env,guildId,"general",community.id);
    await ensureText(env,guildId,"media",community.id);
    await ensureText(env,guildId,"staff-chat",staff.id,{privateRoleId:moderator.id});
    await saveGuildSettings(env,guildId,{verifiedRoleId:verified.id});
    return;
  }
  if(template==="shop"){
    await ensureRole(env,guildId,"Customer");
    const support=await ensureRole(env,guildId,"Support",(8192n|1099511627776n).toString());
    const shop=await ensureCategory(env,guildId,"SHOP");
    const help=await ensureCategory(env,guildId,"SUPPORT");
    await ensureText(env,guildId,"announcements",shop.id,{readOnly:true});
    await ensureText(env,guildId,"products",shop.id,{readOnly:true});
    await ensureText(env,guildId,"orders",shop.id);
    await ensureText(env,guildId,"open-ticket",help.id);
    await ensureText(env,guildId,"support-staff",help.id,{privateRoleId:support.id});
    return;
  }
  const support=await ensureRole(env,guildId,"Support",(8192n|1099511627776n).toString());
  const category=await ensureCategory(env,guildId,"SUPPORT");
  await ensureText(env,guildId,"faq",category.id,{readOnly:true});
  await ensureText(env,guildId,"open-ticket",category.id);
  await ensureText(env,guildId,"staff-support",category.id,{privateRoleId:support.id});
}

function interactionResponse(data:unknown):Response{
  return new Response(JSON.stringify(data),{
    headers:{"Content-Type":"application/json"}
  });
}

function ephemeral(content:string,components?:unknown[]){
  return {
    type:4,
    data:{
      content,
      flags:64,
      ...(components?{components}:{})
    }
  };
}

async function deliverPayment(env:Env,payment:PaymentRow):Promise<void>{
  if(payment.delivered_at) return;
  const product=await getProduct(env,payment.product_id);
  if(!product) throw new Error("Product missing");
  if(product.delivery_type==="role"){
    if(!product.role_id) throw new Error("Role product misconfigured");
    await botJson(env,`/guilds/${payment.guild_id}/members/${payment.user_id}/roles/${product.role_id}`,{
      method:"PUT"
    });
  }else{
    if(!product.delivery_text) throw new Error("Text product misconfigured");
    const dm=await botJson<{id:string}>(env,"/users/@me/channels",{
      method:"POST",
      body:JSON.stringify({recipient_id:payment.user_id})
    });
    await sendMessage(env,dm.id,{
      content:`「${product.name}」の購入ありがとうございます。\n\n${product.delivery_text}`
    });
  }
  await markDelivered(env,payment.id);
}

async function confirmAndDeliver(env:Env,payment:PaymentRow):Promise<void>{
  const status=await getPayPayStatus(env,payment.merchant_payment_id);
  await setPaymentStatus(env,payment.id,status);
  if(status==="COMPLETED") await deliverPayment(env,{...payment,status});
}

async function createTicketFromInteraction(env:Env,interaction:any):Promise<Response>{
  const guildId=interaction.guild_id as string;
  const userId=interaction.member?.user?.id as string;
  const username=(interaction.member?.user?.username as string)||userId.slice(-6);
  const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
  const topic=`dsm-ticket:${userId}`;
  const existing=channels.find(c=>c.type===0&&c.topic===topic);
  if(existing) return interactionResponse(ephemeral(`既にチケットがあります: <#${existing.id}>`));
  const [roles,settings]=await Promise.all([
    botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`),
    getGuildSettings(env,guildId)
  ]);
  const configuredIds=settings.ticketSupportRoleIds??[];
  const supportRoles=configuredIds.length
    ?roles.filter(role=>configuredIds.includes(role.id))
    :roles.filter(role=>role.name==="Support").slice(0,1);
  const safe=username.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,18)||userId.slice(-6);
  const overwrites:Array<Record<string,unknown>>=[
    {id:guildId,type:0,deny:"1024"},
    {id:userId,type:1,allow:(1024n|2048n|65536n|32768n).toString()}
  ];
  for(const role of supportRoles){
    overwrites.push({
      id:role.id,
      type:0,
      allow:(1024n|2048n|65536n|32768n).toString()
    });
  }
  const channel=await botJson<DiscordChannel>(env,`/guilds/${guildId}/channels`,{
    method:"POST",
    body:JSON.stringify({
      name:`ticket-${safe}`,
      type:0,
      topic,
      permission_overwrites:overwrites
    })
  });
  await sendMessage(env,channel.id,{
    content:`<@${userId}> サポート担当者が対応します。${supportRoles.length?" 対応者ロール: "+supportRoles.map(role=>"@"+role.name).join(" / "):""}`,
    components:[{
      type:1,
      components:[{type:2,custom_id:"ticket:close",label:"チケットを閉じる",style:4}]
    }]
  });
  return interactionResponse(ephemeral(`作成しました: <#${channel.id}>`));
}

async function handleInteraction(
  request:Request,env:Env,ctx:ExecutionContext
):Promise<Response>{
  const text=await request.text();
  if(!(await verifyInteraction(env,request,text))) return new Response("invalid signature",{status:401});
  const interaction=JSON.parse(text) as any;
  if(interaction.type===1) return interactionResponse({type:1});

  await ensureSchema(env);
  const vendingResponse=await handleVendingInteraction(interaction,env,ctx);
  if(vendingResponse) return vendingResponse;

  if(interaction.type===2){
    const name=interaction.data?.name;
    if(name==="dashboard") return interactionResponse(ephemeral(`管理画面: ${env.WEB_PUBLIC_URL}`));
    if(name==="security-status"&&interaction.guild_id){
      const s=await getGuildSettings(env,interaction.guild_id);
      return interactionResponse(ephemeral(
        `Security: ${s.securityEnabled?"ON":"OFF"}\nAutoMod Spam: ${s.antiSpam?"ON":"OFF"}\nAnti-Nuke: ${s.antiNuke?"ON":"OFF"}`
      ));
    }
    return interactionResponse(ephemeral("このコマンドは管理画面から操作してください。"));
  }

  if(interaction.type===3){
    const id=interaction.data?.custom_id as string;
    if(id?.startsWith("verify:start:")){
      const guildId=id.split(":")[2]!;
      const challengeId=randomId();
      const code=challengeCode();
      await putChallenge(env,challengeId,guildId,interaction.member.user.id,code);
      return interactionResponse(ephemeral(
        `下の確認コードを入力してください。5分で失効します。\n\n**${code.split("").join("  ")}**`,
        [{
          type:1,
          components:[{
            type:2,custom_id:`verify:answer:${challengeId}`,
            label:"コードを入力",style:1
          }]
        }]
      ));
    }
    if(id?.startsWith("verify:answer:")){
      const challengeId=id.split(":")[2]!;
      return interactionResponse({
        type:9,
        data:{
          custom_id:`verify:modal:${challengeId}`,
          title:"サーバー認証",
          components:[{
            type:1,
            components:[{
              type:4,
              custom_id:"code",
              label:"確認コード",
              style:1,
              min_length:6,
              max_length:6,
              required:true
            }]
          }]
        }
      });
    }
    if(id==="ticket:create") return createTicketFromInteraction(env,interaction);
    if(id==="ticket:close"){
      const channelId=interaction.channel_id as string;
      ctx.waitUntil(botFetch(env,`/channels/${channelId}`,{method:"DELETE"}).then(()=>undefined));
      return interactionResponse(ephemeral("チケットを閉じます。"));
    }
    if(id?.startsWith("buy:")){
      const product=await getProduct(env,id.slice(4));
      if(!product||!product.active||product.guild_id!==interaction.guild_id){
        return interactionResponse(ephemeral("この商品は現在購入できません。"));
      }
      if(!payPayConfigured(env)) return interactionResponse(ephemeral("PayPayがまだ設定されていません。"));
      const merchantPaymentId=`dsm_${Date.now()}_${randomToken(6).replace(/[^a-zA-Z0-9_-]/g,"")}`;
      const qr=await createPayPayQr(env,{
        merchantPaymentId,
        amountYen:product.price_yen,
        description:product.name
      });
      const payment:PaymentRow={
        id:randomId(),
        merchant_payment_id:merchantPaymentId,
        guild_id:interaction.guild_id,
        user_id:interaction.member.user.id,
        product_id:product.id,
        status:"CREATED",
        paypay_url:qr.url,
        amount_yen:product.price_yen,
        created_at:Date.now(),
        updated_at:Date.now(),
        delivered_at:null
      };
      await createPayment(env,payment);
      return interactionResponse(ephemeral(
        `**${product.name}** — ¥${product.price_yen.toLocaleString("ja-JP")}\n支払い完了後、自動で納品されます。`,
        [{
          type:1,
          components:[{type:2,style:5,label:"PayPayで支払う",url:qr.url}]
        }]
      ));
    }
  }

  if(interaction.type===5){
    const id=interaction.data?.custom_id as string;
    if(id?.startsWith("verify:modal:")){
      const challengeId=id.split(":")[2]!;
      const challenge=await consumeChallenge(env,challengeId);
      if(!challenge||challenge.expires_at<Date.now()) return interactionResponse(ephemeral("認証が失効しています。"));
      if(challenge.user_id!==interaction.member.user.id||challenge.guild_id!==interaction.guild_id){
        return interactionResponse(ephemeral("認証情報が一致しません。"));
      }
      const answer=interaction.data.components?.[0]?.components?.[0]?.value?.trim()?.toUpperCase();
      if(answer!==challenge.code) return interactionResponse(ephemeral("コードが一致しません。"));
      const settings=await getGuildSettings(env,challenge.guild_id);
      if(!settings.verifiedRoleId) return interactionResponse(ephemeral("認証ロールが設定されていません。"));
      if(Date.now()-accountCreatedAt(challenge.user_id)<settings.minAccountAgeDays*86400000){
        return interactionResponse(ephemeral(
          `作成から${settings.minAccountAgeDays}日未満のアカウントは認証できません。`
        ));
      }
      await botJson(env,`/guilds/${challenge.guild_id}/members/${challenge.user_id}/roles/${settings.verifiedRoleId}`,{
        method:"PUT"
      });
      return interactionResponse(ephemeral("認証が完了しました。"));
    }
  }

  return interactionResponse(ephemeral("未対応の操作です。"));
}

async function registerCommands(env:Env):Promise<void>{
  await botJson(env,`/applications/${env.DISCORD_APPLICATION_ID}/commands`,{
    method:"PUT",
    body:JSON.stringify([
      {name:"dashboard",description:"管理ダッシュボードを開きます",type:1},
      {name:"security-status",description:"セキュリティ設定を表示します",type:1}
    ])
  });
}

async function handleDashboardLogin(request:Request,env:Env):Promise<Response>{
  if(!env.DASHBOARD_PASSWORD) throw new HttpError(503,"管理画面パスワードが未設定です");
  const input=await bodyObject<{password?:string}>(request);
  const password=String(input.password??"");
  if(!password) throw new HttpError(400,"パスワードを入力してください");
  const [actual,expected]=await Promise.all([
    sha256Hex(password),
    sha256Hex(env.DASHBOARD_PASSWORD)
  ]);
  if(actual!==expected) throw new HttpError(401,"パスワードが違います");
  const rawSession=randomToken(32);
  const expiresAt=Date.now()+30*24*60*60_000;
  try{
    await createDashboardSession(env,await sha256Hex(rawSession),expiresAt);
  }catch(error){
    console.error("dashboard session creation failed",error);
    throw new HttpError(500,"管理セッションの保存に失敗しました");
  }
  return json(env,{token:rawSession,expiresAt});
}

async function handleApi(request:Request,env:Env,url:URL):Promise<Response>{
  if(url.pathname==="/api/status"&&request.method==="GET"){
    let discordReady=false;
    let discordUser:string|null=null;
    let discordError:string|null=null;
    try{
      const bot=await botJson<{id:string;username:string}>(env,"/users/@me");
      discordReady=true;
      discordUser=bot.username;
    }catch(error){
      discordError=error instanceof Error?error.message:String(error);
    }
    return json(env,{
      discordReady,
      discordUser,
      discordError,
      guildCount:null,
      dashboardPasswordConfigured:Boolean(env.DASHBOARD_PASSWORD),
      payPayConfigured:payPayConfigured(env),
      payPayEnvironment:env.PAYPAY_ENV,
      runtime:"cloudflare-workers",
      inviteUrl:
        `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APPLICATION_ID}`+
        `&permissions=${BOT_PERMISSIONS}&integration_type=0&scope=bot%20applications.commands`
    });
  }

  if(url.pathname==="/api/me"&&request.method==="GET"){
    const s=await sessionFromRequest(request,env);
    return json(env,{id:s.user_id,username:s.username,avatar:s.avatar});
  }

  if(url.pathname==="/api/logout"&&request.method==="POST"){
    const auth=request.headers.get("Authorization");
    if(auth?.startsWith("Bearer ")) await deleteDashboardSession(env,await sha256Hex(auth.slice(7).trim()));
    return json(env,{ok:true});
  }

  if(url.pathname==="/api/commands/register"&&request.method==="POST"){
    await sessionFromRequest(request,env);
    await registerCommands(env);
    return json(env,{ok:true});
  }

  if(url.pathname==="/api/guilds"&&request.method==="GET"){
    await sessionFromRequest(request,env);
    try{
      const guilds=await botJson<Array<{id:string;name:string;icon:string|null}>>(
        env,"/users/@me/guilds?limit=200"
      );
      return json(env,guilds.map(guild=>({
        id:guild.id,
        name:guild.name,
        icon:guild.icon,
        botInstalled:true
      })));
    }catch(error){
      console.error("bot guild list failed",error);
      const detail=error instanceof Error?error.message:"unknown";
      throw new HttpError(502,"BOT参加サーバー一覧の取得に失敗しました: "+detail.slice(0,160));
    }
  }

  const meta=url.pathname.match(/^\/api\/guilds\/(\d+)\/meta$/);
  if(meta&&request.method==="GET"){
    const guildId=meta[1]!;
    const {guild}=await requireGuild(request,env,guildId);
    return json(env,{...guild,...await discordMeta(env,guildId)});
  }

  const settingsMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/settings$/);
  if(settingsMatch){
    const guildId=settingsMatch[1]!;
    if(request.method==="GET"){
      await sessionFromRequest(request,env);
      return json(env,await getGuildSettings(env,guildId));
    }
    await requireGuild(request,env,guildId);
    if(request.method==="PUT"){
      const patch=await bodyObject<Partial<GuildSettings>>(request);
      const safe:Partial<GuildSettings>={...patch};
      if(safe.spamMax!==undefined) safe.spamMax=Math.max(2,Math.min(50,Number(safe.spamMax)));
      if(safe.mentionLimit!==undefined) safe.mentionLimit=Math.max(2,Math.min(50,Number(safe.mentionLimit)));
      if(safe.nukeActions!==undefined) safe.nukeActions=Math.max(2,Math.min(30,Number(safe.nukeActions)));
      if(safe.nukeWindowSeconds!==undefined) safe.nukeWindowSeconds=Math.max(5,Math.min(300,Number(safe.nukeWindowSeconds)));
      if(safe.ticketSupportRoleIds!==undefined){
        safe.ticketSupportRoleIds=[...new Set(
          safe.ticketSupportRoleIds
            .map(id=>String(id).trim())
            .filter(id=>/^\d+$/.test(id))
        )].slice(0,20);
      }
      const saved=await saveGuildSettings(env,guildId,safe);
      await syncAutoMod(env,guildId,saved);
      return json(env,saved);
    }
  }

  const channelsMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/channels$/);
  if(channelsMatch&&request.method==="POST"){
    const guildId=channelsMatch[1]!;
    await requireGuild(request,env,guildId);
    const input=await bodyObject<{name:string;type:"text"|"voice"|"category";parentId?:string|null;topic?:string}>(request);
    const name=input.name?.trim();
    if(!name||name.length>100) throw new HttpError(400,"チャンネル名が不正です");
    const created=await botJson<DiscordChannel>(env,`/guilds/${guildId}/channels`,{
      method:"POST",
      body:JSON.stringify(
        input.type==="category"
          ?{name,type:4}
          :input.type==="voice"
            ?{name,type:2,parent_id:input.parentId||undefined}
            :{name,type:0,parent_id:input.parentId||undefined,topic:input.topic||undefined}
      )
    });
    return json(env,{id:created.id,name:created.name,type:input.type});
  }

  const channelReorderMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/channels\/reorder$/);
  if(channelReorderMatch&&request.method==="PATCH"){
    const guildId=channelReorderMatch[1]!;
    await requireGuild(request,env,guildId);
    const input=await bodyObject<{
      id:string;
      targetId?:string|null;
      placement?:"before"|"after"|"start";
      parentId?:string|null;
      position?:number;
    }>(request);

    if(!/^\d+$/.test(input.id??"")) throw new HttpError(400,"並び替え対象が不正です");

    const channels=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
    const source=channels.find(channel=>channel.id===input.id);
    if(!source) throw new HttpError(404,"移動するチャンネルが見つかりません");

    // Keep the existing desktop category reorder behavior.
    if(source.type===4){
      if(!Number.isInteger(input.position)){
        throw new HttpError(400,"カテゴリの並び替え位置が不正です");
      }
      await botJson(env,`/guilds/${guildId}/channels`,{
        method:"PATCH",
        body:JSON.stringify([{id:source.id,position:input.position}])
      });
      return json(env,{ok:true,kind:"category"});
    }

    let destinationParent: string|null;
    let destinationIndex=0;
    let destinationSiblings:DiscordChannel[];

    if(input.targetId){
      const target=channels.find(channel=>channel.id===input.targetId);
      if(!target||target.type===4) throw new HttpError(400,"移動先チャンネルが不正です");
      if(target.id===source.id) return json(env,{ok:true,unchanged:true});

      destinationParent=target.parent_id??null;
      destinationSiblings=channels
        .filter(channel=>channel.type!==4&&channel.id!==source.id&&(channel.parent_id??null)===destinationParent)
        .sort((a,b)=>(a.position??0)-(b.position??0));

      const targetIndex=destinationSiblings.findIndex(channel=>channel.id===target.id);
      if(targetIndex<0) throw new HttpError(400,"移動先を判定できませんでした");
      destinationIndex=targetIndex+(input.placement==="after"?1:0);
    }else{
      destinationParent=input.parentId??null;
      if(destinationParent!==null){
        const category=channels.find(channel=>channel.id===destinationParent&&channel.type===4);
        if(!category) throw new HttpError(400,"移動先カテゴリが見つかりません");
      }
      destinationSiblings=channels
        .filter(channel=>channel.type!==4&&channel.id!==source.id&&(channel.parent_id??null)===destinationParent)
        .sort((a,b)=>(a.position??0)-(b.position??0));
      destinationIndex=input.placement==="start"?0:destinationSiblings.length;
    }

    destinationIndex=Math.max(0,Math.min(destinationIndex,destinationSiblings.length));
    const reordered=[...destinationSiblings];
    reordered.splice(destinationIndex,0,source);

    // Send the full destination sibling order instead of only one position.
    // Discord then has an unambiguous order even when moving across categories.
    const payload=reordered.map((channel,index)=>({
      id:channel.id,
      position:index,
      ...(channel.id===source.id
        ?{parent_id:destinationParent,lock_permissions:false}
        :{})
    }));

    await botJson(env,`/guilds/${guildId}/channels`,{
      method:"PATCH",
      body:JSON.stringify(payload)
    });

    // Read back from Discord and verify the move really stuck before reporting success.
    const confirmed=await botJson<DiscordChannel[]>(env,`/guilds/${guildId}/channels`);
    const confirmedSource=confirmed.find(channel=>channel.id===source.id);
    if(!confirmedSource||(confirmedSource.parent_id??null)!==destinationParent){
      throw new HttpError(502,"Discord側でカテゴリ移動を反映できませんでした");
    }

    const confirmedSiblings=confirmed
      .filter(channel=>channel.type!==4&&(channel.parent_id??null)===destinationParent)
      .sort((a,b)=>(a.position??0)-(b.position??0));
    const actualIndex=confirmedSiblings.findIndex(channel=>channel.id===source.id);
    const expectedPrevious=reordered[destinationIndex-1]?.id??null;
    const expectedNext=reordered[destinationIndex+1]?.id??null;
    const actualPrevious=actualIndex>0?confirmedSiblings[actualIndex-1]?.id??null:null;
    const actualNext=actualIndex>=0?confirmedSiblings[actualIndex+1]?.id??null:null;

    const orderMatches=
      actualIndex>=0&&
      (expectedPrevious===null||actualPrevious===expectedPrevious)&&
      (expectedNext===null||actualNext===expectedNext);

    if(!orderMatches){
      // One retry with a fresh canonical position list handles Discord's occasional
      // position normalization after a parent change.
      const retrySiblings=confirmedSiblings.filter(channel=>channel.id!==source.id);
      const retryIndex=Math.max(0,Math.min(destinationIndex,retrySiblings.length));
      retrySiblings.splice(retryIndex,0,confirmedSource);
      await botJson(env,`/guilds/${guildId}/channels`,{
        method:"PATCH",
        body:JSON.stringify(retrySiblings.map((channel,index)=>({
          id:channel.id,
          position:index,
          ...(channel.id===source.id
            ?{parent_id:destinationParent,lock_permissions:false}
            :{})
        })))
      });
    }

    return json(env,{
      ok:true,
      id:source.id,
      parentId:destinationParent,
      targetId:input.targetId??null,
      placement:input.targetId?(input.placement==="after"?"after":"before"):"start"
    });
  }

  const rolesCollectionMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/roles$/);
  if(rolesCollectionMatch&&request.method==="POST"){
    const guildId=rolesCollectionMatch[1]!;
    await requireGuild(request,env,guildId);
    const input=await bodyObject<{
      name?:string;
      color?:number;
      permissions?:string;
    }>(request);

    const name=String(input.name??"").trim();
    if(!name||name.length>100) throw new HttpError(400,"ロール名が不正です");

    const color=input.color===undefined?0:Number(input.color);
    if(!Number.isInteger(color)||color<0||color>0xFFFFFF){
      throw new HttpError(400,"ロール色が不正です");
    }

    let permissions="0";
    try{
      const parsed=BigInt(input.permissions??"0");
      if(parsed<0n) throw new Error();
      permissions=parsed.toString();
    }catch{
      throw new HttpError(400,"ロール権限が不正です");
    }

    try{
      const role=await botJson<DiscordRole>(env,`/guilds/${guildId}/roles`,{
        method:"POST",
        body:JSON.stringify({name,color,permissions})
      });
      return json(env,{
        id:role.id,
        name:role.name,
        position:role.position,
        color:role.color??0,
        permissions:role.permissions,
        isEveryone:false
      },201);
    }catch(error){
      if(error instanceof DiscordApiError&&error.status===403){
        throw new HttpError(
          403,
          "ロールを追加できません。BOTに「ロールの管理」権限があるか確認してください"
        );
      }
      throw error;
    }
  }

  const roleItemMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/roles\/(\d+)$/);
  if(roleItemMatch){
    const guildId=roleItemMatch[1]!;
    const roleId=roleItemMatch[2]!;
    await requireGuild(request,env,guildId);

    if(request.method==="PATCH"){
      const input=await bodyObject<{
        name?:string;
        color?:number;
        permissions?:string;
      }>(request);

      const payload:Record<string,unknown>={};
      if(input.permissions!==undefined){
        try{
          const parsed=BigInt(input.permissions);
          if(parsed<0n) throw new Error();
          payload.permissions=parsed.toString();
        }catch{
          throw new HttpError(400,"ロール権限が不正です");
        }
      }

      if(roleId===guildId){
        if(input.name!==undefined||input.color!==undefined){
          throw new HttpError(400,"@everyone は名前や色を変更できません");
        }
      }else{
        if(input.name!==undefined){
          const name=String(input.name).trim();
          if(!name||name.length>100) throw new HttpError(400,"ロール名が不正です");
          payload.name=name;
        }
        if(input.color!==undefined){
          const color=Number(input.color);
          if(!Number.isInteger(color)||color<0||color>0xFFFFFF){
            throw new HttpError(400,"ロール色が不正です");
          }
          payload.color=color;
        }
      }

      try{
        const role=await botJson<DiscordRole>(env,`/guilds/${guildId}/roles/${roleId}`,{
          method:"PATCH",
          body:JSON.stringify(payload)
        });
        return json(env,{
          id:role.id,
          name:role.name,
          position:role.position,
          color:role.color??0,
          permissions:role.permissions,
          isEveryone:role.id===guildId
        });
      }catch(error){
        if(error instanceof DiscordApiError&&error.status===403){
          throw new HttpError(
            403,
            "このロールを編集できません。BOTの「ロールの管理」権限、またはBOTより上にあるロールの並び順を確認してください"
          );
        }
        throw error;
      }
    }

    if(request.method==="DELETE"){
      if(roleId===guildId) throw new HttpError(400,"@everyone は削除できません");
      try{
        await botJson<void>(env,`/guilds/${guildId}/roles/${roleId}`,{
          method:"DELETE"
        });
        return json(env,{ok:true});
      }catch(error){
        if(error instanceof DiscordApiError&&error.status===403){
          throw new HttpError(
            403,
            "このロールを削除できません。BOTの「ロールの管理」権限、またはBOTより上にあるロールの並び順を確認してください"
          );
        }
        throw error;
      }
    }
  }

  const channelPermissionMatch=url.pathname.match(
    /^\/api\/guilds\/(\d+)\/channels\/(\d+)\/permissions\/(\d+)$/
  );
  if(channelPermissionMatch&&request.method==="PATCH"){
    const guildId=channelPermissionMatch[1]!;
    const channelId=channelPermissionMatch[2]!;
    const targetId=channelPermissionMatch[3]!;
    await requireGuild(request,env,guildId);

    const input=await bodyObject<{
      targetType?:"role";
      permissions?:Partial<Record<
        "view"|"send"|"react"|"files"|"threads"|"connect"|"speak",
        "inherit"|"allow"|"deny"
      >>;
    }>(request);

    const channel=await botJson<DiscordChannel>(env,`/channels/${channelId}`);
    if(channel.guild_id&&channel.guild_id!==guildId){
      throw new HttpError(400,"別サーバーのチャンネルは編集できません");
    }

    const permissionBits={
      view:1024n,
      send:2048n,
      react:64n,
      files:32768n,
      threads:34359738368n,
      connect:1048576n,
      speak:2097152n
    } as const;

    const current=(channel.permission_overwrites??[]).find(
      overwrite=>overwrite.id===targetId&&overwrite.type===0
    );
    let allow=BigInt(current?.allow??"0");
    let deny=BigInt(current?.deny??"0");

    for(const [key,mode] of Object.entries(input.permissions??{})){
      if(!(key in permissionBits)) continue;
      const bit=permissionBits[key as keyof typeof permissionBits];
      allow&=~bit;
      deny&=~bit;
      if(mode==="allow") allow|=bit;
      if(mode==="deny") deny|=bit;
    }

    if(allow===0n&&deny===0n){
      if(current){
        const response=await botFetch(
          env,
          `/channels/${channelId}/permissions/${targetId}`,
          {method:"DELETE"}
        );
        if(!response.ok){
          const detail=await response.text().catch(()=>"");
          throw new HttpError(
            response.status,
            "チャンネル権限の継承解除に失敗しました: "+detail.slice(0,180)
          );
        }
      }
    }else{
      await botJson(
        env,
        `/channels/${channelId}/permissions/${targetId}`,
        {
          method:"PUT",
          body:JSON.stringify({
            type:0,
            allow:allow.toString(),
            deny:deny.toString()
          })
        }
      );
    }

    return json(env,{
      ok:true,
      targetId,
      allow:allow.toString(),
      deny:deny.toString()
    });
  }

  const channelItemMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/channels\/(\d+)$/);
  if(channelItemMatch){
    const guildId=channelItemMatch[1]!;
    const channelId=channelItemMatch[2]!;
    await requireGuild(request,env,guildId);

    if(request.method==="PATCH"){
      const input=await bodyObject<{
        name?:string;
        topic?:string|null;
        parentId?:string|null;
      }>(request);
      const payload:Record<string,unknown>={};
      if(input.name!==undefined){
        const name=input.name.trim();
        if(!name||name.length>100) throw new HttpError(400,"チャンネル名が不正です");
        payload.name=name;
      }
      if(input.topic!==undefined) payload.topic=input.topic===null?null:String(input.topic).slice(0,1024);
      if(input.parentId!==undefined) payload.parent_id=input.parentId||null;
      const updated=await botJson<DiscordChannel>(env,`/channels/${channelId}`,{
        method:"PATCH",
        body:JSON.stringify(payload)
      });
      return json(env,{
        id:updated.id,
        name:updated.name,
        parentId:updated.parent_id??null,
        topic:updated.topic??"",
        position:updated.position??0
      });
    }

    if(request.method==="DELETE"){
      const response=await botFetch(env,`/channels/${channelId}`,{method:"DELETE"});
      if(!response.ok) throw new HttpError(response.status,"チャンネルを削除できませんでした");
      return json(env,{ok:true});
    }
  }

  const templateMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/templates\/(community|shop|support)$/);
  if(templateMatch&&request.method==="POST"){
    await requireGuild(request,env,templateMatch[1]!);
    await applyTemplate(env,templateMatch[1]!,templateMatch[2]!);
    return json(env,{ok:true});
  }

  const verifyPanel=url.pathname.match(/^\/api\/guilds\/(\d+)\/verification\/panel$/);
  if(verifyPanel&&request.method==="POST"){
    await requireGuild(request,env,verifyPanel[1]!);
    const {channelId}=await bodyObject<{channelId:string}>(request);
    await publishVerificationPanel(env,verifyPanel[1]!,channelId);
    return json(env,{ok:true});
  }

  const ticketPanel=url.pathname.match(/^\/api\/guilds\/(\d+)\/tickets\/panel$/);
  if(ticketPanel&&request.method==="POST"){
    const guildId=ticketPanel[1]!;
    await requireGuild(request,env,guildId);
    const {channelId}=await bodyObject<{channelId?:string}>(request);
    if(!channelId) throw new HttpError(400,"設置先チャンネルを選択してください");
    await requireMessageChannel(env,guildId,channelId);
    await publishTicketPanel(env,channelId);
    return json(env,{ok:true,channelId});
  }

  const productsMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/products$/);
  if(productsMatch){
    const guildId=productsMatch[1]!;
    if(request.method==="GET"){
      await sessionFromRequest(request,env);
      return json(env,await listProducts(env,guildId));
    }
    await requireGuild(request,env,guildId);
    if(request.method==="POST"){
      const input=await bodyObject<{
        name:string;description?:string;priceYen:number;
        deliveryType:"role"|"text";roleId?:string|null;deliveryText?:string|null;
      }>(request);
      if(!input.name?.trim()||input.name.length>80) throw new HttpError(400,"商品名が不正です");
      if(!Number.isInteger(input.priceYen)||input.priceYen<1||input.priceYen>1000000){
        throw new HttpError(400,"価格が不正です");
      }
      if(input.deliveryType==="role"&&!input.roleId) throw new HttpError(400,"付与ロールが必要です");
      if(input.deliveryType==="text"&&!input.deliveryText) throw new HttpError(400,"納品内容が必要です");
      const row:ProductRow={
        id:randomId(),guild_id:guildId,name:input.name.trim(),
        description:(input.description||"").slice(0,500),
        price_yen:input.priceYen,active:1,delivery_type:input.deliveryType,
        role_id:input.roleId||null,delivery_text:input.deliveryText||null,created_at:Date.now()
      };
      return json(env,await createProduct(env,row),201);
    }
  }

  const productDelete=url.pathname.match(/^\/api\/guilds\/(\d+)\/products\/([^/]+)$/);
  if(productDelete&&request.method==="DELETE"){
    await requireGuild(request,env,productDelete[1]!);
    if(!(await deleteProduct(env,productDelete[1]!,productDelete[2]!))) throw new HttpError(404,"商品が見つかりません");
    return json(env,{ok:true});
  }

  const productPanel=url.pathname.match(/^\/api\/guilds\/(\d+)\/products\/([^/]+)\/panel$/);
  if(productPanel&&request.method==="POST"){
    await requireGuild(request,env,productPanel[1]!);
    const product=await getProduct(env,productPanel[2]!);
    if(!product||product.guild_id!==productPanel[1]!||!product.active) throw new HttpError(404,"商品が見つかりません");
    const {channelId}=await bodyObject<{channelId:string}>(request);
    await publishProductPanel(env,channelId,product);
    return json(env,{ok:true});
  }

  throw new HttpError(404,"Not found");
}

async function oauthStart(request:Request,env:Env):Promise<Response>{
  const state=randomToken(24);
  await putOAuthState(env,state);
  const origin=new URL(request.url).origin;
  return new Response(null,{
    status:302,
    headers:{
      Location:oauthAuthorizeUrl(env,origin,state),
      "Set-Cookie":`dsm_oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}

async function oauthCallback(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  const code=url.searchParams.get("code");
  const state=url.searchParams.get("state");
  const cookie=parseCookie(request.headers.get("Cookie"),"dsm_oauth_state");
  if(!code||!state||!cookie||cookie!==state||!(await consumeOAuthState(env,state))){
    throw new HttpError(400,"OAuth state mismatch");
  }
  const tokens=await exchangeCode(env,url.origin,code);
  const user=await userJson<DiscordUser>("/users/@me",tokens.access_token);
  const rawSession=randomToken(32);
  await createSession(env,{
    token_hash:await sha256Hex(rawSession),
    user_id:user.id,
    username:user.global_name||user.username,
    avatar:user.avatar||null,
    access_token_enc:await encrypt(env.SESSION_ENCRYPTION_KEY,tokens.access_token),
    refresh_token_enc:await encrypt(env.SESSION_ENCRYPTION_KEY,tokens.refresh_token),
    token_expires_at:Date.now()+tokens.expires_in*1000,
    expires_at:Date.now()+30*24*60*60_000
  });
  return new Response(null,{
    status:302,
    headers:{
      Location:`${env.WEB_PUBLIC_URL.replace(/\/$/,"")}/#session=${encodeURIComponent(rawSession)}`,
      "Set-Cookie":"dsm_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}

async function handlePayPayWebhook(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  let payload:any={};
  try{payload=await request.json();}catch{}
  const merchantId=payload?.merchantPaymentId||payload?.data?.merchantPaymentId;
  if(merchantId){
    ctx.waitUntil((async()=>{
      const payment=await getPaymentByMerchantId(env,String(merchantId));
      if(payment) await confirmAndDeliver(env,payment);
    })().catch(console.error));
  }
  return new Response("OK",{status:200});
}

async function neutralize(env:Env,guildId:string,userId:string,settings:GuildSettings):Promise<void>{
  if(settings.trustedUserIds.includes(userId)) return;
  const guild=await botJson<{owner_id:string}>(env,`/guilds/${guildId}`);
  if(guild.owner_id===userId) return;
  const [member,roles]=await Promise.all([
    botJson<{roles:string[]}>(env,`/guilds/${guildId}/members/${userId}`),
    botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`)
  ]);
  if(member.roles.some(id=>settings.trustedRoleIds.includes(id))) return;
  for(const role of roles){
    if(!member.roles.includes(role.id)||role.managed) continue;
    if((BigInt(role.permissions)&DANGEROUS_PERMISSION_MASK)!==0n){
      await botFetch(env,`/guilds/${guildId}/members/${userId}/roles/${role.id}`,{method:"DELETE"})
        .catch(()=>undefined);
    }
  }
  if(settings.logChannelId){
    await sendMessage(env,settings.logChannelId,{
      content:`⚠️ Anti-Nuke: <@${userId}> から危険権限ロールの解除を試みました。`
    }).catch(()=>undefined);
  }
}

async function auditWatch(env:Env):Promise<void>{
  const guilds=await listAllGuildSettings(env,10);
  for(const row of guilds){
    let settings:GuildSettings;
    try{settings={...DEFAULT_SETTINGS,...JSON.parse(row.config)};}catch{continue;}
    if(!settings.securityEnabled||!settings.antiNuke) continue;
    const payload=await botJson<{audit_log_entries:Array<{
      id:string;action_type:number;user_id?:string|null;
    }> }>(env,`/guilds/${row.guild_id}/audit-logs?limit=30`).catch(()=>null);
    if(!payload?.audit_log_entries?.length) continue;
    const newest=payload.audit_log_entries[0]!.id;
    const cursor=await getAuditCursor(env,row.guild_id);
    if(!cursor){
      await setAuditCursor(env,row.guild_id,newest);
      continue;
    }
    const fresh=[];
    for(const entry of payload.audit_log_entries){
      if(entry.id===cursor) break;
      if(entry.user_id&&[12,22,32].includes(entry.action_type)) fresh.push(entry);
    }
    await setAuditCursor(env,row.guild_id,newest);
    const byUser=new Map<string,number[]>();
    for(const entry of fresh){
      const times=byUser.get(entry.user_id!)??[];
      times.push(snowflakeTime(entry.id));
      byUser.set(entry.user_id!,times);
    }
    const windowMs=settings.nukeWindowSeconds*1000;
    for(const [userId,times] of byUser){
      times.sort((a,b)=>a-b);
      let left=0,hit=false;
      for(let right=0;right<times.length;right++){
        while(times[right]!-times[left]!>windowMs) left++;
        if(right-left+1>=settings.nukeActions){hit=true;break;}
      }
      if(hit) await neutralize(env,row.guild_id,userId,settings).catch(console.error);
    }
  }
}

async function paymentSweep(env:Env):Promise<void>{
  if(!payPayConfigured(env)) return;
  for(const payment of await listPendingPayments(env,8)){
    await confirmAndDeliver(env,payment).catch(console.error);
  }
}

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    try{
      const url=new URL(request.url);

      if(request.method==="OPTIONS"){
        return new Response(null,{status:204,headers:corsHeaders(env)});
      }
      if(url.pathname==="/"||url.pathname==="/health"){
        let d1Reachable=false;
        let d1Error:string|null=null;
        if(env.DB){
          try{
            await env.DB.prepare("SELECT 1 AS ok").first();
            d1Reachable=true;
          }catch(error){
            d1Error=error instanceof Error?error.message:String(error);
          }
        }
        let d1SchemaReady=false;
        if(d1Reachable){
          try{
            await ensureSchema(env);
            d1SchemaReady=true;
          }catch(error){
            console.error("D1 schema initialization failed",error);
          }
        }
        const dashboardSessionStorage=env.DB
          ?await dashboardSessionStorageReady(env)
          :false;

        let discordApiReachable=false;
        let discordBotId:string|null=null;
        let discordBotUsername:string|null=null;
        let discordGuildCount:number|null=null;
        let discordApplicationMatchesToken:boolean|null=null;
        let discordApiError:string|null=null;
        try{
          const bot=await botJson<{id:string;username:string}>(env,"/users/@me");
          discordApiReachable=true;
          discordBotId=bot.id;
          discordBotUsername=bot.username;
          discordApplicationMatchesToken=bot.id===env.DISCORD_APPLICATION_ID.trim();
          // Do not call /users/@me/guilds from health; dashboard bootstrap owns that request.
          // This prevents health checks from consuming the same Discord REST rate-limit bucket.
          discordGuildCount=null;
        }catch(error){
          discordApiError=error instanceof Error?error.message:String(error);
        }

        return json(env,{
          ok:d1Reachable&&d1SchemaReady&&dashboardSessionStorage&&discordApiReachable,
          version:"dashboard-auth-v18-reorder",
          runtime:"cloudflare-workers",
          discord:{
            applicationId:Boolean(env.DISCORD_APPLICATION_ID),
            publicKey:Boolean(env.DISCORD_PUBLIC_KEY),
            botToken:Boolean(env.DISCORD_BOT_TOKEN),
            clientSecret:Boolean(env.DISCORD_CLIENT_SECRET),
            apiReachable:discordApiReachable,
            botId:discordBotId,
            botUsername:discordBotUsername,
            guildCount:discordGuildCount,
            applicationMatchesToken:discordApplicationMatchesToken,
            apiError:discordApiError
          },
          encryptionKey:Boolean(env.SESSION_ENCRYPTION_KEY),
          dashboardPassword:Boolean(env.DASHBOARD_PASSWORD),
          dashboardSessionStorage,
          d1:{
            bound:Boolean(env.DB),
            reachable:d1Reachable,
            schemaReady:d1SchemaReady,
            error:d1Error
          }
        });
      }
      if(url.pathname==="/interactions"&&request.method==="POST"){
        return await handleInteraction(request,env,ctx);
      }
      if(url.pathname==="/api/login"&&request.method==="POST"){
        return await handleDashboardLogin(request,env);
      }

      // Read-only dashboard bootstrap routes must not depend on the full historical schema.
      // Their only DB dependency is dashboard_sessions, which self-heals in sessionFromRequest().
      if(
        (url.pathname==="/api/status"&&request.method==="GET")||
        (url.pathname==="/api/me"&&request.method==="GET")||
        (url.pathname==="/api/guilds"&&request.method==="GET")||
        (/^\/api\/guilds\/\d+\/meta$/.test(url.pathname)&&request.method==="GET")||
        (/^\/api\/guilds\/\d+\/channels\/\d+\/permissions\/\d+$/.test(url.pathname)&&request.method==="PATCH")||
        (/^\/api\/guilds\/\d+\/roles(?:\/\d+)?$/.test(url.pathname)&&["POST","PATCH","DELETE"].includes(request.method))||
        (/^\/api\/guilds\/\d+\/(verification|tickets)\/panel$/.test(url.pathname)&&request.method==="POST")
      ){
        return await handleApi(request,env,url);
      }

      await ensureSchema(env);

      if(url.pathname==="/paypay/webhook"&&request.method==="POST"){
        return handlePayPayWebhook(request,env,ctx);
      }
      if(url.pathname.startsWith("/api/")){
        const isVendingRoute=
          url.pathname.startsWith("/api/vending/")||
          /^\/api\/guilds\/\d+\/vending(?:\/|$)/.test(url.pathname);
        if(isVendingRoute){
          const vendingResponse=await handleVendingApi(request,env,url);
          if(vendingResponse) return vendingResponse;
        }
        return await handleApi(request,env,url);
      }
      throw new HttpError(404,"Not found");
    }catch(error){
      console.error(error);
      const status=
        error instanceof HttpError?error.status:
        error instanceof VendingHttpError?error.status:
        error instanceof DiscordApiError?(error.status===429?429:502):
        500;
      const message=
        error instanceof HttpError||error instanceof VendingHttpError||error instanceof DiscordApiError
          ?error.message
          :"サーバー処理に失敗しました";
      return json(env,{error:status>=500?"server_error":"request_error",message},status);
    }
  },

  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    await ensureSchema(env);
    ctx.waitUntil(Promise.all([
      cleanExpired(env),
      auditWatch(env),
      paymentSweep(env),
      vendingSweep(env)
    ]).then(()=>undefined));
  }
} satisfies ExportedHandler<Env>;
