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
  id:string;
  guild_id:string;
  owner_id:string;
  channel_id:string;
  machine_ids:string[];
  count_display_enabled:number;
  achievement_count:number;
  base_channel_name:string|null;
  count_name_synced_at:number;
  created_at:number;
  updated_at:number;
};

type AchievementRoomDraft = {
  id:string;
  channelId:string;
  machineIds:string[];
  countDisplayEnabled:boolean;
  achievementCount:number;
  baseChannelName:string|null;
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
  emoji:"",
  infiniteStock:false,
  infiniteContent:""
};

function readFileAsDataUrl(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result??""));
    reader.onerror=()=>reject(reader.error??new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

async function preparePanelImage(file:File):Promise<string>{
  const allowed=new Set(["image/png","image/jpeg","image/webp","image/gif"]);
  if(!allowed.has(file.type)) throw new Error("PNG・JPEG・WebP・GIF画像を選択してください");
  if(file.size<=800_000) return readFileAsDataUrl(file);
  if(file.type==="image/gif"){
    throw new Error("GIFはアニメーション維持のため800KB以下のファイルを使用してください");
  }

  const objectUrl=URL.createObjectURL(file);
  try{
    const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
      const element=new Image();
      element.onload=()=>resolve(element);
      element.onerror=()=>reject(new Error("画像を読み込めませんでした"));
      element.src=objectUrl;
    });
    let scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));
    for(let attempt=0;attempt<5;attempt++){
      const canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const context=canvas.getContext("2d");
      if(!context) throw new Error("画像の圧縮処理を開始できません");
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const quality=Math.max(.58,.88-attempt*.08);
      const dataUrl=canvas.toDataURL("image/webp",quality);
      if(dataUrl.length<=1_150_000) return dataUrl;
      scale*=.78;
    }
    throw new Error("画像を900KB以下まで圧縮できませんでした。別の画像を選択してください");
  }finally{
    URL.revokeObjectURL(objectUrl);
  }
}

