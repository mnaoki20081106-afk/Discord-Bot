import type { Env } from "./types";
import { decrypt, encrypt, randomId, sha256Hex } from "./utils";

export type Vm = {
  id:string; guild_id:string; owner_id:string; name:string;
  public_log_channel_id:string|null; local_log_channel_id:string|null;
  private_log_channel_id:string|null; role_id:string|null;
  panel_title:string|null; panel_description:string|null; panel_image_url:string|null;
  active:number; created_at:number; updated_at:number;
};

export type VmProduct = {
  id:string; vending_machine_id:string; name:string; description:string;
  price_paypay:number; price_kyash:number; emoji:string|null;
  infinite_stock:number; infinite_content:string|null; sales_count:number;
  active:number; created_at:number; updated_at:number;
};

export type VmOrder = {
  id:string; vending_machine_id:string; product_id:string; guild_id:string; user_id:string;
  payment_method:"paypay"|"kyash"|"free"; quantity:number; unit_price:number;
  discount_each:number; total_amount:number; status:string;
  payment_link_hash:string|null; payment_link_enc:string|null;
  reserved_until:number|null; created_at:number; updated_at:number;
  paid_at:number|null; delivered_at:number|null;
};

export type VmAchievementRoom = {
  guild_id:string;
  owner_id:string;
  channel_id:string;
  machine_ids:string[];
  updated_at:number;
};

const schema=[
"CREATE TABLE IF NOT EXISTS vending_machines (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,owner_id TEXT NOT NULL,name TEXT NOT NULL,public_log_channel_id TEXT,local_log_channel_id TEXT,private_log_channel_id TEXT,role_id TEXT,panel_title TEXT,panel_description TEXT,panel_image_url TEXT,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
"CREATE INDEX IF NOT EXISTS vending_machines_guild_idx ON vending_machines(guild_id,active)",
"CREATE TABLE IF NOT EXISTS vending_products (id TEXT PRIMARY KEY,vending_machine_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price_paypay INTEGER NOT NULL DEFAULT 0,price_kyash INTEGER NOT NULL DEFAULT 0,emoji TEXT,infinite_stock INTEGER NOT NULL DEFAULT 0,infinite_content TEXT,sales_count INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
"CREATE INDEX IF NOT EXISTS vending_products_vm_idx ON vending_products(vending_machine_id,active)",
"CREATE TABLE IF NOT EXISTS vending_stock (id TEXT PRIMARY KEY,product_id TEXT NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'available',order_id TEXT,reserved_until INTEGER,created_at INTEGER NOT NULL,sold_at INTEGER)",
"CREATE INDEX IF NOT EXISTS vending_stock_product_idx ON vending_stock(product_id,state,created_at)",
"CREATE TABLE IF NOT EXISTS vending_coupons (code TEXT PRIMARY KEY,vending_machine_id TEXT NOT NULL,owner_id TEXT NOT NULL,discount INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS vending_stock_notifications (vending_machine_id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,role_id TEXT NOT NULL,updated_at INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS vending_orders (id TEXT PRIMARY KEY,vending_machine_id TEXT NOT NULL,product_id TEXT NOT NULL,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,payment_method TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price INTEGER NOT NULL,discount_each INTEGER NOT NULL DEFAULT 0,total_amount INTEGER NOT NULL,status TEXT NOT NULL,payment_link_hash TEXT,payment_link_enc TEXT,reserved_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,paid_at INTEGER,delivered_at INTEGER)",
"CREATE INDEX IF NOT EXISTS vending_orders_status_idx ON vending_orders(status,reserved_until,created_at)",
"CREATE UNIQUE INDEX IF NOT EXISTS vending_orders_link_hash_unique ON vending_orders(payment_link_hash) WHERE payment_link_hash IS NOT NULL",
"CREATE TABLE IF NOT EXISTS vending_payment_accounts (user_id TEXT PRIMARY KEY,paypay_phone_enc TEXT,paypay_password_enc TEXT,paypay_uuid TEXT,kyash_email_enc TEXT,kyash_password_enc TEXT,kyash_client_uuid TEXT,kyash_installation_uuid TEXT,kyash_access_token_enc TEXT,updated_at INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS vending_payment_login_challenges (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,payload_enc TEXT NOT NULL,expires_at INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS vending_used_payment_links (link_hash TEXT PRIMARY KEY,provider TEXT NOT NULL,order_id TEXT NOT NULL,used_at INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS vending_achievement_rooms (guild_id TEXT NOT NULL,owner_id TEXT NOT NULL,channel_id TEXT NOT NULL,machine_ids_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,owner_id))"
];

