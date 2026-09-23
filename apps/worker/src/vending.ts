import type { Env, SessionRow } from "./types";
import { botFetch, botJson, canManageGuild, userJson, validAccessToken, type DiscordGuild } from "./discord";
import { getSession } from "./db";
import { json, randomId, sha256Hex } from "./utils";
import {
  addStock, attachPaymentLink, claimDelivery, cleanVendingExpired, createCoupon, createMachine, createVmProduct,
  deleteCoupon, deleteMachine, deleteVmProduct, ensureVendingSchema, finishDelivery, getCoupon,
  getMachine, getOrder, getPayPay, getStockNotify, getVmProduct, listCoupons, listMachines, listVmProducts,
  markPaid, orderStock, releaseStock, removePayPay, reserveOrder, resetDelivery, savePayChallenge, savePayPay, saveStockNotify, stockContents,
  takePayChallenge, updateMachine, updateVmProduct, withdrawStock, type Vm, type VmOrder, type VmProduct
} from "./vending-db";
import {
  acceptPayPayLink, checkPayPayLink, getKyashAccount, kyashLoginOtp, kyashLoginStart,
  payPayLoginOtp, payPayLoginStart, receiveKyashLink, saveKyashAccount, saveKyashChallenge,
  takeKyashChallenge
} from "./vending-payments";

class VendingHttpError extends Error { constructor(public status:number,message:string){super(message);} }

async function sessionFromRequest(request:Request,env:Env):Promise<SessionRow>{
  const auth=request.headers.get("Authorization");
  if(!auth?.startsWith("Bearer ")) throw new VendingHttpError(401,"ログインが必要です");
  const row=await getSession(env,await sha256Hex(auth.slice(7).trim()));
  if(!row) throw new VendingHttpError(401,"セッションが失効しています");
  return row;
}
async function requireGuild(request:Request,env:Env,guildId:string){
  const session=await sessionFromRequest(request,env);
  const token=await validAccessToken(env,session);
  const guilds=(await userJson<DiscordGuild[]>("/users/@me/guilds",token)).filter(canManageGuild);
  if(!guilds.some(g=>g.id===guildId)) throw new VendingHttpError(403,"このサーバーを管理できません");
  if(!(await botFetch(env,"/guilds/"+guildId)).ok) throw new VendingHttpError(409,"先にBOTを追加してください");
  return session;
}
function input<T>(r:Request){ return r.json() as Promise<T>; }
function ires(data:unknown){ return new Response(JSON.stringify(data),{headers:{"Content-Type":"application/json"}}); }
function eph(content:string,components?:unknown[],embeds?:unknown[]){ return {type:4,data:{content,flags:64,...(components?{components}:{}),...(embeds?{embeds}:{})}}; }
async function send(env:Env,channelId:string,payload:unknown){ await botJson(env,"/channels/"+channelId+"/messages",{method:"POST",body:JSON.stringify(payload)}); }
async function sendFile(
  env:Env,
  channelId:string,
  payload:unknown,
  filename:string,
  content:string
){
  const form=new FormData();
  form.set("payload_json",JSON.stringify(payload));
  form.set("files[0]",new File([content],filename,{type:"text/plain;charset=utf-8"}));
  const response=await fetch("https://discord.com/api/v10/channels/"+channelId+"/messages",{
    method:"POST",
    headers:{Authorization:"Bot "+env.DISCORD_BOT_TOKEN},
    body:form
  });
  if(!response.ok) throw new Error("Discord attachment send failed: "+response.status);
}

async function machineOwned(env:Env,id:string,ownerId:string){
  const vm=await getMachine(env,id);
  if(!vm||vm.owner_id!==ownerId) throw new VendingHttpError(404,"自販機が見つかりません");
  return vm;
}
async function productOwned(env:Env,productId:string,vm:Vm){
  const p=await getVmProduct(env,productId);
  if(!p||p.vending_machine_id!==vm.id) throw new VendingHttpError(404,"商品が見つかりません");
  return p;
}