export default function VendingManager({
  guildId, channels, roles, onNotice, onError
}:Props){
  const [activeSection,setActiveSection]=useState<"panel"|"products"|"settings"|"achievement">("panel");
  const [mobilePanelView,setMobilePanelView]=useState<"edit"|"preview">("edit");
  const productEditorRef=useRef<HTMLDivElement>(null);
  const [machines,setMachines]=useState<Machine[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const detailRequest=useRef(0);
  const [detailLoading,setDetailLoading]=useState(false);
  const [detail,setDetail]=useState<MachineDetail|null>(null);
  const [newMachineName,setNewMachineName]=useState("");
  const [busy,setBusy]=useState(false);
  const [panelImageBusy,setPanelImageBusy]=useState(false);
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
  const [notifyEnabled,setNotifyEnabled]=useState(false);
  const [notifyChannel,setNotifyChannel]=useState("");
  const [notifyRole,setNotifyRole]=useState("");
  const [achievementRooms,setAchievementRooms]=useState<AchievementRoomDraft[]>([]);

  const [newProduct,setNewProduct]=useState(emptyProduct);
  const [stockFilter,setStockFilter]=useState<"all"|"finite"|"infinite"|"empty">("all");
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
  const stockModeNeedsSave = Boolean(editingProduct) &&
    productEdit.infiniteStock!==Boolean(editingProduct!.infinite_stock);

  const stockSummary = useMemo(()=>{
    const products=detail?.products??[];
    const finite=products.filter(product=>!product.infinite_stock);
    const infinite=products.filter(product=>Boolean(product.infinite_stock));
    const empty=finite.filter(product=>product.stock_count<=0);
    return {
      productCount:products.length,
      finiteProductCount:finite.length,
      infiniteProductCount:infinite.length,
      finiteUnits:finite.reduce((sum,product)=>sum+Math.max(0,product.stock_count),0),
      emptyProductCount:empty.length,
      salesCount:products.reduce((sum,product)=>sum+Math.max(0,product.sales_count),0)
    };
  },[detail]);

  const visibleProducts = useMemo(()=>{
    const products=detail?.products??[];
    if(stockFilter==="finite") return products.filter(product=>!product.infinite_stock);
    if(stockFilter==="infinite") return products.filter(product=>Boolean(product.infinite_stock));
    if(stockFilter==="empty") return products.filter(product=>!product.infinite_stock&&product.stock_count<=0);
    return products;
  },[detail,stockFilter]);

  const editingStockCount = editingProduct
    ? detail?.products.find(product=>product.id===editingProduct.id)?.stock_count ?? editingProduct.stock_count
    : 0;

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
        api<{channel_id:string;role_id:string;enabled:number}|null>(
          `/api/guilds/${guildId}/vending/${id}/stock-notification`
        )
      ]);
      if(request!==detailRequest.current) return;
      setDetail(data);
      setNotifyEnabled(Boolean(notification?.enabled));
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
    const result=await api<{rooms:AchievementRoom[]}>(
      `/api/guilds/${guildId}/vending/achievement-room`
    );
    setAchievementRooms(result.rooms.map(room=>({
      id:room.id,
      channelId:room.channel_id,
      machineIds:room.machine_ids,
      countDisplayEnabled:Boolean(room.count_display_enabled),
      achievementCount:room.achievement_count,
      baseChannelName:room.base_channel_name
    })));
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
    if(productEdit.infiniteStock&&!productEdit.infiniteContent.trim()){
      throw new Error("無限在庫の商品は納品内容を入力してください");
    }
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

  async function uploadPanelImage(file:File){
    if(!selectedId) return;
    setPanelImageBusy(true);
    try{
      const dataUrl=await preparePanelImage(file);
      const result=await api<{url:string}>(
        `/api/guilds/${guildId}/vending/${selectedId}/panel-image`,
        {method:"POST",body:JSON.stringify({dataUrl})},
        30_000
      );
      setMachineForm(current=>({...current,panelImageUrl:result.url}));
      setDetail(current=>current?{...current,panel_image_url:result.url}:current);
      onNotice("パネル画像をアップロードしました");
    }catch(reason){onError(reason);}
    finally{setPanelImageBusy(false);}
  }

  async function removePanelImage(){
    if(!selectedId||!machineForm.panelImageUrl) return;
    setPanelImageBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/vending/${selectedId}/panel-image`,
        {method:"DELETE"}
      );
      setMachineForm(current=>({...current,panelImageUrl:""}));
      setDetail(current=>current?{...current,panel_image_url:null}:current);
      onNotice("パネル画像を削除しました");
    }catch(reason){onError(reason);}
    finally{setPanelImageBusy(false);}
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
    if(!selectedId) return;
    if(notifyEnabled&&(!notifyChannel||!notifyRole)){
      onError(new Error("通知をオンにするには通知チャンネルとメンションロールを選択してください"));
      return;
    }
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/stock-notification`,{
        method:"POST",
        body:JSON.stringify({
          enabled:notifyEnabled,
          channelId:notifyChannel||null,
          roleId:notifyRole||null
        })
      });
      onNotice(notifyEnabled?"在庫追加通知をオンにしました":"在庫追加通知をオフにしました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function clearStockNotification(){
    if(!selectedId) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/stock-notification`,{method:"DELETE"});
      setNotifyEnabled(false);
      setNotifyChannel("");
      setNotifyRole("");
      onNotice("在庫追加通知の設定を削除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  function addAchievementRoom(){
    if(achievementRooms.length>=20) return;
    setAchievementRooms(current=>[
      ...current,
      {
        id:"new-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8),
        channelId:"",
        machineIds:[],
        countDisplayEnabled:false,
        achievementCount:0,
        baseChannelName:null
      }
    ]);
  }

  function updateAchievementRoom(
    roomId:string,
    patch:Partial<Pick<AchievementRoomDraft,"channelId"|"machineIds"|"countDisplayEnabled">>
  ){
    setAchievementRooms(current=>current.map(room=>
      room.id===roomId?{...room,...patch}:room
    ));
  }

  function machineAssignedToOtherAchievementRoom(machineId:string,roomId:string){
    return achievementRooms.some(room=>
      room.id!==roomId&&room.machineIds.includes(machineId)
    );
  }

  async function saveAchievementRooms(){
    const validMachineIds=new Set(machines.map(machine=>machine.id));
    if(achievementRooms.some(room=>!room.channelId)){
      onError(new Error("すべての実績部屋でチャンネルを選択してください"));
      return;
    }
    if(achievementRooms.some(room=>room.machineIds.length===0)){
      onError(new Error("すべての実績部屋で通知する自販機を1つ以上選択してください"));
      return;
    }
    const assigned=new Set<string>();
    for(const room of achievementRooms){
      for(const machineId of room.machineIds){
        if(!validMachineIds.has(machineId)){
          onError(new Error("削除済みの自販機が実績部屋設定に含まれています"));
          return;
        }
        if(assigned.has(machineId)){
          onError(new Error("同じ自販機を複数の実績部屋へ設定することはできません"));
          return;
        }
        assigned.add(machineId);
      }
    }

    setBusy(true);
    try{
      const result=await api<{rooms:AchievementRoom[];warnings?:string[]}>(
        `/api/guilds/${guildId}/vending/achievement-room`,
        {
          method:"PUT",
          body:JSON.stringify({
            rooms:achievementRooms.map(room=>({
              id:room.id.startsWith("new-")?undefined:room.id,
              channelId:room.channelId,
              machineIds:room.machineIds,
              countDisplayEnabled:room.countDisplayEnabled
            }))
          })
        }
      );
      setAchievementRooms(result.rooms.map(room=>({
        id:room.id,
        channelId:room.channel_id,
        machineIds:room.machine_ids,
        countDisplayEnabled:Boolean(room.count_display_enabled),
        achievementCount:room.achievement_count,
        baseChannelName:room.base_channel_name
      })));
      const warningText=result.warnings?.length?" "+result.warnings.join(" "):"";
      onNotice("実績部屋の振り分け設定を保存しました。"+warningText);
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function clearAchievementRooms(){
    if(!window.confirm("実績部屋の振り分け設定をすべて解除しますか？")) return;
    setBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/vending/achievement-room`,
        {method:"PUT",body:JSON.stringify({rooms:[]})}
      );
      setAchievementRooms([]);
      onNotice("実績部屋の振り分けをすべて解除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function addProduct(event:FormEvent){
    event.preventDefault();
    if(!selectedId||!newProduct.name.trim()) return;
    if(newProduct.infiniteStock&&!newProduct.infiniteContent.trim()){
      onError(new Error("無限在庫の商品は納品内容を入力してください"));
      return;
    }
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
    if(productEdit.infiniteStock&&!productEdit.infiniteContent.trim()){
      onError(new Error("無限在庫の商品は納品内容を入力してください"));
      return;
    }
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
    <section className="card vending-manager" inert={busy||detailLoading||panelImageBusy} aria-busy={busy||detailLoading||panelImageBusy}>
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
                {([['panel','パネル'],['products','商品・在庫'],['settings','クーポン・通知'],['achievement','実績部屋']] as const).map(([id,label])=>(
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
                      <div className="field">
                        <span>パネル画像</span>
                        <div className="vending-image-upload-row">
                          <label className="secondary vending-file-button vending-image-upload-button">
                            {panelImageBusy?"画像を処理中…":"画像をアップロード"}
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/gif"
                              disabled={panelImageBusy}
                              onChange={(event)=>{
                                const input=event.currentTarget;
                                const file=input.files?.[0];
                                if(!file) return;
                                void uploadPanelImage(file).finally(()=>{input.value="";});
                              }}
                            />
                          </label>
                          {machineForm.panelImageUrl&&(
                            <button
                              type="button"
                              className="danger"
                              onClick={()=>void removePanelImage()}
                              disabled={panelImageBusy}
                            >
                              画像を削除
                            </button>
                          )}
                        </div>
                        <small className="vending-field-help">
                          URL入力は不要です。大きな写真は自動で縮小・圧縮します。GIFは800KB以下にしてください。
                        </small>
                      </div>
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
                              表示内容・順序は実際のDiscord送信内容と同じです。フォントや余白はDiscordアプリ側で多少変わる場合があります。
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
                    <span className="eyebrow">PRODUCTS / STOCK</span>
                    <h3>{detail.name} の商品・在庫</h3>
                    <p className="muted">この自販機に入っている商品だけを管理しています。有限在庫と無限在庫は別々に表示します。</p>
                  </div>
                  <span className="status-pill"><i /> 販売累計 {stockSummary.salesCount}</span>
                </div>

                <div className="vending-stock-overview" aria-label="在庫の絞り込み">
                  <button type="button" className={stockFilter==="all"?"active":""} onClick={()=>setStockFilter("all")}>
                    <span>全商品</span>
                    <strong>{stockSummary.productCount}</strong>
                    <small>商品</small>
                  </button>
                  <button type="button" className={stockFilter==="finite"?"active":""} onClick={()=>setStockFilter("finite")}>
                    <span>有限在庫</span>
                    <strong>{stockSummary.finiteUnits}</strong>
                    <small>{stockSummary.finiteProductCount}商品 / 合計個数</small>
                  </button>
                  <button type="button" className={stockFilter==="infinite"?"active":""} onClick={()=>setStockFilter("infinite")}>
                    <span>無限在庫</span>
                    <strong>∞ {stockSummary.infiniteProductCount}</strong>
                    <small>商品</small>
                  </button>
                  <button type="button" className={(stockFilter==="empty"?"active ":"")+(stockSummary.emptyProductCount>0?"warning":"")} onClick={()=>setStockFilter("empty")}>
                    <span>在庫切れ</span>
                    <strong>{stockSummary.emptyProductCount}</strong>
                    <small>有限商品</small>
                  </button>
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
                  <label className="toggle-row compact-toggle vending-stock-create-mode">
                    <span className="toggle-copy">
                      <strong>無限在庫にする</strong>
                      <small>{newProduct.infiniteStock?"同じ内容を何度でも納品します":"1件ずつ在庫を登録して販売します"}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={newProduct.infiniteStock}
                      onChange={e=>setNewProduct({...newProduct,infiniteStock:e.target.checked})}
                    />
                  </label>
                  {newProduct.infiniteStock&&(
                    <label className="field">
                      <span>無限在庫の納品内容</span>
                      <textarea
                        required
                        value={newProduct.infiniteContent}
                        onChange={e=>setNewProduct({...newProduct,infiniteContent:e.target.value})}
                        placeholder="購入者へ毎回送る内容"
                      />
                    </label>
                  )}
                  {!newProduct.infiniteStock&&(
                    <div className="vending-stock-create-note">
                      商品追加後に「有限在庫」からコード・URL・テキストを1行1件で登録できます。
                    </div>
                  )}
                  <button className="secondary" type="submit" disabled={busy}>＋ 商品を追加</button>
                </form>

                </details>
                <div className="vending-products">
                  {visibleProducts.map(product=>(
                    <article key={product.id} className={`vending-product-card ${editingProduct?.id===product.id?"active":""} ${product.infinite_stock?"infinite":"finite"}`}>
                      <button type="button" className="vending-product-summary" onClick={()=>editProduct(product)}>
                        <span className="vending-product-emoji">{product.emoji||"📦"}</span>
                        <span className="vending-product-copy">
                          <strong>{product.name}</strong>
                          <small>PayPay ¥{product.price_paypay} · Kyash ¥{product.price_kyash}</small>
                          <span className={`vending-stock-type ${product.infinite_stock?"infinite":"finite"}`}>
                            {product.infinite_stock?"∞ 無限在庫":"有限在庫"}
                          </span>
                        </span>
                        <span className={`vending-stock-count ${!product.infinite_stock&&product.stock_count<=0?"empty":""}`}>
                          {product.infinite_stock?"∞":product.stock_count+"個"}
                        </span>
                        <span className="vending-sales">販売 {product.sales_count}</span>
                      </button>
                    </article>
                  ))}
                  {visibleProducts.length===0&&(
                    <div className="vending-filter-empty">
                      {stockFilter==="empty"?"在庫切れの商品はありません。":"この条件に該当する商品はありません。"}
                    </div>
                  )}
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
                    <div className={`vending-stock-mode-banner ${productEdit.infiniteStock?"infinite":"finite"}`}>
                      <div>
                        <strong>{productEdit.infiniteStock?"∞ 無限在庫":"有限在庫"}</strong>
                        <span>
                          {productEdit.infiniteStock
                            ?"在庫数は減りません。同じ納品内容を購入ごとに送ります。"
                            :`現在 ${Math.max(0,editingStockCount)}個。1行を在庫1件として個別に消費します。`}
                        </span>
                      </div>
                      <span className="vending-stock-mode-value">{productEdit.infiniteStock?"∞":Math.max(0,editingStockCount)+"個"}</span>
                    </div>
                    <label className="toggle-row compact-toggle">
                      <span className="toggle-copy">
                        <strong>無限在庫として扱う</strong>
                        <small>{productEdit.infiniteStock?"ON: 同じ内容を繰り返し納品":"OFF: 登録した有限在庫を1件ずつ消費"}</small>
                      </span>
                      <input type="checkbox" checked={productEdit.infiniteStock} onChange={e=>setProductEdit({...productEdit,infiniteStock:e.target.checked})}/>
                    </label>
                    {productEdit.infiniteStock&&(
                      <label className="field">
                        <span>無限在庫の納品内容</span>
                        <textarea
                          value={productEdit.infiniteContent}
                          onChange={e=>setProductEdit({...productEdit,infiniteContent:e.target.value})}
                          placeholder="購入者へ毎回送る内容"
                        />
                        <small className="vending-field-help">有限在庫へ戻しても、以前に登録した有限在庫は残ります。</small>
                      </label>
                    )}
                    <div className="button-row">
                      <button className="primary" onClick={()=>void saveProduct()} disabled={busy}>商品を保存</button>
                      <button className="danger" onClick={()=>void removeProduct(editingProduct)} disabled={busy}>商品削除</button>
                    </div>

                    {!productEdit.infiniteStock&&(
                      <div className="vending-stock-editor">
                        <div className="vending-stock-editor-head">
                          <div>
                            <span className="eyebrow">FINITE STOCK</span>
                            <strong>有限在庫を追加・確認</strong>
                          </div>
                          <span className={`vending-stock-live-count ${editingStockCount<=0?"empty":""}`}>
                            現在 {Math.max(0,editingStockCount)}個
                          </span>
                        </div>
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
                        {stockModeNeedsSave&&(
                          <div className="vending-stock-save-first">
                            在庫方式を変更しました。先に「商品を保存」してから有限在庫を操作してください。
                          </div>
                        )}
                        <div className="button-row">
                          <button className="secondary" onClick={()=>void addStock()} disabled={!stockText.trim()||busy||stockModeNeedsSave}>在庫追加</button>
                          <button className="secondary" onClick={()=>void viewStock()} disabled={busy||stockModeNeedsSave}>在庫内容確認</button>
                          <input className="withdraw-input" type="number" min={1} max={500} value={withdrawQuantity} onChange={e=>setWithdrawQuantity(Number(e.target.value))} disabled={stockModeNeedsSave}/>
                          <button className="secondary" onClick={()=>void withdraw()} disabled={busy||stockModeNeedsSave||editingStockCount<=0}>引出</button>
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
                  <div className="section-head compact">
                    <div>
                      <span className="eyebrow">STOCK ALERT</span>
                      <h3>在庫追加通知</h3>
                    </div>
                    <span className={`status-pill ${notifyEnabled?"good":"warn"}`}>
                      <i /> {notifyEnabled?"ON":"OFF"}
                    </span>
                  </div>

                  <label className="toggle-row compact-toggle vending-notify-toggle">
                    <span className="toggle-copy">
                      <strong>在庫を追加した時に通知する</strong>
                      <small>
                        {notifyEnabled
                          ?"ON: 有限在庫を追加した時に指定チャンネルへ通知します"
                          :"OFF: 在庫を追加してもDiscordへ通知しません"}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={notifyEnabled}
                      onChange={e=>setNotifyEnabled(e.target.checked)}
                    />
                  </label>

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
                  <small className="vending-field-help">
                    デフォルトはOFFです。OFFのまま通知先だけ先に保存しておくこともできます。
                  </small>
                  <div className="button-row">
                    <button
                      className="secondary"
                      onClick={()=>void saveStockNotification()}
                      disabled={busy||(notifyEnabled&&(!notifyChannel||!notifyRole))}
                    >
                      通知設定を保存
                    </button>
                    <button
                      className="danger"
                      onClick={()=>void clearStockNotification()}
                      disabled={busy||(!notifyChannel&&!notifyRole)}
                    >
                      設定を削除
                    </button>
                  </div>
                </div>


              </div>

              <div hidden={activeSection!=="achievement"} className="vending-tabs-section">
                <div className="section-head compact">
                  <div>
                    <span className="eyebrow">ACHIEVEMENT ROUTING</span>
                    <h3>実績部屋の振り分け</h3>
                    <p className="muted">
                      自販機ごとに実績の送信先を分けられます。例: 自販機A/B → #実績1、自販機C → #実績2。
                    </p>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={addAchievementRoom}
                    disabled={achievementRooms.length>=20||busy}
                  >
                    ＋ 実績部屋を追加
                  </button>
                </div>

                {achievementRooms.length===0 ? (
                  <div className="vending-select-prompt">
                    <strong>実績部屋はまだありません</strong>
                    <span>「＋ 実績部屋を追加」から送信先と対象自販機を設定してください。</span>
                  </div>
                ) : (
                  <div className="stack">
                    {achievementRooms.map((room,index)=>(
                      <article className="vending-control-group" key={room.id}>
                        <div className="section-head compact">
                          <div>
                            <span className="eyebrow">ROUTE {index+1}</span>
                            <h3>
                              {room.channelId
                                ? "#"+(channels.find(channel=>channel.id===room.channelId)?.name??"実績部屋")
                                : "送信先を選択"}
                            </h3>
                          </div>
                          <button
                            className="danger"
                            type="button"
                            onClick={()=>setAchievementRooms(current=>current.filter(item=>item.id!==room.id))}
                            disabled={busy}
                          >
                            この振り分けを削除
                          </button>
                        </div>

                        <label className="field"><span>実績を送るチャンネル</span>
                          <select
                            value={room.channelId}
                            onChange={event=>updateAchievementRoom(room.id,{channelId:event.target.value})}
                          >
                            <option value="">選択</option>
                            {channels.map(channel=>(
                              <option key={channel.id} value={channel.id}>#{channel.name}</option>
                            ))}
                          </select>
                        </label>

                        <div className="field">
                          <span>この実績部屋へ送る自販機</span>
                          <div className="role-picker">
                            {machines.map(machine=>{
                              const checked=room.machineIds.includes(machine.id);
                              const usedElsewhere=machineAssignedToOtherAchievementRoom(machine.id,room.id);
                              return (
                                <label
                                  key={machine.id}
                                  className={`role-choice ${checked?"selected":""}`}
                                  title={usedElsewhere?"別の実績部屋に設定済み":undefined}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={usedElsewhere}
                                    onChange={event=>{
                                      updateAchievementRoom(room.id,{
                                        machineIds:event.target.checked
                                          ? [...new Set([...room.machineIds,machine.id])]
                                          : room.machineIds.filter(id=>id!==machine.id)
                                      });
                                    }}
                                  />
                                  <span>
                                    {machine.name}{usedElsewhere&&!checked?" — 他の実績部屋に設定済み":""}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                        <div className="vending-achievement-count-setting">
                          <label className="toggle-row compact-toggle">
                            <span className="toggle-copy">
                              <strong>チャンネル名に実績件数を表示</strong>
                              <small>
                                {room.countDisplayEnabled
                                  ? "ON: チャンネル名の末尾に「"+room.achievementCount+"件」を表示します"
                                  : "OFF: チャンネル名は変更しません"}
                              </small>
                            </span>
                            <input
                              type="checkbox"
                              checked={room.countDisplayEnabled}
                              onChange={event=>updateAchievementRoom(room.id,{
                                countDisplayEnabled:event.target.checked
                              })}
                            />
                          </label>
                          <div className="vending-achievement-count-preview">
                            <span>現在の実績件数</span>
                            <strong>{room.achievementCount}件</strong>
                            {room.countDisplayEnabled&&room.channelId&&(
                              <small>
                                表示例: #
                                {(room.baseChannelName
                                  ?? channels.find(channel=>channel.id===room.channelId)?.name
                                  ?? "実績")
                                  .replace(/\d+件$/,"")}
                                {room.achievementCount}件
                              </small>
                            )}
                          </div>
                        </div>
                        <small className="muted">
                          {room.machineIds.length}台の自販機をこの部屋へ振り分け。件数表示はデフォルトOFFです。
                        </small>
                      </article>
                    ))}
                  </div>
                )}

                <div className="button-row">
                  <button
                    className="primary"
                    type="button"
                    onClick={()=>void saveAchievementRooms()}
                    disabled={
                      busy||
                      achievementRooms.some(room=>!room.channelId||room.machineIds.length===0)
                    }
                  >
                    振り分け設定を保存
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={()=>void clearAchievementRooms()}
                    disabled={achievementRooms.length===0||busy}
                  >
                    すべて解除
                  </button>
                </div>
                <small className="muted">
                  1台の自販機は1つの実績部屋に割り当てます。通知内容: 購入者 / 商品名 / 個数 / 注文ID。
                  件数は実績メッセージの送信成功時に加算され、Discordのチャンネル名変更制限を避けるため名前への反映は数分遅れる場合があります。
                </small>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