let ready=false;
export async function ensureVendingSchema(env:Env){
  if(ready) return;
  for(const sql of schema) await env.DB.prepare(sql).run();
  ready=true;
}

export async function cleanVendingExpired(env:Env){
  const now=Date.now();
  const rows=(await env.DB.prepare("SELECT id FROM vending_orders WHERE status='awaiting_payment' AND reserved_until IS NOT NULL AND reserved_until<? LIMIT 50").bind(now).all<{id:string}>()).results;
  for(const row of rows){
    await releaseStock(env,row.id);
    await env.DB.prepare("UPDATE vending_orders SET status='expired',updated_at=? WHERE id=? AND status='awaiting_payment'").bind(now,row.id).run();
  }
  await env.DB.prepare("UPDATE vending_orders SET status='paid',updated_at=? WHERE status='delivering' AND delivered_at IS NULL AND updated_at<?").bind(now,now-5*60_000).run();
  await env.DB.prepare("DELETE FROM vending_payment_login_challenges WHERE expires_at<?").bind(now).run();
}

export async function listMachines(env:Env,guildId:string,ownerId:string){
  return (await env.DB.prepare("SELECT * FROM vending_machines WHERE guild_id=? AND owner_id=? AND active=1 ORDER BY created_at DESC").bind(guildId,ownerId).all<Vm>()).results;
}
export async function getMachine(env:Env,id:string){ return await env.DB.prepare("SELECT * FROM vending_machines WHERE id=? AND active=1").bind(id).first<Vm>()??null; }
export async function createMachine(env:Env,guildId:string,ownerId:string,name:string){
  const now=Date.now(), id=randomId();
  await env.DB.prepare("INSERT INTO vending_machines(id,guild_id,owner_id,name,active,created_at,updated_at) VALUES (?,?,?,?,1,?,?)").bind(id,guildId,ownerId,name,now,now).run();
  return getMachine(env,id);
}
export async function updateMachine(env:Env,id:string,ownerId:string,p:Partial<{name:string;publicLog:string|null;localLog:string|null;privateLog:string|null;roleId:string|null;panelTitle:string|null;panelDescription:string|null;panelImageUrl:string|null}>){
  const cur=await env.DB.prepare("SELECT * FROM vending_machines WHERE id=? AND owner_id=? AND active=1").bind(id,ownerId).first<Vm>();
  if(!cur) return false;
  const r=await env.DB.prepare("UPDATE vending_machines SET name=?,public_log_channel_id=?,local_log_channel_id=?,private_log_channel_id=?,role_id=?,panel_title=?,panel_description=?,panel_image_url=?,updated_at=? WHERE id=? AND owner_id=? AND active=1").bind(
    p.name??cur.name,p.publicLog===undefined?cur.public_log_channel_id:p.publicLog,p.localLog===undefined?cur.local_log_channel_id:p.localLog,p.privateLog===undefined?cur.private_log_channel_id:p.privateLog,p.roleId===undefined?cur.role_id:p.roleId,p.panelTitle===undefined?cur.panel_title:p.panelTitle,p.panelDescription===undefined?cur.panel_description:p.panelDescription,p.panelImageUrl===undefined?cur.panel_image_url:p.panelImageUrl,Date.now(),id,ownerId
  ).run();
  return (r.meta.changes??0)>0;
}
export async function deleteMachine(env:Env,id:string,ownerId:string){ const r=await env.DB.prepare("UPDATE vending_machines SET active=0,updated_at=? WHERE id=? AND owner_id=? AND active=1").bind(Date.now(),id,ownerId).run(); return (r.meta.changes??0)>0; }

