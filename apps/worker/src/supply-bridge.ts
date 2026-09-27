import type { Env } from "./types";
import { getVmProduct } from "./vending-db";
import { json, randomId, sha256Hex } from "./utils";

const MAX_CLOCK_SKEW_MS=5*60_000;
let supplySchemaReady=false;

async function ensureSupplySchema(env:Env){
  if(supplySchemaReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS vending_supply_nonces (nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS vending_supply_receipts (idempotency_key TEXT PRIMARY KEY,product_id TEXT NOT NULL,payload_hash TEXT NOT NULL,added_count INTEGER NOT NULL,created_at INTEGER NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS vending_supply_fingerprints (product_id TEXT NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(product_id,content_hash))"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS vending_supply_receipts_product_idx ON vending_supply_receipts(product_id,created_at)"
  ).run();
  supplySchemaReady=true;
}

function hexToBytes(value:string):Uint8Array|null{
  if(!/^[0-9a-f]{64}$/i.test(value)) return null;
  const out=new Uint8Array(value.length/2);
  for(let i=0;i<out.length;i++) out[i]=parseInt(value.slice(i*2,i*2+2),16);
  return out;
}

async function verifySignedRequest(
  request:Request,
  env:Env,
  url:URL,
  body:string
):Promise<void>{
  const secret=env.SHIIRE_BRIDGE_SECRET?.trim()??"";
  if(secret.length<32) throw new Error("SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED");

  const timestamp=request.headers.get("X-Shiire-Timestamp")?.trim()??"";
  const nonce=request.headers.get("X-Shiire-Nonce")?.trim()??"";
  const signature=request.headers.get("X-Shiire-Signature")?.trim()??"";
  const timestampNumber=Number(timestamp);
  if(!/^\d{10,16}$/.test(timestamp)||!Number.isFinite(timestampNumber)){
    throw new Error("INVALID_TIMESTAMP");
  }
  if(Math.abs(Date.now()-timestampNumber)>MAX_CLOCK_SKEW_MS){
    throw new Error("STALE_TIMESTAMP");
  }
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)){
    throw new Error("INVALID_NONCE");
  }
  const signatureBytes=hexToBytes(signature);
  if(!signatureBytes) throw new Error("INVALID_SIGNATURE");

  const canonical=
    timestamp+"\n"+
    nonce+"\n"+
    request.method.toUpperCase()+"\n"+
    url.pathname+url.search+"\n"+
    body;
  const key=await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["verify"]
  );
  const valid=await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(canonical)
  );
  if(!valid) throw new Error("INVALID_SIGNATURE");

  await ensureSupplySchema(env);
  const now=Date.now();
  await env.DB.prepare("DELETE FROM vending_supply_nonces WHERE expires_at<?")
    .bind(now).run();
  try{
    await env.DB.prepare(
      "INSERT INTO vending_supply_nonces(nonce,expires_at) VALUES (?,?)"
    ).bind(nonce,now+MAX_CLOCK_SKEW_MS).run();
  }catch{
    throw new Error("REPLAYED_NONCE");
  }
}

function bridgeError(env:Env,error:unknown):Response{
  const code=error instanceof Error?error.message:String(error);
  const authCodes=new Set([
    "SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED",
    "INVALID_TIMESTAMP",
    "STALE_TIMESTAMP",
    "INVALID_NONCE",
    "INVALID_SIGNATURE",
    "REPLAYED_NONCE"
  ]);
  const status=code==="SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED"?503:authCodes.has(code)?401:500;
  return json(env,{error:code},status);
}

async function reserveNewFingerprints(
  env:Env,
  productId:string,
  items:string[]
):Promise<Array<{content:string;hash:string}>>{
  const unique=[...new Set(items.map(item=>item.trim()).filter(Boolean))];
  const rows=await Promise.all(unique.map(async content=>({
    content,
    hash:await sha256Hex(content)
  })));
  const accepted:Array<{content:string;hash:string}>=[];
  const now=Date.now();
  for(let i=0;i<rows.length;i+=50){
    const chunk=rows.slice(i,i+50);
    const results=await env.DB.batch(chunk.map(row=>
      env.DB.prepare(
        "INSERT OR IGNORE INTO vending_supply_fingerprints(product_id,content_hash,created_at) VALUES (?,?,?)"
      ).bind(productId,row.hash,now)
    ));
    results.forEach((result,index)=>{
      if((result.meta.changes??0)>0) accepted.push(chunk[index]!);
    });
  }
  return accepted;
}

async function rollbackFingerprints(
  env:Env,
  productId:string,
  rows:Array<{hash:string}>
){
  for(let i=0;i<rows.length;i+=50){
    await env.DB.batch(rows.slice(i,i+50).map(row=>
      env.DB.prepare(
        "DELETE FROM vending_supply_fingerprints WHERE product_id=? AND content_hash=?"
      ).bind(productId,row.hash)
    ));
  }
}