function panelEmbed(vm:Vm,products:Array<VmProduct&{stock_count:number}>){
  const lines=products.map(p=>{
    const stock=p.infinite_stock?"∞":String(p.stock_count);
    const emoji=p.emoji?String(p.emoji)+" ":"";
    return emoji+"**"+p.name+"**\nPayPay: "+p.price_paypay+"円 / Kyash: "+p.price_kyash+"円 / 在庫: "+stock+" / 販売: "+p.sales_count;
  });
  return {
    title:vm.panel_title||vm.name||"自販機",
    description:(vm.panel_description||"購入したい商品を下のボタンから選択してください。")+(lines.length?"\n\n"+lines.join("\n\n"):"\n\n現在販売中の商品はありません。"),
    color:5763719,
    ...(vm.panel_image_url?{image:{url:vm.panel_image_url}}:{})
  };
}

export async function handleVendingApi(request:Request,env:Env,url:URL):Promise<Response|null>{
  await ensureVendingSchema(env);

  const list=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending$/);
  if(list){
    const guildId=list[1]!; const session=await requireGuild(request,env,guildId);
    if(request.method==="GET") return json(env,await listMachines(env,guildId,session.user_id));
    if(request.method==="POST"){
      const b=await input<{name:string}>(request); const name=b.name?.trim();
      if(!name||name.length>80) throw new VendingHttpError(400,"自販機名が不正です");
      return json(env,await createMachine(env,guildId,session.user_id,name),201);
    }
  }

  const vmMatch=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)$/);
  if(vmMatch){
    const guildId=vmMatch[1]!,vmId=vmMatch[2]!,session=await requireGuild(request,env,guildId),vm=await machineOwned(env,vmId,session.user_id);
    if(request.method==="GET") return json(env,{...vm,products:await listVmProducts(env,vmId),coupons:await listCoupons(env,vmId)});
    if(request.method==="PATCH"){
      const b=await input<any>(request); if(b.name!==undefined&&(!String(b.name).trim()||String(b.name).length>80)) throw new VendingHttpError(400,"自販機名が不正です");
      await updateMachine(env,vmId,session.user_id,{name:b.name?.trim(),publicLog:b.publicLogChannelId,localLog:b.localLogChannelId,privateLog:b.privateLogChannelId,roleId:b.roleId,panelTitle:b.panelTitle,panelDescription:b.panelDescription,panelImageUrl:b.panelImageUrl});
      return json(env,{ok:true});
    }
    if(request.method==="DELETE") return json(env,{ok:await deleteMachine(env,vmId,session.user_id)});
  }

  const products=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/products$/);
  if(products){
    const guildId=products[1]!,vmId=products[2]!,session=await requireGuild(request,env,guildId); await machineOwned(env,vmId,session.user_id);
    if(request.method==="GET") return json(env,await listVmProducts(env,vmId));
    if(request.method==="POST"){
      const b=await input<any>(request); const name=String(b.name??"").trim();
      if(!name||name.length>80) throw new VendingHttpError(400,"商品名が不正です");
      const pp=Math.max(0,Number(b.pricePayPay??0)),ky=Math.max(0,Number(b.priceKyash??0));
      if(!Number.isInteger(pp)||!Number.isInteger(ky)) throw new VendingHttpError(400,"価格は整数で入力してください");
      return json(env,await createVmProduct(env,vmId,{name,description:String(b.description??"").slice(0,500),pricePayPay:pp,priceKyash:ky,emoji:b.emoji?String(b.emoji).slice(0,64):null}),201);
    }
  }

  const product=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/products\/([^/]+)$/);
  if(product){
    const guildId=product[1]!,vmId=product[2]!,productId=product[3]!,session=await requireGuild(request,env,guildId),vm=await machineOwned(env,vmId,session.user_id); await productOwned(env,productId,vm);
    if(request.method==="PATCH"){
      const b=await input<any>(request); await updateVmProduct(env,productId,vmId,{name:b.name?.trim(),description:b.description,pricePayPay:b.pricePayPay===undefined?undefined:Number(b.pricePayPay),priceKyash:b.priceKyash===undefined?undefined:Number(b.priceKyash),emoji:b.emoji,infiniteStock:b.infiniteStock,infiniteContent:b.infiniteContent});
      return json(env,{ok:true});
    }
    if(request.method==="DELETE") return json(env,{ok:await deleteVmProduct(env,productId,vmId)});
  }

  const stock=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/products\/([^/]+)\/stock$/);
  if(stock){
    const guildId=stock[1]!,vmId=stock[2]!,productId=stock[3]!,session=await requireGuild(request,env,guildId),vm=await machineOwned(env,vmId,session.user_id); await productOwned(env,productId,vm);
    if(request.method==="GET") return json(env,await stockContents(env,productId));
    if(request.method==="POST"){
      const b=await input<{text?:string;lines?:string[];notify?:boolean}>(request);
      const lines=Array.isArray(b.lines)?b.lines:String(b.text??"").split(/\r?\n/);
      if(lines.filter(Boolean).length>500) throw new VendingHttpError(413,"在庫は1回500件まで追加できます");
      const count=await addStock(env,productId,lines);
      const notification=await getStockNotify(env,vmId);
      if(count>0&&b.notify!==false&&notification){
        const productInfo=await getVmProduct(env,productId);
        if(productInfo){
          await send(env,notification.channel_id,{
            content:"<@&"+notification.role_id+">",
            allowed_mentions:{roles:[notification.role_id]},
            embeds:[{
              title:"在庫追加のお知らせ",
              color:5763719,
              description:"**"+productInfo.name+"** の在庫が追加されました。",
              fields:[
                {name:"追加数",value:String(count)+"個",inline:true},
                {name:"自販機",value:vm.name,inline:true}
              ]
            }]
          }).catch(()=>undefined);
        }
      }
      return json(env,{ok:true,added:count});
    }
  }

  const withdraw=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/products\/([^/]+)\/withdraw$/);
  if(withdraw&&request.method==="POST"){
    const guildId=withdraw[1]!,vmId=withdraw[2]!,productId=withdraw[3]!,session=await requireGuild(request,env,guildId),vm=await machineOwned(env,vmId,session.user_id); await productOwned(env,productId,vm);
    const b=await input<{quantity:number}>(request),q=Math.max(1,Math.min(500,Number(b.quantity)||1));
    const items=await withdrawStock(env,productId,q); if(items.length<q) throw new VendingHttpError(409,"在庫が不足しています");
    return json(env,{items});
  }

  const coupons=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/coupons$/);
  if(coupons){
    const guildId=coupons[1]!,vmId=coupons[2]!,session=await requireGuild(request,env,guildId); await machineOwned(env,vmId,session.user_id);
    if(request.method==="GET") return json(env,await listCoupons(env,vmId));
    if(request.method==="POST"){
      const b=await input<{code:string;discount:number}>(request),code=String(b.code??"").trim(); const discount=Number(b.discount);
      if(!code||code.length>50||!Number.isInteger(discount)||discount<=0) throw new VendingHttpError(400,"クーポン情報が不正です");
      try{await createCoupon(env,vmId,session.user_id,code,discount);}catch{throw new VendingHttpError(409,"そのクーポンコードは既に存在します");}
      return json(env,{ok:true},201);
    }
  }

  const couponDelete=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/coupons\/([^/]+)$/);
  if(couponDelete&&request.method==="DELETE"){
    const guildId=couponDelete[1]!,vmId=couponDelete[2]!,code=decodeURIComponent(couponDelete[3]!),session=await requireGuild(request,env,guildId); await machineOwned(env,vmId,session.user_id);
    return json(env,{ok:await deleteCoupon(env,vmId,session.user_id,code)});
  }

  const stockNotify=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/stock-notification$/);
  if(stockNotify){
    const guildId=stockNotify[1]!,vmId=stockNotify[2]!,session=await requireGuild(request,env,guildId);
    await machineOwned(env,vmId,session.user_id);
    if(request.method==="GET") return json(env,await getStockNotify(env,vmId));
    if(request.method==="POST"){
      const b=await input<{channelId:string;roleId:string}>(request);
      if(!b.channelId||!b.roleId) throw new VendingHttpError(400,"チャンネルとロールを選択してください");
      await saveStockNotify(env,vmId,guildId,b.channelId,b.roleId);
      return json(env,{ok:true});
    }
  }

  const panel=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/panel$/);
  if(panel&&request.method==="POST"){
    const guildId=panel[1]!,vmId=panel[2]!,session=await requireGuild(request,env,guildId),vm=await machineOwned(env,vmId,session.user_id),b=await input<{channelId:string}>(request),products=await listVmProducts(env,vmId);
    await send(env,b.channelId,{embeds:[panelEmbed(vm,products)],components:[{type:1,components:[{type:2,style:3,label:"購入する",emoji:{name:"🛒"},custom_id:"vm:buy:"+vmId},{type:2,style:1,label:"在庫・販売数",emoji:{name:"📦"},custom_id:"vm:stock:"+vmId}]}]});
    return json(env,{ok:true});
  }

  const panelUpdate=url.pathname.match(/^\/api\/guilds\/(\d+)\/vending\/([^/]+)\/panel\/update$/);
  if(panelUpdate&&request.method==="POST"){
    const guildId=panelUpdate[1]!,vmId=panelUpdate[2]!,session=await requireGuild(request,env,guildId);
    const vm=await machineOwned(env,vmId,session.user_id);
    const b=await input<{messageUrl:string}>(request);
    const match=String(b.messageUrl??"").match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
    if(!match||match[1]!==guildId) throw new VendingHttpError(400,"DiscordメッセージURLが不正です");
    const channelId=match[2]!,messageId=match[3]!,products=await listVmProducts(env,vmId);
    await botJson(env,"/channels/"+channelId+"/messages/"+messageId,{
      method:"PATCH",
      body:JSON.stringify({
        embeds:[panelEmbed(vm,products)],
        components:[{type:1,components:[
          {type:2,style:3,label:"購入する",emoji:{name:"🛒"},custom_id:"vm:buy:"+vmId},
          {type:2,style:1,label:"在庫・販売数",emoji:{name:"📦"},custom_id:"vm:stock:"+vmId}
        ]}]
      })
    });
    return json(env,{ok:true});
  }

  if(url.pathname==="/api/vending/payments/status"&&request.method==="GET"){
    const s=await sessionFromRequest(request,env);
    return json(env,{
      paypay:Boolean(await getPayPay(env,s.user_id,env.SESSION_ENCRYPTION_KEY)),
      kyash:Boolean(await getKyashAccount(env,s.user_id))
    });
  }
  if(url.pathname==="/api/vending/paypay/status"&&request.method==="GET"){
    const s=await sessionFromRequest(request,env); return json(env,{registered:Boolean(await getPayPay(env,s.user_id,env.SESSION_ENCRYPTION_KEY))});
  }
  if(url.pathname==="/api/vending/paypay/logout"&&request.method==="POST"){
    const s=await sessionFromRequest(request,env);
    await removePayPay(env,s.user_id);
    return json(env,{ok:true});
  }
  if(url.pathname==="/api/vending/paypay/login/start"&&request.method==="POST"){
    const s=await sessionFromRequest(request,env),b=await input<{phone:string;password:string}>(request),uuid=randomId(),result:any=await payPayLoginStart(b.phone,b.password,uuid);
    if(result?.response_type==="ErrorResponse") throw new VendingHttpError(400,"PayPayログイン情報が一致しません");
    if(!result?.otp_reference_id||!result?.otp_prefix) throw new VendingHttpError(502,"PayPay OTP開始に失敗しました");
    const challengeId=await savePayChallenge(env,s.user_id,JSON.stringify({phone:b.phone,password:b.password,uuid,otpReferenceId:result.otp_reference_id,otpPrefix:result.otp_prefix}),env.SESSION_ENCRYPTION_KEY);
    return json(env,{challengeId,otpPrefix:result.otp_prefix});
  }
  if(url.pathname==="/api/vending/paypay/login/verify"&&request.method==="POST"){
    const s=await sessionFromRequest(request,env),b=await input<{challengeId:string;otp:string}>(request),raw=await takePayChallenge(env,b.challengeId,s.user_id,env.SESSION_ENCRYPTION_KEY);
    if(!raw) throw new VendingHttpError(410,"OTP認証が失効しました"); const p=JSON.parse(raw);
    const result:any=await payPayLoginOtp({uuid:p.uuid,otp:b.otp,otpReferenceId:p.otpReferenceId,otpPrefix:p.otpPrefix});
    if(result?.response_type==="ErrorResponse") throw new VendingHttpError(400,"OTPコードが正しくありません");
    await savePayPay(env,s.user_id,p.phone,p.password,p.uuid,env.SESSION_ENCRYPTION_KEY); return json(env,{ok:true});
  }

  if(url.pathname==="/api/vending/kyash/login/start"&&request.method==="POST"){
    const s=await sessionFromRequest(request,env),b=await input<{email:string;password:string}>(request),clientUuid=randomId().toUpperCase(),installationUuid=randomId().toUpperCase(),result:any=await kyashLoginStart(b.email,b.password,clientUuid,installationUuid);
    if(result?.code!==200) throw new VendingHttpError(400,result?.error?.message||"Kyashログイン開始に失敗しました");
    const challengeId=await saveKyashChallenge(env,s.user_id,{email:b.email,password:b.password,clientUuid,installationUuid}); return json(env,{challengeId});
  }
  if(url.pathname==="/api/vending/kyash/login/verify"&&request.method==="POST"){
    const s=await sessionFromRequest(request,env),b=await input<{challengeId:string;otp:string}>(request),p=await takeKyashChallenge(env,b.challengeId,s.user_id);
    if(!p) throw new VendingHttpError(410,"OTP認証が失効しました");
    const result:any=await kyashLoginOtp({email:p.email,otp:b.otp,clientUuid:p.clientUuid,installationUuid:p.installationUuid});
    if(result?.code!==200||!result?.result?.data?.token) throw new VendingHttpError(400,result?.error?.message||"Kyash OTP認証に失敗しました");
    await saveKyashAccount(env,s.user_id,{email:p.email,password:p.password,clientUuid:p.clientUuid,installationUuid:p.installationUuid,accessToken:result.result.data.token}); return json(env,{ok:true});
  }

  return null;
}