export async function listVmProducts(env:Env,vmId:string){
  return (await env.DB.prepare("SELECT p.*,CASE WHEN p.infinite_stock=1 THEN -1 ELSE COALESCE((SELECT COUNT(*) FROM vending_stock s WHERE s.product_id=p.id AND s.state='available'),0) END AS stock_count FROM vending_products p WHERE p.vending_machine_id=? AND p.active=1 ORDER BY p.created_at ASC").bind(vmId).all<VmProduct&{stock_count:number}>()).results;
}
export async function getVmProduct(env:Env,id:string){ return await env.DB.prepare("SELECT * FROM vending_products WHERE id=? AND active=1").bind(id).first<VmProduct>()??null; }
export async function createVmProduct(env:Env,vmId:string,input:{name:string;description:string;pricePayPay:number;priceKyash:number;emoji:string|null}){
  const id=randomId(),now=Date.now();
  await env.DB.prepare("INSERT INTO vending_products(id,vending_machine_id,name,description,price_paypay,price_kyash,emoji,infinite_stock,infinite_content,sales_count,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,NULL,0,1,?,?)").bind(id,vmId,input.name,input.description,input.pricePayPay,input.priceKyash,input.emoji,now,now).run();
  return getVmProduct(env,id);
}
export async function updateVmProduct(env:Env,id:string,vmId:string,p:Partial<{name:string;description:string;pricePayPay:number;priceKyash:number;emoji:string|null;infiniteStock:boolean;infiniteContent:string|null}>){
  const cur=await env.DB.prepare("SELECT * FROM vending_products WHERE id=? AND vending_machine_id=? AND active=1").bind(id,vmId).first<VmProduct>();
  if(!cur) return false;
  const r=await env.DB.prepare("UPDATE vending_products SET name=?,description=?,price_paypay=?,price_kyash=?,emoji=?,infinite_stock=?,infinite_content=?,updated_at=? WHERE id=? AND vending_machine_id=? AND active=1").bind(
    p.name??cur.name,p.description??cur.description,p.pricePayPay??cur.price_paypay,p.priceKyash??cur.price_kyash,p.emoji===undefined?cur.emoji:p.emoji,p.infiniteStock===undefined?cur.infinite_stock:(p.infiniteStock?1:0),p.infiniteContent===undefined?cur.infinite_content:p.infiniteContent,Date.now(),id,vmId
  ).run(); return (r.meta.changes??0)>0;
}
export async function deleteVmProduct(env:Env,id:string,vmId:string){ const r=await env.DB.prepare("UPDATE vending_products SET active=0,updated_at=? WHERE id=? AND vending_machine_id=? AND active=1").bind(Date.now(),id,vmId).run(); return (r.meta.changes??0)>0; }

export async function addStock(env:Env,productId:string,contents:string[]){
  const clean=contents.map(v=>v.trim()).filter(Boolean),now=Date.now();
  for(let i=0;i<clean.length;i+=60){
    await env.DB.batch(clean.slice(i,i+60).map(v=>env.DB.prepare("INSERT INTO vending_stock(id,product_id,content,state,created_at) VALUES (?,?,?,'available',?)").bind(randomId(),productId,v,now)));
  }
  return clean.length;
}
export async function stockContents(env:Env,productId:string){ return (await env.DB.prepare("SELECT id,content FROM vending_stock WHERE product_id=? AND state='available' ORDER BY created_at ASC LIMIT 500").bind(productId).all<{id:string;content:string}>()).results; }
export async function withdrawStock(env:Env,productId:string,q:number){
  const rows=(await env.DB.prepare("SELECT id,content FROM vending_stock WHERE product_id=? AND state='available' ORDER BY created_at ASC LIMIT ?").bind(productId,q).all<{id:string;content:string}>()).results;
  if(rows.length<q) return [];
  for(const x of rows) await env.DB.prepare("DELETE FROM vending_stock WHERE id=? AND state='available'").bind(x.id).run();
  return rows.map(x=>x.content);
}

