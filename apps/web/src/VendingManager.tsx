import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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

type AchievementRoom = {
  guild_id:string;
  owner_id:string;
  channel_id:string|null;
  machine_ids:string[];
  updated_at:number;
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
  const [activeSection,setActiveSection]=useState<"panel"|"products"|"settings">("panel");
  const [mobilePanelView,setMobilePanelView]=useState<"edit"|"preview">("edit");
  const productEditorRef=useRef<HTMLDivElement>(null);
  const [machines,setMachines]=useState<Machine[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const detailRequest=useRef(0);
  const [detailLoading,setDetailLoading]=useState(false);
  const [detail,setDetail]=useState<MachineDetail|null>(null);
  const [newMachineName,setNewMachineName]=useState("");
  const [busy,setBusy]=useState(false);
  const [panelPreviewMode,setPanelPreviewMode]=useState<"desktop"|"mobile">(
    ()=>window.matchMedia("(max-width: 700px)").matches?"mobile":"desktop"
  );

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
  const [panelMessageUrl,setPanelMessageUrl]=useState("");
  const [notifyChannel,setNotifyChannel]=useState("");
  const [notifyRole,setNotifyRole]=useState("");
  const [achievementChannel,setAchievementChannel]=useState("");
  const [achievementMachineIds,setAchievementMachineIds]=useState<string[]>([]);

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
  useEffect(()=>{
    if(activeSection==="products"&&editingProduct){
      productEditorRef.current?.scrollIntoView({block:"start",behavior:"smooth"});
    }
  },[activeSection,editingProduct]);
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

  const previewProducts = useMemo(()=>{
    if(!detail) return [] as Product[];
    return detail.products.map(product=>{
      if(!editingProduct||editingProduct.id!==product.id) return product;
      return {
        ...product,
        name:productEdit.name,
        description:productEdit.description,
        price_paypay:productEdit.pricePayPay,
        price_kyash:productEdit.priceKyash,
        emoji:productEdit.emoji||null,
        infinite_stock:productEdit.infiniteStock?1:0
      };
    });
  },[detail,editingProduct,productEdit]);

  const panelDirty = detail!==null && (
    machineForm.name!==detail.name ||
    machineForm.panelTitle!==(detail.panel_title??"") ||
    machineForm.panelDescription!==(detail.panel_description??"") ||
    machineForm.panelImageUrl!==(detail.panel_image_url??"") ||
    machineForm.roleId!==(detail.role_id??"") ||
    machineForm.publicLogChannelId!==(detail.public_log_channel_id??"") ||
    machineForm.localLogChannelId!==(detail.local_log_channel_id??"") ||
    machineForm.privateLogChannelId!==(detail.private_log_channel_id??"")
  );

  const productDirty = Boolean(editingProduct) && (
    productEdit.name!==editingProduct!.name ||
    productEdit.description!==editingProduct!.description ||
    productEdit.pricePayPay!==editingProduct!.price_paypay ||
    productEdit.priceKyash!==editingProduct!.price_kyash ||
    productEdit.emoji!==(editingProduct!.emoji??"") ||
    productEdit.infiniteStock!==Boolean(editingProduct!.infinite_stock) ||
    productEdit.infiniteContent!==(editingProduct!.infinite_content??"")
  );

  const previewChannelName =
    channels.find(channel=>channel.id===panelChannel)?.name ?? "販売";

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
    const request=++detailRequest.current;
    setDetailLoading(true);
    try{
      const [data,notification]=await Promise.all([
        api<MachineDetail>(`/api/guilds/${guildId}/vending/${id}`),
        api<{channel_id:string;role_id:string}|null>(
          `/api/guilds/${guildId}/vending/${id}/stock-notification`
        )
      ]);
      if(request!==detailRequest.current) return;
      setDetail(data);
      setNotifyChannel(notification?.channel_id??"");
      setNotifyRole(notification?.role_id??"");
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
    }finally{
      if(request===detailRequest.current) setDetailLoading(false);
    }
  }

  async function loadPaymentStatus(){
    try{
      const status=await api<{paypay:boolean;kyash:boolean}>("/api/vending/payments/status");
      setPaymentStatus(status);
    }catch(reason){
      onError(reason);
    }
  }

  async function loadAchievementRoom(){
    const room=await api<AchievementRoom>(
      `/api/guilds/${guildId}/vending/achievement-room`
    );
    setAchievementChannel(room.channel_id??"");
    setAchievementMachineIds(room.machine_ids);
  }

  useEffect(()=>{
    void (async()=>{
      try{
        await Promise.all([loadMachines(),loadPaymentStatus(),loadAchievementRoom()]);
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

  async function persistMachine(){
    if(!selectedId) return;
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
  }

  async function persistEditingProduct(){
    if(!selectedId||!editingProduct||!productDirty) return;
    await api(
      `/api/guilds/${guildId}/vending/${selectedId}/products/${editingProduct.id}`,
      {
        method:"PATCH",
        body:JSON.stringify(productEdit)
      }
    );
  }

  async function saveMachine(){
    if(!selectedId) return;
    setBusy(true);
    try{
      await persistMachine();
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
      await persistEditingProduct();
      await persistMachine();
      await api(`/api/guilds/${guildId}/vending/${selectedId}/panel`,{
        method:"POST",
        body:JSON.stringify({channelId:panelChannel})
      });
      await loadMachines(selectedId);
      onNotice("プレビュー内容を保存してDiscordへ設置しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function updatePanel(){
    if(!selectedId||!panelMessageUrl.trim()) return;
    setBusy(true);
    try{
      await persistEditingProduct();
      await persistMachine();
      await api(`/api/guilds/${guildId}/vending/${selectedId}/panel/update`,{
        method:"POST",
        body:JSON.stringify({messageUrl:panelMessageUrl.trim()})
      });
      await loadMachines(selectedId);
      onNotice("プレビュー内容を保存して既存パネルを更新しました");
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

  async function clearStockNotification(){
    if(!selectedId) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/stock-notification`,{method:"DELETE"});
      setNotifyChannel("");
      setNotifyRole("");
      onNotice("在庫追加通知を解除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function saveAchievementRoom(){
    if(!achievementChannel||achievementMachineIds.length===0) return;
    setBusy(true);
    try{
      const validIds=achievementMachineIds.filter(id=>machines.some(machine=>machine.id===id));
      if(validIds.length===0){
        throw new Error("通知する自販機を1つ以上選択してください");
      }
      const room=await api<AchievementRoom>(
        `/api/guilds/${guildId}/vending/achievement-room`,
        {
          method:"PUT",
          body:JSON.stringify({
            channelId:achievementChannel,
            machineIds:validIds
          })
        }
      );
      setAchievementChannel(room.channel_id??"");
      setAchievementMachineIds(room.machine_ids);
      onNotice("実績部屋の通知設定を保存しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function clearAchievementRoom(){
    setBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/vending/achievement-room`,
        {method:"DELETE"}
      );
      setAchievementChannel("");
      setAchievementMachineIds([]);
      onNotice("実績部屋の通知を解除しました");
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
    setActiveSection("products");
    if(editingProduct?.id===product.id) return;
    if(productDirty&&!window.confirm("編集中の商品に未保存の変更があります。破棄して別の商品を開きますか？")) return;
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
      const lines=stockText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      let added=0;
      for(let offset=0;offset<lines.length;offset+=400){
        const result=await api<{added:number}>(
          `/api/guilds/${guildId}/vending/${selectedId}/products/${editingProduct.id}/stock`,
          {method:"POST",body:JSON.stringify({
            lines:lines.slice(offset,offset+400),
            notify:offset+400>=lines.length
          })}
        );
        added+=result.added;
      }
      setStockText("");
      await loadDetail(selectedId);
      onNotice(`${added}件の在庫を追加しました`);
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

  async function disconnectPayPay(){
    if(!window.confirm("保存されているPayPay接続情報を削除しますか？")) return;
    setBusy(true);
    try{
      await api("/api/vending/paypay/logout",{method:"POST"});
      await loadPaymentStatus();
      onNotice("PayPayアカウントを切断しました");
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
    <section className="card vending-manager" inert={busy||detailLoading} aria-busy={busy||detailLoading}>
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
                disabled={busy||detailLoading}
                onClick={()=>{
                  setSelectedId(machine.id);
                  setDetail(null);
                  setEditingProduct(null);
                  void loadDetail(machine.id).catch(onError);
                }}
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

          <details className="payment-connect">
            <summary>決済アカウント・接続設定</summary>
            {paymentStatus.paypay&&(
              <button className="danger vending-disconnect" onClick={()=>void disconnectPayPay()} disabled={busy}>
                PayPay切断
              </button>
            )}
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
          </details>
        </aside>

        <div className="vending-main">
          {!selected||!detail ? (
            <div className="vending-select-prompt">
              <strong>自販機を作成または選択してください</strong>
              <span>複数の自販機をサーバーごとに管理できます。</span>
            </div>
          ) : (
            <>
              <nav className="vending-section-nav" aria-label="自販機の管理メニュー">
                {([['panel','パネル'],['products','商品・在庫'],['settings','クーポン・通知']] as const).map(([id,label])=>(
                  <button type="button" key={id} aria-pressed={activeSection===id} onClick={()=>setActiveSection(id)}>{label}</button>
                ))}
              </nav>
              <div hidden={activeSection!=="panel"} className="vending-tabs-section vending-designer-section">
                <div className="section-head compact">
                  <div>
                    <span className="eyebrow">WYSIWYG PANEL DESIGNER</span>
                    <h3>{detail.name}</h3>
                    <small className="vending-designer-subtitle">
                      設定とプレビューは連動します。商品をタップすると編集できます
                    </small>
                  </div>
                  <div className="button-row">
                    {panelDirty&&(
                      <span className="vending-unsaved">● 未保存</span>
                    )}
                    <button className="primary" onClick={()=>void saveMachine()} disabled={busy}>
                      {busy?"保存中…":"設定を保存"}
                    </button>
                    <button className="danger" onClick={()=>void removeMachine()} disabled={busy}>削除</button>
                  </div>
                </div>

                <div className="vending-mobile-view" aria-label="パネルの表示切り替え">
                  <button type="button" aria-pressed={mobilePanelView==="edit"} onClick={()=>setMobilePanelView("edit")}>設定を編集</button>
                  <button type="button" aria-pressed={mobilePanelView==="preview"} onClick={()=>setMobilePanelView("preview")}>プレビュー・設置</button>
                </div>
                <div className={`vending-designer-layout vending-view-${mobilePanelView}`}>
                  <div className="vending-designer-controls">
                    <div className="vending-control-group">
                      <span className="vending-control-title">基本設定</span>
                      <label className="field">
                        <span>自販機名</span>
                        <input
                          value={machineForm.name}
                          onChange={e=>setMachineForm({...machineForm,name:e.target.value})}
                          maxLength={80}
                        />
                      </label>
                      <label className="field">
                        <span>購入後ロール</span>
                        <select
                          value={machineForm.roleId}
                          onChange={e=>setMachineForm({...machineForm,roleId:e.target.value})}
                        >
                          <option value="">付与なし</option>
                          {roles.map(role=><option key={role.id} value={role.id}>@{role.name}</option>)}
                        </select>
                      </label>
                    </div>

                    <div className="vending-control-group">
                      <span className="vending-control-title">パネルデザイン</span>
                      <label className="field">
                        <span>タイトル</span>
                        <input
                          value={machineForm.panelTitle}
                          onChange={e=>setMachineForm({...machineForm,panelTitle:e.target.value})}
                          placeholder={machineForm.name||"自販機"}
                          maxLength={256}
                        />
                      </label>
                      <label className="field">
                        <span>説明</span>
                        <textarea
                          value={machineForm.panelDescription}
                          onChange={e=>setMachineForm({...machineForm,panelDescription:e.target.value})}
                          placeholder="購入したい商品を下のボタンから選択してください。"
                          maxLength={3000}
                        />
                      </label>
                      <label className="field">
                        <span>画像URL</span>
                        <input
                          value={machineForm.panelImageUrl}
                          onChange={e=>setMachineForm({...machineForm,panelImageUrl:e.target.value})}
                          placeholder="https://..."
                          inputMode="url"
                        />
                      </label>
                    </div>

                    <details className="vending-advanced-settings">
                      <summary>ログ・通知設定</summary>
                      <div className="form-grid two">
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
                      </div>
                    </details>
                  </div>

                  <div className="vending-preview-pane">
                    <div className="vending-preview-toolbar">
                      <div>
                        <span className="eyebrow">LIVE PREVIEW</span>
                        <strong>Discord表示</strong>
                      </div>
                      <div className="vending-preview-size">
                        <button
                          type="button"
                          className={panelPreviewMode==="desktop"?"active":""}
                          onClick={()=>setPanelPreviewMode("desktop")}
                        >
                          PC
                        </button>
                        <button
                          type="button"
                          className={panelPreviewMode==="mobile"?"active":""}
                          onClick={()=>setPanelPreviewMode("mobile")}
                        >
                          MOBILE
                        </button>
                      </div>
                    </div>

                    <div className={`vending-discord-stage ${panelPreviewMode}`}>
                      <div className="vending-discord-window">
                        <div className="vending-discord-channelbar">
                          <span>#</span>
                          <strong>{previewChannelName}</strong>
                        </div>

                        <div className="vending-discord-message">
                          <div className="vending-bot-avatar">D</div>
                          <div className="vending-message-body">
                            <div className="vending-message-author">
                              <strong>CHICKEN🐣BOT</strong>
                              <span className="vending-bot-tag">BOT</span>
                              <small>今日 04:14</small>
                            </div>

                            <div className="vending-discord-embed">
                              <input
                                className="vending-wysiwyg-title"
                                value={machineForm.panelTitle}
                                onChange={e=>setMachineForm({...machineForm,panelTitle:e.target.value})}
                                placeholder={machineForm.name||"自販機"}
                                aria-label="パネルタイトル"
                                maxLength={256}
                              />

                              <textarea
                                className="vending-wysiwyg-description"
                                value={machineForm.panelDescription}
                                onChange={e=>setMachineForm({...machineForm,panelDescription:e.target.value})}
                                placeholder="購入したい商品を下のボタンから選択してください。"
                                aria-label="パネル説明"
                                maxLength={3000}
                              />

                              <div className="vending-preview-products">
                                {previewProducts.length ? previewProducts.map(product=>(
                                  <button
                                    type="button"
                                    className={`vending-preview-product ${editingProduct?.id===product.id?"editing":""}`}
                                    key={product.id}
                                    onClick={()=>editProduct(detail.products.find(item=>item.id===product.id)??product)}
                                    title="クリックして商品を編集"
                                  >
                                    <strong>{product.emoji?product.emoji+" ":""}{product.name}</strong>
                                    <span>
                                      PayPay: {product.price_paypay}円 / Kyash: {product.price_kyash}円 / 在庫: {product.infinite_stock?"∞":product.stock_count} / 販売: {product.sales_count}
                                    </span>
                                  </button>
                                )):(
                                  <div className="vending-preview-empty-product">
                                    現在販売中の商品はありません。
                                  </div>
                                )}
                              </div>

                              {machineForm.panelImageUrl&&(
                                <img
                                  className="vending-preview-image"
                                  src={machineForm.panelImageUrl}
                                  alt="パネル画像プレビュー"
                                />
                              )}
                            </div>

                            <div className="vending-discord-components">
                              <button type="button" className="discord-component green" tabIndex={-1}>
                                <span>🛒</span> 購入する
                              </button>
                              <button type="button" className="discord-component blue" tabIndex={-1}>
                                <span>📦</span> 在庫・販売数
                              </button>
                            </div>

                            <div className="vending-preview-match">
                              <span>✓</span>
                              このプレビューと同じ設定を保存してからDiscordへ投稿します
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="vending-publish-box">
                      <div className="vending-publish-row">
                        <select value={panelChannel} onChange={e=>setPanelChannel(e.target.value)}>
                          <option value="">設置先チャンネル</option>
                          {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                        </select>
                        <button className="primary" onClick={()=>void publishPanel()} disabled={!panelChannel||busy}>
                          {busy?"反映中…":"この見た目でDiscordに設置"}
                        </button>
                      </div>
                      <div className="vending-panel-update">
                        <input
                          value={panelMessageUrl}
                          onChange={e=>setPanelMessageUrl(e.target.value)}
                          placeholder="既存パネルのDiscordメッセージURL"
                        />
                        <button className="secondary" onClick={()=>void updatePanel()} disabled={!panelMessageUrl.trim()||busy}>
                          この見た目で既存パネル更新
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div hidden={activeSection!=="products"} className="vending-tabs-section vending-products-section">
                <div className="section-head compact">
                  <div>
                    <span className="eyebrow">PRODUCTS</span>
                    <h3>商品・在庫</h3>
                  </div>
                  <span className="status-pill"><i /> {detail.products.length} products</span>
                </div>

                <details className="vending-add-product">
                  <summary>＋ 新しい商品を追加</summary>
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

                </details>
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
                  <div className="vending-product-editor" ref={productEditorRef}>
                    <div className="section-head compact">
                      <h3>{editingProduct.name} を編集 {productDirty&&<span className="vending-unsaved">● 未保存</span>}</h3>
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
                        <div className="vending-stock-file-row">
                          <label className="secondary vending-file-button">
                            TXTを読み込む
                            <input
                              type="file"
                              accept=".txt,text/plain"
                              onChange={(event)=>{
                                const file=event.target.files?.[0];
                                if(!file) return;
                                void file.text().then(text=>setStockText(text)).catch(onError);
                                event.currentTarget.value="";
                              }}
                            />
                          </label>
                          <small>{stockText ? stockText.split(/\r?\n/).filter(Boolean).length+"行を読込済み" : "1行＝在庫1件"}</small>
                        </div>
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

              <div hidden={activeSection!=="settings"} className="vending-grid-two">
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
                  <div className="button-row">
                    <button className="secondary" onClick={()=>void saveStockNotification()} disabled={!notifyChannel||!notifyRole}>通知設定を保存</button>
                    <button className="danger" onClick={()=>void clearStockNotification()} disabled={!notifyChannel&&!notifyRole}>解除</button>
                  </div>
                </div>

                <div className="vending-tabs-section">
                  <span className="eyebrow">ACHIEVEMENT ROOM</span>
                  <h3>実績部屋</h3>
                  <p className="muted">
                    購入完了時に「🎉 商品購入ログ」を送信します。通知したい自販機だけ選べます。
                  </p>
                  <label className="field"><span>実績を送るチャンネル</span>
                    <select value={achievementChannel} onChange={e=>setAchievementChannel(e.target.value)}>
                      <option value="">選択</option>
                      {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                    </select>
                  </label>
                  <div className="field">
                    <span>通知する自販機</span>
                    <div className="role-picker">
                      {machines.map(machine=>{
                        const checked=achievementMachineIds.includes(machine.id);
                        return (
                          <label
                            key={machine.id}
                            className={`role-choice ${checked?"selected":""}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={event=>{
                                setAchievementMachineIds(current=>
                                  event.target.checked
                                    ? [...new Set([...current,machine.id])]
                                    : current.filter(id=>id!==machine.id)
                                );
                              }}
                            />
                            <span>{machine.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      className="secondary"
                      type="button"
                      onClick={()=>setAchievementMachineIds(machines.map(machine=>machine.id))}
                      disabled={machines.length===0}
                    >
                      すべて選択
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={()=>setAchievementMachineIds([])}
                      disabled={achievementMachineIds.length===0}
                    >
                      全解除
                    </button>
                  </div>
                  <div className="button-row">
                    <button
                      className="primary"
                      type="button"
                      onClick={()=>void saveAchievementRoom()}
                      disabled={!achievementChannel||achievementMachineIds.length===0||busy}
                    >
                      実績部屋を保存
                    </button>
                    <button
                      className="danger"
                      type="button"
                      onClick={()=>void clearAchievementRoom()}
                      disabled={!achievementChannel&&achievementMachineIds.length===0}
                    >
                      実績部屋を解除
                    </button>
                  </div>
                  <small className="muted">
                    通知内容: 購入者 / 商品名 / 個数 / 注文ID
                  </small>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