function selectOptions(products:Array<VmProduct&{stock_count:number}>,method:"paypay"|"kyash"){
  return products.slice(0,25).map(p=>({label:p.name.slice(0,100),value:p.id,description:(method==="paypay"?p.price_paypay:p.price_kyash)+"円 | 在庫 "+(p.infinite_stock?"∞":p.stock_count)+" | 販売 "+p.sales_count,...(p.emoji?{emoji:{name:p.emoji}}:{})}));
}

async function deliver(env:Env,order:VmOrder){
  if(order.delivered_at) return;
  if(!(await claimDelivery(env,order.id))) return;
  try{
    const vm=await getMachine(env,order.vending_machine_id),product=await getVmProduct(env,order.product_id); if(!vm||!product) throw new Error("ORDER_DATA_MISSING");
    const items=product.infinite_stock?[product.infinite_content??""]:await orderStock(env,order.id);
    if(!product.infinite_stock&&items.length<order.quantity) throw new Error("RESERVED_STOCK_MISSING");
    const deliveredText=items.join("\n");
    const dm=await botJson<{id:string}>(env,"/users/@me/channels",{method:"POST",body:JSON.stringify({recipient_id:order.user_id})});
    const purchaseEmbed={
      title:"購入が完了しました",
      color:5763719,
      fields:[
        {name:"商品名",value:product.name,inline:true},
        {name:"購入数",value:String(order.quantity)+"個",inline:true},
        {name:"支払金額",value:String(order.total_amount)+"円",inline:true},
        {name:"決済方法",value:order.payment_method.toUpperCase(),inline:true},
        {name:"サーバー",value:"<@"+order.user_id+">",inline:true}
      ],
      timestamp:new Date().toISOString()
    };
    if(deliveredText.length<=1800){
      await send(env,dm.id,{content:deliveredText,embeds:[purchaseEmbed]});
    }else{
      await sendFile(env,dm.id,{embeds:[purchaseEmbed]},"purchase_"+order.id+".txt",deliveredText);
    }
    if(vm.role_id) await botFetch(env,"/guilds/"+order.guild_id+"/members/"+order.user_id+"/roles/"+vm.role_id,{method:"PUT"}).catch(()=>undefined);
    const log={embeds:[{title:"購入完了",color:5763719,fields:[{name:"商品",value:product.name,inline:true},{name:"個数",value:String(order.quantity),inline:true},{name:"金額",value:String(order.total_amount)+"円",inline:true},{name:"購入者",value:"<@"+order.user_id+">",inline:true},{name:"決済",value:order.payment_method.toUpperCase(),inline:true}]}]};
    for(const channelId of [vm.public_log_channel_id,vm.local_log_channel_id]) if(channelId) await send(env,channelId,log).catch(()=>undefined);
    if(vm.private_log_channel_id){
      await sendFile(
        env,
        vm.private_log_channel_id,
        log,
        "purchase_"+order.user_id+"_"+Date.now()+".txt",
        deliveredText
      ).catch(()=>undefined);
    }
    await finishDelivery(env,order);
  }catch(error){
    await resetDelivery(env,order.id);
    throw error;
  }
}