export async function listCoupons(env:Env,vmId:string){ return (await env.DB.prepare("SELECT code,discount,created_at FROM vending_coupons WHERE vending_machine_id=? AND active=1 ORDER BY created_at DESC").bind(vmId).all<{code:string;discount:number;created_at:number}>()).results; }
export async function getCoupon(env:Env,vmId:string,code:string){ return await env.DB.prepare("SELECT code,discount FROM vending_coupons WHERE vending_machine_id=? AND code=? AND active=1").bind(vmId,code).first<{code:string;discount:number}>()??null; }
export async function createCoupon(env:Env,vmId:string,ownerId:string,code:string,discount:number){ await env.DB.prepare("INSERT INTO vending_coupons(code,vending_machine_id,owner_id,discount,active,created_at) VALUES (?,?,?,?,1,?)").bind(code,vmId,ownerId,discount,Date.now()).run(); }
export async function deleteCoupon(env:Env,vmId:string,ownerId:string,code:string){ const r=await env.DB.prepare("UPDATE vending_coupons SET active=0 WHERE vending_machine_id=? AND owner_id=? AND code=? AND active=1").bind(vmId,ownerId,code).run(); return (r.meta.changes??0)>0; }

export async function saveStockNotify(env:Env,vmId:string,guildId:string,channelId:string,roleId:string){ await env.DB.prepare("INSERT INTO vending_stock_notifications(vending_machine_id,guild_id,channel_id,role_id,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(vending_machine_id) DO UPDATE SET guild_id=excluded.guild_id,channel_id=excluded.channel_id,role_id=excluded.role_id,updated_at=excluded.updated_at").bind(vmId,guildId,channelId,roleId,Date.now()).run(); }
export async function getStockNotify(env:Env,vmId:string){ return await env.DB.prepare("SELECT guild_id,channel_id,role_id FROM vending_stock_notifications WHERE vending_machine_id=?").bind(vmId).first<{guild_id:string;channel_id:string;role_id:string}>()??null; }
export async function deleteStockNotify(env:Env,vmId:string){ await env.DB.prepare("DELETE FROM vending_stock_notifications WHERE vending_machine_id=?").bind(vmId).run(); }

export async function getAchievementRoom(
  env:Env,
  guildId:string,
  ownerId:string
):Promise<VmAchievementRoom|null>{
  const row=await env.DB.prepare(
    "SELECT guild_id,owner_id,channel_id,machine_ids_json,updated_at FROM vending_achievement_rooms WHERE guild_id=? AND owner_id=?"
  ).bind(guildId,ownerId).first<{
    guild_id:string;
    owner_id:string;
    channel_id:string;
    machine_ids_json:string;
    updated_at:number;
  }>();
  if(!row) return null;
  let machineIds:string[]=[];
  try{
    const parsed=JSON.parse(row.machine_ids_json);
    if(Array.isArray(parsed)){
      machineIds=[...new Set(parsed.filter((value):value is string=>typeof value==="string"&&value.length>0))];
    }
  }catch{
    machineIds=[];
  }
  return {
    guild_id:row.guild_id,
    owner_id:row.owner_id,
    channel_id:row.channel_id,
    machine_ids:machineIds,
    updated_at:row.updated_at
  };
}

export async function saveAchievementRoom(
  env:Env,
  input:{guildId:string;ownerId:string;channelId:string;machineIds:string[]}
){
  const machineIds=[...new Set(input.machineIds.filter(Boolean))];
  await env.DB.prepare(
    "INSERT INTO vending_achievement_rooms(guild_id,owner_id,channel_id,machine_ids_json,updated_at) VALUES (?,?,?,?,?) "+
    "ON CONFLICT(guild_id,owner_id) DO UPDATE SET channel_id=excluded.channel_id,machine_ids_json=excluded.machine_ids_json,updated_at=excluded.updated_at"
  ).bind(
    input.guildId,
    input.ownerId,
    input.channelId,
    JSON.stringify(machineIds),
    Date.now()
  ).run();
  return getAchievementRoom(env,input.guildId,input.ownerId);
}