async function insertStock(
  env:Env,
  productId:string,
  rows:Array<{content:string;hash:string}>
):Promise<number>{
  if(rows.length===0) return 0;
  const now=Date.now();
  try{
    for(let i=0;i<rows.length;i+=50){
      const chunk=rows.slice(i,i+50);
      await env.DB.batch(chunk.map(row=>
        env.DB.prepare(
          "INSERT INTO vending_stock(id,product_id,content,state,created_at) VALUES (?,?,?,'available',?)"
        ).bind(randomId(),productId,row.content,now)
      ));
    }
    return rows.length;
  }catch(error){
    await rollbackFingerprints(env,productId,rows).catch(()=>undefined);
    throw error;
  }
}

export async function handleSupplyBridge(
  request:Request,
  env:Env,
  url:URL
):Promise<Response|null>{
  if(!url.pathname.startsWith("/api/vending/supply/")) return null;

  try{
    if(request.method==="GET"){
      await verifySignedRequest(request,env,url,"");
      const stockMatch=url.pathname.match(/^\/api\/vending\/supply\/products\/([^/]+)\/stock$/);
      if(!stockMatch) return json(env,{error:"not_found"},404);
      const productId=decodeURIComponent(stockMatch[1]!);
      const product=await getVmProduct(env,productId);
      if(!product) return json(env,{error:"product_not_found"},404);
      if(product.infinite_stock){
        return json(env,{error:"infinite_stock_not_supported"},409);
      }
      const row=await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM vending_stock WHERE product_id=? AND state='available'"
      ).bind(productId).first<{count:number}>();
      return json(env,{
        productId,
        name:product.name,
        available:Number(row?.count??0),
        infinite:false
      });
    }

    if(request.method==="POST"&&url.pathname==="/api/vending/supply/deliver"){
      const body=await request.text();
      await verifySignedRequest(request,env,url,body);
      let parsed:{productId?:unknown;items?:unknown;idempotencyKey?:unknown};
      try{
        parsed=JSON.parse(body) as typeof parsed;
      }catch{
        return json(env,{error:"invalid_json"},400);
      }
      const productId=String(parsed.productId??"").trim();
      const idempotencyKey=String(parsed.idempotencyKey??"").trim();
      const items=Array.isArray(parsed.items)
        ?parsed.items.map(value=>String(value)).map(value=>value.trim()).filter(Boolean)
        :[];
      if(!productId||!idempotencyKey||idempotencyKey.length>160){
        return json(env,{error:"invalid_request"},400);
      }
      if(items.length===0||items.length>500){
        return json(env,{error:"invalid_item_count"},400);
      }

      const product=await getVmProduct(env,productId);
      if(!product) return json(env,{error:"product_not_found"},404);
      if(product.infinite_stock){
        return json(env,{error:"infinite_stock_not_supported"},409);
      }

      const normalized=[...new Set(items)];
      const payloadHash=await sha256Hex(
        productId+"\n"+normalized.join("\n")
      );
      const existing=await env.DB.prepare(
        "SELECT product_id,payload_hash,added_count FROM vending_supply_receipts WHERE idempotency_key=?"
      ).bind(idempotencyKey).first<{
        product_id:string;payload_hash:string;added_count:number;
      }>();
      if(existing){
        if(existing.product_id!==productId||existing.payload_hash!==payloadHash){
          return json(env,{error:"idempotency_conflict"},409);
        }
        return json(env,{
          ok:true,
          productId,
          added:existing.added_count,
          duplicateRequest:true
        });
      }

      const accepted=await reserveNewFingerprints(env,productId,normalized);
      const added=await insertStock(env,productId,accepted);
      try{
        await env.DB.prepare(
          "INSERT INTO vending_supply_receipts(idempotency_key,product_id,payload_hash,added_count,created_at) VALUES (?,?,?,?,?)"
        ).bind(idempotencyKey,productId,payloadHash,added,Date.now()).run();
      }catch(error){
        const race=await env.DB.prepare(
          "SELECT product_id,payload_hash,added_count FROM vending_supply_receipts WHERE idempotency_key=?"
        ).bind(idempotencyKey).first<{
          product_id:string;payload_hash:string;added_count:number;
        }>();
        if(race&&race.product_id===productId&&race.payload_hash===payloadHash){
          return json(env,{
            ok:true,
            productId,
            added:race.added_count,
            duplicateRequest:true
          });
        }
        throw error;
      }

      const countRow=await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM vending_stock WHERE product_id=? AND state='available'"
      ).bind(productId).first<{count:number}>();
      return json(env,{
        ok:true,
        productId,
        added,
        skipped:normalized.length-added,
        available:Number(countRow?.count??0),
        duplicateRequest:false
      });
    }

    return json(env,{error:"method_not_allowed"},405);
  }catch(error){
    return bridgeError(env,error);
  }
}