export async function handleVendingInteraction(interaction:any,env:Env,ctx:ExecutionContext):Promise<Response|null>{
  await ensureVendingSchema(env);
  if(interaction.type===3){
    const id=String(interaction.data?.custom_id??"");
    if(id.startsWith("vm:buy:")){
      const vmId=id.slice(7),vm=await getMachine(env,vmId); if(!vm) return ires(eph("自販機が見つかりません。"));
      return ires(eph("決済方法を選択してください。",[{type:1,components:[{type:3,custom_id:"vm:method:"+vmId,placeholder:"決済方法",options:[{label:"PayPay",value:"paypay",emoji:{name:"💴"}},{label:"Kyash",value:"kyash",emoji:{name:"💳"}}]}]}]));
    }
    if(id.startsWith("vm:stock:")){
      const vmId=id.slice(9),products=await listVmProducts(env,vmId); return ires(eph("",undefined,[{title:"在庫・販売数情報",color:5793266,fields:products.map(p=>({name:p.name,value:"在庫: "+(p.infinite_stock?"∞":p.stock_count)+"\n販売数: "+p.sales_count,inline:false}))}]));
    }
    if(id.startsWith("vm:method:")){
      const vmId=id.slice(10),method=interaction.data.values?.[0] as "paypay"|"kyash",products=await listVmProducts(env,vmId),options=selectOptions(products,method);
      if(!options.length) return ires(eph("現在販売中の商品はありません。"));
      return ires(eph("購入する商品を選択してください。",[{type:1,components:[{type:3,custom_id:"vm:product:"+vmId+":"+method,placeholder:"商品を選択",options}]}]));
    }
    if(id.startsWith("vm:product:")){
      const parts=id.split(":"),vmId=parts[2]!,method=parts[3] as "paypay"|"kyash",productId=interaction.data.values?.[0];
      return ires({type:9,data:{custom_id:"vm:order:"+vmId+":"+method+":"+productId,title:"購入情報入力",components:[{type:1,components:[{type:4,custom_id:"quantity",label:"購入数",style:1,value:"1",required:true,max_length:5}]},{type:1,components:[{type:4,custom_id:"coupon",label:"クーポンコード（任意）",style:1,required:false,max_length:50}]}]}});
    }
    if(id.startsWith("vm:pay:")){
      const orderId=id.slice(7),order=await getOrder(env,orderId); if(!order||order.user_id!==interaction.member?.user?.id) return ires(eph("注文が見つかりません。"));
      return ires({type:9,data:{custom_id:"vm:paymodal:"+orderId,title:(order.payment_method==="paypay"?"PayPay":"Kyash")+"決済",components:[{type:1,components:[{type:4,custom_id:"link",label:"送金リンク",style:1,required:true,placeholder:order.payment_method==="paypay"?"https://pay.paypay.ne.jp/...":"https://kyash.me/payments/..."}]}]}});
    }
  }

  if(interaction.type===5){
    const id=String(interaction.data?.custom_id??"");
    if(id.startsWith("vm:order:")){
      const parts=id.split(":"),vmId=parts[2]!,method=parts[3] as "paypay"|"kyash",productId=parts[4]!,product=await getVmProduct(env,productId),vm=await getMachine(env,vmId);
      if(!product||!vm) return ires(eph("商品が見つかりません。"));
      const fields=interaction.data.components?.flatMap((r:any)=>r.components??[])??[];
      const quantity=product.infinite_stock?1:Number(fields.find((x:any)=>x.custom_id==="quantity")?.value??1),couponCode=String(fields.find((x:any)=>x.custom_id==="coupon")?.value??"").trim();
      if(!Number.isInteger(quantity)||quantity<1||quantity>100) return ires(eph("購入数が不正です。"));
      const coupon=couponCode?await getCoupon(env,vmId,couponCode):null; if(couponCode&&!coupon) return ires(eph("無効なクーポンコードです。"));
      let order:VmOrder|null=null; try{order=await reserveOrder(env,{vmId,product,guildId:interaction.guild_id,userId:interaction.member.user.id,method,quantity,discount:coupon?.discount??0});}catch(e){return ires(eph(String(e).includes("OUT_OF_STOCK")?"在庫が不足しています。":"在庫確保に失敗しました。"));}
      if(!order) return ires(eph("注文作成に失敗しました。"));
      if(order.total_amount===0){ await deliver(env,order); return ires(eph("購入完了しました。DMを確認してください。")); }
      return ires(eph("**"+product.name+"** × "+order.quantity+"\n支払額: **"+order.total_amount+"円**\n10分以内に送金リンクを入力してください。",[{type:1,components:[{type:2,style:3,label:"送金リンクを入力",custom_id:"vm:pay:"+order.id}]}]));
    }
    if(id.startsWith("vm:paymodal:")){
      const orderId=id.slice(12),order=await getOrder(env,orderId); if(!order||order.user_id!==interaction.member?.user?.id||order.status!=="awaiting_payment") return ires(eph("注文が失効しています。"));
      const link=String(interaction.data.components?.[0]?.components?.[0]?.value??"").trim(); if(!link) return ires(eph("送金リンクを入力してください。"));
      let hash:string; try{hash=await attachPaymentLink(env,order.id,link,env.SESSION_ENCRYPTION_KEY);}catch{return ires(eph("この送金リンクは既に使用されています。"));}
      const vm=await getMachine(env,order.vending_machine_id); if(!vm) return ires(eph("自販機が見つかりません。"));
      if(order.payment_method==="paypay"){
        const account=await getPayPay(env,vm.owner_id,env.SESSION_ENCRYPTION_KEY); if(!account) return ires(eph("販売者のPayPayが未登録です。"));
        const info=await checkPayPayLink(link); const amount=Number(info?.payload?.message?.data?.amount??0); if(amount<order.total_amount) return ires(eph("金額が不足しています。必要: "+order.total_amount+"円 / リンク: "+amount+"円"));
        const result=await acceptPayPayLink(link,account);
        if(result.ok){await markPaid(env,order.id,"paypay",hash); const paid=await getOrder(env,order.id); if(paid) await deliver(env,paid); return ires(eph("決済と納品が完了しました。DMを確認してください。"));}
        if(result.pending){return ires(eph("PayPay受け取りが保留されています。受け取り保留を解除してください。1分ごとに自動確認します。"));}
        return ires(eph("PayPay決済を確認できませんでした。"));
      }
      if(order.payment_method==="kyash"){
        const account=await getKyashAccount(env,vm.owner_id); if(!account) return ires(eph("販売者のKyashが未登録です。"));
        const result=await receiveKyashLink(link,account); if(result.amount<order.total_amount) return ires(eph("金額が不足しています。必要: "+order.total_amount+"円 / リンク: "+result.amount+"円"));
        if(!result.ok) return ires(eph("Kyash決済を確認できませんでした。"));
        await markPaid(env,order.id,"kyash",hash); const paid=await getOrder(env,order.id); if(paid) await deliver(env,paid); return ires(eph("決済と納品が完了しました。DMを確認してください。"));
      }
    }
  }
  return null;
}

export async function vendingSweep(env:Env){
  await ensureVendingSchema(env); await cleanVendingExpired(env);
  const pending=(await env.DB.prepare("SELECT id FROM vending_orders WHERE status='awaiting_payment' AND payment_method='paypay' AND payment_link_enc IS NOT NULL ORDER BY updated_at ASC LIMIT 8").all<{id:string}>()).results;
  for(const row of pending){
    const order=await getOrder(env,row.id); if(!order||!order.payment_link_enc) continue;
    try{
      const {decrypt}=await import("./utils"); const link=await decrypt(env.SESSION_ENCRYPTION_KEY,order.payment_link_enc),info:any=await checkPayPayLink(link),status=String(info?.payload?.orderStatus??"");
      if(status==="SUCCESS"||status==="COMPLETED"){
        await markPaid(env,order.id,"paypay",order.payment_link_hash); const paid=await getOrder(env,order.id); if(paid) await deliver(env,paid);
      }
    }catch(e){console.error("vending sweep",row.id,e);}
  }
}

export { VendingHttpError };