export async function deleteAchievementRoom(env:Env,guildId:string,ownerId:string){
  const result=await env.DB.prepare(
    "DELETE FROM vending_achievement_rooms WHERE guild_id=? AND owner_id=?"
  ).bind(guildId,ownerId).run();
  return (result.meta.changes??0)>0;
}

export async function getAchievementChannelForMachine(
  env:Env,
  guildId:string,
  ownerId:string,
  machineId:string
):Promise<string|null>{
  const room=await getAchievementRoom(env,guildId,ownerId);
  return room?.machine_ids.includes(machineId)?room.channel_id:null;
}

export async function reserveOrder(env:Env,input:{vmId:string;product:VmProduct;guildId:string;userId:string;method:"paypay"|"kyash";quantity:number;discount:number}){
  const now=Date.now(),q=input.product.infinite_stock?1:input.quantity,unit=input.method==="kyash"?input.product.price_kyash:input.product.price_paypay,total=Math.max(0,(unit-input.discount)*q),orderId=randomId(),until=now+10*60_000;
  if(!input.product.infinite_stock){
    const rows=(await env.DB.prepare("SELECT id FROM vending_stock WHERE product_id=? AND state='available' ORDER BY created_at ASC LIMIT ?").bind(input.product.id,q).all<{id:string}>()).results;
    if(rows.length<q) throw new Error("OUT_OF_STOCK");
    for(const row of rows){
      const r=await env.DB.prepare("UPDATE vending_stock SET state='reserved',order_id=?,reserved_until=? WHERE id=? AND state='available'").bind(orderId,until,row.id).run();
      if((r.meta.changes??0)!==1){ await releaseStock(env,orderId); throw new Error("STOCK_RACE"); }
    }
  }
  const method=total===0?"free":input.method,status=total===0?"paid":"awaiting_payment";
  try{
    await env.DB.prepare("INSERT INTO vending_orders(id,vending_machine_id,product_id,guild_id,user_id,payment_method,quantity,unit_price,discount_each,total_amount,status,reserved_until,created_at,updated_at,paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(orderId,input.vmId,input.product.id,input.guildId,input.userId,method,q,unit,input.discount,total,status,input.product.infinite_stock?null:until,now,now,total===0?now:null).run();
  }catch(error){
    await releaseStock(env,orderId);
    throw error;
  }
  return await getOrder(env,orderId);
}
export async function getOrder(env:Env,id:string){ return await env.DB.prepare("SELECT * FROM vending_orders WHERE id=?").bind(id).first<VmOrder>()??null; }
export async function releaseStock(env:Env,orderId:string){ await env.DB.prepare("UPDATE vending_stock SET state='available',order_id=NULL,reserved_until=NULL WHERE order_id=? AND state='reserved'").bind(orderId).run(); }
export async function orderStock(env:Env,orderId:string){ return (await env.DB.prepare("SELECT content FROM vending_stock WHERE order_id=? AND state='reserved' ORDER BY created_at ASC").bind(orderId).all<{content:string}>()).results.map(x=>x.content); }
export async function attachPaymentLink(env:Env,orderId:string,link:string,secret:string){
  const hash=await sha256Hex(link.trim());
  if(await env.DB.prepare("SELECT link_hash FROM vending_used_payment_links WHERE link_hash=?").bind(hash).first()) throw new Error("LINK_USED");
  await env.DB.prepare("UPDATE vending_orders SET payment_link_hash=?,payment_link_enc=?,updated_at=? WHERE id=? AND status='awaiting_payment'").bind(hash,await encrypt(secret,link.trim()),Date.now(),orderId).run();
  return hash;
}
export async function markPaid(env:Env,orderId:string,provider:string,hash:string|null){
  const now=Date.now();
  if(hash) await env.DB.prepare("INSERT INTO vending_used_payment_links(link_hash,provider,order_id,used_at) VALUES (?,?,?,?)").bind(hash,provider,orderId,now).run();
  await env.DB.prepare("UPDATE vending_orders SET status='paid',paid_at=?,updated_at=? WHERE id=?").bind(now,now,orderId).run();
}
export async function claimDelivery(env:Env,orderId:string):Promise<boolean>{
  const result=await env.DB.prepare(
    "UPDATE vending_orders SET status='delivering',updated_at=? WHERE id=? AND status='paid' AND delivered_at IS NULL"
  ).bind(Date.now(),orderId).run();
  return (result.meta.changes??0)===1;
}
export async function resetDelivery(env:Env,orderId:string):Promise<void>{
  await env.DB.prepare(
    "UPDATE vending_orders SET status='paid',updated_at=? WHERE id=? AND status='delivering' AND delivered_at IS NULL"
  ).bind(Date.now(),orderId).run();
}
export async function finishDelivery(env:Env,order:VmOrder){
  const now=Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE vending_stock SET state='sold',sold_at=?,reserved_until=NULL WHERE order_id=? AND state='reserved'").bind(now,order.id),
    env.DB.prepare("UPDATE vending_orders SET status='delivered',delivered_at=?,updated_at=? WHERE id=? AND status='delivering'").bind(now,now,order.id),
    env.DB.prepare("UPDATE vending_products SET sales_count=sales_count+?,updated_at=? WHERE id=?").bind(order.quantity,now,order.product_id)
  ]);
}

