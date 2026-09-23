import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Channel = { id:string; name:string };
type Role = { id:string; name:string; position?:number };

type Machine = {
  id:string;
  guild_id:string;
  owner_id:string;
  name:string;
  public_log_channel_id:string|null;
  local_log_channel_id:string|null;
  private_log_channel_id:string|null;
  role_id:string|null;
  panel_title:string|null;
  panel_description:string|null;
  panel_image_url:string|null;
};

type Product = {
  id:string;
  vending_machine_id:string;
  name:string;
  description:string;
  price_paypay:number;
  price_kyash:number;
  emoji:string|null;
  infinite_stock:number;
  infinite_content:string|null;
  sales_count:number;
  stock_count:number;
};

type Coupon = { code:string; discount:number; created_at:number };

type MachineDetail = Machine & {
  products: Product[];
  coupons: Coupon[];
};

type Props = {
  guildId:string;
  channels:Channel[];
  roles:Role[];
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
};

const emptyProduct = {
  name:"",
  description:"",
  pricePayPay:0,
  priceKyash:0,
  emoji:""
};

export default function VendingManager({
  guildId, channels, roles, onNotice, onError
}:Props){
  const [machines,setMachines]=useState<Machine[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [detail,setDetail]=useState<MachineDetail|null>(null);
  const [newMachineName,setNewMachineName]=useState("");
  const [busy,setBusy]=useState(false);

  const [machineForm,setMachineForm]=useState({
    name:"",
    publicLogChannelId:"",
    localLogChannelId:"",
    privateLogChannelId:"",
    roleId:"",
    panelTitle:"",
    panelDescription:"",
    panelImageUrl:""
  });
  const [panelChannel,setPanelChannel]=useState("");
  const [notifyChannel,setNotifyChannel]=useState("");
  const [notifyRole,setNotifyRole]=useState("");

  const [newProduct,setNewProduct]=useState(emptyProduct);
  const [editingProduct,setEditingProduct]=useState<Product|null>(null);
  const [productEdit,setProductEdit]=useState({
    name:"",
    description:"",
    pricePayPay:0,
    priceKyash:0,
    emoji:"",
    infiniteStock:false,
    infiniteContent:""
  });
  const [stockText,setStockText]=useState("");
  const [stockPreview,setStockPreview]=useState<Array<{id:string;content:string}>>([]);
  const [withdrawQuantity,setWithdrawQuantity]=useState(1);

  const [couponCode,setCouponCode]=useState("");
  const [couponDiscount,setCouponDiscount]=useState(100);

  const [paymentStatus,setPaymentStatus]=useState({paypay:false,kyash:false});
  const [payPayForm,setPayPayForm]=useState({phone:"",password:"",challengeId:"",otp:""});
  const [kyashForm,setKyashForm]=useState({email:"",password:"",challengeId:"",otp:""});

  const selected = useMemo(
    ()=>machines.find(machine=>machine.id===selectedId)??null,
    [machines,selectedId]
  );

  async function loadMachines(preferId?:string|null){
    const list=await api<Machine[]>(`/api/guilds/${guildId}/vending`);
    setMachines(list);
    const nextId=
      (preferId&&list.some(vm=>vm.id===preferId)?preferId:null) ??
      (selectedId&&list.some(vm=>vm.id===selectedId)?selectedId:null) ??
      list[0]?.id ??
      null;
    setSelectedId(nextId);
    if(nextId) await loadDetail(nextId);
    else setDetail(null);
  }

  async function loadDetail(id:string){
    const data=await api<MachineDetail>(`/api/guilds/${guildId}/vending/${id}`);
    setDetail(data);
    setMachineForm({
      name:data.name,
      publicLogChannelId:data.public_log_channel_id??"",
      localLogChannelId:data.local_log_channel_id??"",
      privateLogChannelId:data.private_log_channel_id??"",
      roleId:data.role_id??"",
      panelTitle:data.panel_title??"",
      panelDescription:data.panel_description??"",
      panelImageUrl:data.panel_image_url??""
    });
  }

  async function loadPaymentStatus(){
    try{
      const status=await api<{paypay:boolean;kyash:boolean}>("/api/vending/payments/status");
      setPaymentStatus(status);
    }catch(reason){
      onError(reason);
    }
  }

  useEffect(()=>{
    void (async()=>{
      try{
        await Promise.all([loadMachines(),loadPaymentStatus()]);
      }catch(reason){ onError(reason); }
    })();
  },[guildId]);

  async function createMachine(event:FormEvent){
    event.preventDefault();
    const name=newMachineName.trim();
    if(!name) return;
    setBusy(true);
    try{
      const vm=await api<Machine>(`/api/guilds/${guildId}/vending`,{
        method:"POST",
        body:JSON.stringify({name})
      });
      setNewMachineName("");
      await loadMachines(vm.id);
      onNotice("自販機を作成しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function saveMachine(){
    if(!selectedId) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}`,{
        method:"PATCH",
        body:JSON.stringify({
          name:machineForm.name,
          publicLogChannelId:machineForm.publicLogChannelId||null,
          localLogChannelId:machineForm.localLogChannelId||null,
          privateLogChannelId:machineForm.privateLogChannelId||null,
          roleId:machineForm.roleId||null,
          panelTitle:machineForm.panelTitle||null,
          panelDescription:machineForm.panelDescription||null,
          panelImageUrl:machineForm.panelImageUrl||null
        })
      });
      await loadMachines(selectedId);
      onNotice("自販機設定を保存しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function removeMachine(){
    if(!selectedId||!detail) return;
    if(!window.confirm(`自販機「${detail.name}」を削除しますか？`)) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}`,{method:"DELETE"});
      await loadMachines(null);
      onNotice("自販機を削除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function publishPanel(){
    if(!selectedId||!panelChannel) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/panel`,{
        method:"POST",
        body:JSON.stringify({channelId:panelChannel})
      });
      onNotice("Discordへ自販機パネルを設置しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function saveStockNotification(){
    if(!selectedId||!notifyChannel||!notifyRole) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/stock-notification`,{
        method:"POST",
        body:JSON.stringify({channelId:notifyChannel,roleId:notifyRole})
      });
      onNotice("在庫追加通知を設定しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function addProduct(event:FormEvent){
    event.preventDefault();
    if(!selectedId||!newProduct.name.trim()) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/products`,{
        method:"POST",
        body:JSON.stringify(newProduct)
      });
      setNewProduct(emptyProduct);
      await loadDetail(selectedId);
      onNotice("商品を追加しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  function editProduct(product:Product){
    setEditingProduct(product);
    setProductEdit({
      name:product.name,
      description:product.description,
      pricePayPay:product.price_paypay,
      priceKyash:product.price_kyash,
      emoji:product.emoji??"",
      infiniteStock:Boolean(product.infinite_stock),
      infiniteContent:product.infinite_content??""
    });
    setStockText("");
    setStockPreview([]);
  }

  async function saveProduct(){
    if(!selectedId||!editingProduct) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/products/${editingProduct.id}`,{
        method:"PATCH",
        body:JSON.stringify(productEdit)
      });
      await loadDetail(selectedId);
      setEditingProduct(null);
      onNotice("商品情報を更新しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function removeProduct(product:Product){
    if(!selectedId||!window.confirm(`商品「${product.name}」を削除しますか？`)) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/products/${product.id}`,{method:"DELETE"});
      await loadDetail(selectedId);
      if(editingProduct?.id===product.id) setEditingProduct(null);
      onNotice("商品を削除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function addStock(){
    if(!selectedId||!editingProduct||!stockText.trim()) return;
    setBusy(true);
    try{
      const result=await api<{added:number}>(
        `/api/guilds/${guildId}/vending/${selectedId}/products/${editingProduct.id}/stock`,
        {method:"POST",body:JSON.stringify({text:stockText})}
      );
      setStockText("");
      await loadDetail(selectedId);
      onNotice(`${result.added}件の在庫を追加しました`);
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function viewStock(){
    if(!selectedId||!editingProduct) return;
    try{
      const items=await api<Array<{id:string;content:string}>>(
        `/api/guilds/${guildId}/vending/${selectedId}/products/${editingProduct.id}/stock`
      );
      setStockPreview(items);
    }catch(reason){onError(reason);}
  }

  async function withdraw(){
    if(!selectedId||!editingProduct) return;
    setBusy(true);
    try{
      const result=await api<{items:string[]}>(
        `/api/guilds/${guildId}/vending/${selectedId}/products/${editingProduct.id}/withdraw`,
        {method:"POST",body:JSON.stringify({quantity:withdrawQuantity})}
      );
      await loadDetail(selectedId);
      setStockPreview(result.items.map((content,index)=>({id:String(index),content})));
      onNotice(`${result.items.length}件の在庫を引き出しました`);
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function addCoupon(event:FormEvent){
    event.preventDefault();
    if(!selectedId||!couponCode.trim()) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/coupons`,{
        method:"POST",
        body:JSON.stringify({code:couponCode.trim(),discount:couponDiscount})
      });
      setCouponCode("");
      await loadDetail(selectedId);
      onNotice("クーポンを追加しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function removeCoupon(code:string){
    if(!selectedId) return;
    setBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/vending/${selectedId}/coupons/${encodeURIComponent(code)}`,
        {method:"DELETE"}
      );
      await loadDetail(selectedId);
      onNotice("クーポンを削除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function startPayPay(event:FormEvent){
    event.preventDefault();
    setBusy(true);
    try{
      const result=await api<{challengeId:string}>("/api/vending/paypay/login/start",{
        method:"POST",
        body:JSON.stringify({phone:payPayForm.phone,password:payPayForm.password})
      });
      setPayPayForm(current=>({...current,challengeId:result.challengeId,otp:""}));
      onNotice("PayPayのSMS認証コードを入力してください");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function verifyPayPay(event:FormEvent){
    event.preventDefault();
    setBusy(true);
    try{
      await api("/api/vending/paypay/login/verify",{
        method:"POST",
        body:JSON.stringify({challengeId:payPayForm.challengeId,otp:payPayForm.otp})
      });
      setPayPayForm({phone:"",password:"",challengeId:"",otp:""});
      await loadPaymentStatus();
      onNotice("PayPayアカウントを接続しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function startKyash(event:FormEvent){
    event.preventDefault();
    setBusy(true);
    try{
      const result=await api<{challengeId:string}>("/api/vending/kyash/login/start",{
        method:"POST",
        body:JSON.stringify({email:kyashForm.email,password:kyashForm.password})
      });
      setKyashForm(current=>({...current,challengeId:result.challengeId,otp:""}));
      onNotice("KyashのSMS認証コードを入力してください");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function verifyKyash(event:FormEvent){
    event.preventDefault();
    setBusy(true);
    try{
      await api("/api/vending/kyash/login/verify",{
        method:"POST",
        body:JSON.stringify({challengeId:kyashForm.challengeId,otp:kyashForm.otp})
      });
      setKyashForm({email:"",password:"",challengeId:"",otp:""});
      await loadPaymentStatus();
      onNotice("Kyashアカウントを接続しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  return (
    <section className="card vending-manager">
      <div className="section-head">
        <div>
          <span className="eyebrow">VENDING MACHINE</span>
          <h2>自販機管理</h2>
          <p className="muted">商品・在庫・クーポン・ログ・PayPay/Kyashをまとめて管理します。</p>
        </div>
        <div className="vending-payment-badges">
          <span className={`status-pill ${paymentStatus.paypay?"good":"warn"}`}><i /> PayPay {paymentStatus.paypay?"接続済み":"未接続"}</span>
          <span className={`status-pill ${paymentStatus.kyash?"good":"warn"}`}><i /> Kyash {paymentStatus.kyash?"接続済み":"未接続"}</span>
        </div>
      </div>

      <div className="vending-layout">
        <aside className="vending-sidebar">
          <form className="vending-create" onSubmit={(event)=>void createMachine(event)}>
            <input
              value={newMachineName}
              onChange={(event)=>setNewMachineName(event.target.value)}
              placeholder="新しい自販機名"
              maxLength={80}
            />
            <button className="primary" type="submit" disabled={busy}>＋</button>
          </form>

          <div className="vending-machine-list">
            {machines.map(machine=>(
              <button
                key={machine.id}
                className={`vending-machine-button ${machine.id===selectedId?"active":""}`}
                onClick={()=>{setSelectedId(machine.id);void loadDetail(machine.id);}}
              >
                <span className="vending-machine-icon">▣</span>
                <span>
                  <strong>{machine.name}</strong>
                  <small>{machine.id.slice(0,8)}</small>
                </span>
              </button>
            ))}
            {machines.length===0&&<div className="vending-empty">まだ自販機がありません。</div>}
          </div>

          <div className="payment-connect">
            <strong>決済アカウント</strong>
            {!paymentStatus.paypay&&(
              payPayForm.challengeId ? (
                <form onSubmit={(event)=>void verifyPayPay(event)}>
                  <input
                    value={payPayForm.otp}
                    onChange={(event)=>setPayPayForm({...payPayForm,otp:event.target.value})}
                    placeholder="PayPay OTP"
                    inputMode="numeric"
                    maxLength={6}
                  />
                  <button className="secondary" type="submit">認証</button>
                </form>
              ) : (
                <form onSubmit={(event)=>void startPayPay(event)}>
                  <input
                    value={payPayForm.phone}
                    onChange={(event)=>setPayPayForm({...payPayForm,phone:event.target.value})}
                    placeholder="PayPay 電話番号"
                    autoComplete="tel"
                  />
                  <input
                    type="password"
                    value={payPayForm.password}
                    onChange={(event)=>setPayPayForm({...payPayForm,password:event.target.value})}
                    placeholder="PayPay パスワード"
                    autoComplete="current-password"
                  />
                  <button className="secondary" type="submit">PayPay接続</button>
                </form>
              )
            )}

            {!paymentStatus.kyash&&(
              kyashForm.challengeId ? (
                <form onSubmit={(event)=>void verifyKyash(event)}>
                  <input
                    value={kyashForm.otp}
                    onChange={(event)=>setKyashForm({...kyashForm,otp:event.target.value})}
                    placeholder="Kyash OTP"
                    inputMode="numeric"
                    maxLength={8}
                  />
                  <button className="secondary" type="submit">認証</button>
                </form>
              ) : (
                <form onSubmit={(event)=>void startKyash(event)}>
                  <input
                    type="email"
                    value={kyashForm.email}
                    onChange={(event)=>setKyashForm({...kyashForm,email:event.target.value})}
                    placeholder="Kyash メール"
                    autoComplete="email"
                  />
                  <input
                    type="password"
                    value={kyashForm.password}
                    onChange={(event)=>setKyashForm({...kyashForm,password:event.target.value})}
                    placeholder="Kyash パスワード"
                    autoComplete="current-password"
                  />
                  <button className="secondary" type="submit">Kyash接続</button>
                </form>
              )
            )}
          </div>
        </aside>

        <div className="vending-main">
          {!selected||!detail ? (
            <div className="vending-select-prompt">
              <strong>自販機を作成または選択してください</strong>
              <span>複数の自販機をサーバーごとに管理できます。</span>
            </div>
          ) : (
            <>
              <div className="vending-tabs-section">
                <div className="section-head compact">
                  <div>
                    <span className="eyebrow">SETTINGS</span>
                    <h3>{detail.name}</h3>
                  </div>
                  <div className="button-row">
                    <button className="primary" onClick={()=>void saveMachine()} disabled={busy}>保存</button>
                    <button className="danger" onClick={()=>void removeMachine()} disabled={busy}>削除</button>
                  </div>
                </div>

                <div className="form-grid two">
                  <label className="field"><span>自販機名</span><input value={machineForm.name} onChange={e=>setMachineForm({...machineForm,name:e.target.value})}/></label>
                  <label className="field"><span>購入後ロール</span>
                    <select value={machineForm.roleId} onChange={e=>setMachineForm({...machineForm,roleId:e.target.value})}>
                      <option value="">付与なし</option>
                      {roles.map(role=><option key={role.id} value={role.id}>@{role.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>公開販売ログ</span>
                    <select value={machineForm.publicLogChannelId} onChange={e=>setMachineForm({...machineForm,publicLogChannelId:e.target.value})}>
                      <option value="">未設定</option>
                      {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>このサーバーの購入ログ</span>
                    <select value={machineForm.localLogChannelId} onChange={e=>setMachineForm({...machineForm,localLogChannelId:e.target.value})}>
                      <option value="">未設定</option>
                      {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>非公開ログ</span>
                    <select value={machineForm.privateLogChannelId} onChange={e=>setMachineForm({...machineForm,privateLogChannelId:e.target.value})}>
                      <option value="">未設定</option>
                      {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>パネル画像URL</span><input value={machineForm.panelImageUrl} onChange={e=>setMachineForm({...machineForm,panelImageUrl:e.target.value})} placeholder="https://..."/></label>
                </div>
                <label className="field"><span>パネルタイトル</span><input value={machineForm.panelTitle} onChange={e=>setMachineForm({...machineForm,panelTitle:e.target.value})}/></label>
                <label className="field"><span>パネル説明</span><textarea value={machineForm.panelDescription} onChange={e=>setMachineForm({...machineForm,panelDescription:e.target.value})}/></label>

                <div className="vending-publish-row">
                  <select value={panelChannel} onChange={e=>setPanelChannel(e.target.value)}>
                    <option value="">設置先チャンネル</option>
                    {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                  </select>
                  <button className="primary" onClick={()=>void publishPanel()} disabled={!panelChannel||busy}>Discordに設置</button>
                </div>
              </div>

              <div className="vending-tabs-section">
                <div className="section-head compact">
                  <div>
                    <span className="eyebrow">PRODUCTS</span>
                    <h3>商品・在庫</h3>
                  </div>
                  <span className="status-pill"><i /> {detail.products.length} products</span>
                </div>

                <form className="vending-product-create" onSubmit={(event)=>void addProduct(event)}>
                  <div className="form-grid three">
                    <label className="field"><span>商品名</span><input required value={newProduct.name} onChange={e=>setNewProduct({...newProduct,name:e.target.value})}/></label>
                    <label className="field"><span>PayPay価格</span><input type="number" min={0} value={newProduct.pricePayPay} onChange={e=>setNewProduct({...newProduct,pricePayPay:Number(e.target.value)})}/></label>
                    <label className="field"><span>Kyash価格</span><input type="number" min={0} value={newProduct.priceKyash} onChange={e=>setNewProduct({...newProduct,priceKyash:Number(e.target.value)})}/></label>
                  </div>
                  <div className="form-grid two">
                    <label className="field"><span>説明</span><input value={newProduct.description} onChange={e=>setNewProduct({...newProduct,description:e.target.value})}/></label>
                    <label className="field"><span>絵文字</span><input value={newProduct.emoji} onChange={e=>setNewProduct({...newProduct,emoji:e.target.value})} placeholder="📦"/></label>
                  </div>
                  <button className="secondary" type="submit" disabled={busy}>＋ 商品を追加</button>
                </form>

                <div className="vending-products">
                  {detail.products.map(product=>(
                    <article key={product.id} className={`vending-product-card ${editingProduct?.id===product.id?"active":""}`}>
                      <button className="vending-product-summary" onClick={()=>editProduct(product)}>
                        <span className="vending-product-emoji">{product.emoji||"📦"}</span>
                        <span className="vending-product-copy">
                          <strong>{product.name}</strong>
                          <small>PayPay ¥{product.price_paypay} · Kyash ¥{product.price_kyash}</small>
                        </span>
                        <span className="vending-stock-count">{product.infinite_stock?"∞":product.stock_count}</span>
                        <span className="vending-sales">販売 {product.sales_count}</span>
                      </button>
                    </article>
                  ))}
                </div>

                {editingProduct&&(
                  <div className="vending-product-editor">
                    <div className="section-head compact">
                      <h3>{editingProduct.name} を編集</h3>
                      <button className="editor-close" onClick={()=>setEditingProduct(null)}>×</button>
                    </div>
                    <div className="form-grid three">
                      <label className="field"><span>商品名</span><input value={productEdit.name} onChange={e=>setProductEdit({...productEdit,name:e.target.value})}/></label>
                      <label className="field"><span>PayPay価格</span><input type="number" value={productEdit.pricePayPay} onChange={e=>setProductEdit({...productEdit,pricePayPay:Number(e.target.value)})}/></label>
                      <label className="field"><span>Kyash価格</span><input type="number" value={productEdit.priceKyash} onChange={e=>setProductEdit({...productEdit,priceKyash:Number(e.target.value)})}/></label>
                    </div>
                    <div className="form-grid two">
                      <label className="field"><span>説明</span><textarea value={productEdit.description} onChange={e=>setProductEdit({...productEdit,description:e.target.value})}/></label>
                      <label className="field"><span>絵文字</span><input value={productEdit.emoji} onChange={e=>setProductEdit({...productEdit,emoji:e.target.value})}/></label>
                    </div>
                    <label className="toggle-row compact-toggle">
                      <span className="toggle-copy"><strong>無限在庫</strong><small>購入数は1固定・同じ内容を納品</small></span>
                      <input type="checkbox" checked={productEdit.infiniteStock} onChange={e=>setProductEdit({...productEdit,infiniteStock:e.target.checked})}/>
                    </label>
                    {productEdit.infiniteStock&&(
                      <label className="field"><span>無限在庫の納品内容</span><textarea value={productEdit.infiniteContent} onChange={e=>setProductEdit({...productEdit,infiniteContent:e.target.value})}/></label>
                    )}
                    <div className="button-row">
                      <button className="primary" onClick={()=>void saveProduct()} disabled={busy}>商品を保存</button>
                      <button className="danger" onClick={()=>void removeProduct(editingProduct)} disabled={busy}>商品削除</button>
                    </div>

                    {!productEdit.infiniteStock&&(
                      <div className="vending-stock-editor">
                        <span className="eyebrow">FINITE STOCK</span>
                        <textarea value={stockText} onChange={e=>setStockText(e.target.value)} placeholder={"1行＝在庫1件\nコードA\nコードB\nコードC"}/>
                        <div className="button-row">
                          <button className="secondary" onClick={()=>void addStock()} disabled={!stockText.trim()||busy}>在庫追加</button>
                          <button className="secondary" onClick={()=>void viewStock()}>在庫内容確認</button>
                          <input className="withdraw-input" type="number" min={1} max={500} value={withdrawQuantity} onChange={e=>setWithdrawQuantity(Number(e.target.value))}/>
                          <button className="secondary" onClick={()=>void withdraw()}>引出</button>
                        </div>
                        {stockPreview.length>0&&(
                          <pre className="stock-preview">{stockPreview.map(item=>item.content).join("\n")}</pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="vending-grid-two">
                <div className="vending-tabs-section">
                  <span className="eyebrow">COUPONS</span>
                  <h3>クーポン</h3>
                  <form className="coupon-create" onSubmit={(event)=>void addCoupon(event)}>
                    <input value={couponCode} onChange={e=>setCouponCode(e.target.value)} placeholder="CODE"/>
                    <input type="number" min={1} value={couponDiscount} onChange={e=>setCouponDiscount(Number(e.target.value))}/>
                    <button className="secondary" type="submit">追加</button>
                  </form>
                  <div className="coupon-list">
                    {detail.coupons.map(coupon=>(
                      <div className="coupon-row" key={coupon.code}>
                        <strong>{coupon.code}</strong>
                        <span>-¥{coupon.discount}/個</span>
                        <button className="danger" onClick={()=>void removeCoupon(coupon.code)}>削除</button>
                      </div>
                    ))}
                    {detail.coupons.length===0&&<small className="muted">クーポンなし</small>}
                  </div>
                </div>

                <div className="vending-tabs-section">
                  <span className="eyebrow">STOCK ALERT</span>
                  <h3>在庫追加通知</h3>
                  <label className="field"><span>通知チャンネル</span>
                    <select value={notifyChannel} onChange={e=>setNotifyChannel(e.target.value)}>
                      <option value="">選択</option>
                      {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>メンションロール</span>
                    <select value={notifyRole} onChange={e=>setNotifyRole(e.target.value)}>
                      <option value="">選択</option>
                      {roles.map(role=><option key={role.id} value={role.id}>@{role.name}</option>)}
                    </select>
                  </label>
                  <button className="secondary" onClick={()=>void saveStockNotification()} disabled={!notifyChannel||!notifyRole}>通知設定を保存</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