export async function savePayPay(env:Env,userId:string,phone:string,password:string,uuid:string,secret:string){
  await env.DB.prepare("INSERT INTO vending_payment_accounts(user_id,paypay_phone_enc,paypay_password_enc,paypay_uuid,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET paypay_phone_enc=excluded.paypay_phone_enc,paypay_password_enc=excluded.paypay_password_enc,paypay_uuid=excluded.paypay_uuid,updated_at=excluded.updated_at").bind(userId,await encrypt(secret,phone),await encrypt(secret,password),uuid,Date.now()).run();
}
export async function getPayPay(env:Env,userId:string,secret:string){
  const r=await env.DB.prepare("SELECT paypay_phone_enc,paypay_password_enc,paypay_uuid FROM vending_payment_accounts WHERE user_id=?").bind(userId).first<{paypay_phone_enc:string|null;paypay_password_enc:string|null;paypay_uuid:string|null}>();
  if(!r?.paypay_phone_enc||!r.paypay_password_enc||!r.paypay_uuid) return null;
  return {phone:await decrypt(secret,r.paypay_phone_enc),password:await decrypt(secret,r.paypay_password_enc),uuid:r.paypay_uuid};
}
export async function removePayPay(env:Env,userId:string){ await env.DB.prepare("UPDATE vending_payment_accounts SET paypay_phone_enc=NULL,paypay_password_enc=NULL,paypay_uuid=NULL,updated_at=? WHERE user_id=?").bind(Date.now(),userId).run(); }
export async function savePayChallenge(env:Env,userId:string,payload:string,secret:string){ const id=randomId(); await env.DB.prepare("INSERT INTO vending_payment_login_challenges(id,user_id,provider,payload_enc,expires_at) VALUES (?,?,'paypay',?,?)").bind(id,userId,await encrypt(secret,payload),Date.now()+5*60_000).run(); return id; }
export async function takePayChallenge(env:Env,id:string,userId:string,secret:string){ const r=await env.DB.prepare("SELECT payload_enc,expires_at FROM vending_payment_login_challenges WHERE id=? AND user_id=? AND provider='paypay'").bind(id,userId).first<{payload_enc:string;expires_at:number}>(); if(!r||r.expires_at<Date.now()) return null; await env.DB.prepare("DELETE FROM vending_payment_login_challenges WHERE id=?").bind(id).run(); return decrypt(secret,r.payload_enc); }
