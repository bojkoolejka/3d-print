const VERSION='1.8.4';
const DB_NAME='print3d-premium-db';
const DB_VERSION=1;
const STORE_KV='kv';
const STORE_PHOTOS='photos';
const STATE_KEY='state';

const STATUS=['Новый','Моделирование','Готов к печати','Печатается','Готов','Выдан','Завершён','Отменён'];
const WORK_STATUSES=new Set(['Новый','Моделирование','Готов к печати','Печатается','Выдан']);
const money=n=>`${Math.round(Number(n)||0).toLocaleString('ru-RU')} ₽`;
const uid=()=>`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
const esc=s=>String(s??'').replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]));
const n=v=>Number(String(v??'').replace(',','.').replace(/[^0-9.-]/g,''))||0;
const pad=x=>String(x).padStart(2,'0');
const localDate=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const localTime=d=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;

let db;
let state={orders:[],generalExpenses:[],settings:{electricityRate:6.5,printerPower:250},version:VERSION};
let currentTab='today';
let orderFilter='Все';
let searchText='';
let modal=null;
let selectedOrderId=null;
let selectedClient=null;
let photoCache=new Map();
let pickedPhotos=[];
let editingOrderId=null;
let legacyNotice='';

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=e=>{
      const d=e.target.result;
      if(!d.objectStoreNames.contains(STORE_KV)) d.createObjectStore(STORE_KV);
      if(!d.objectStoreNames.contains(STORE_PHOTOS)) d.createObjectStore(STORE_PHOTOS);
    };
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
function idbGet(store,key){return new Promise((res,rej)=>{const tx=db.transaction(store,'readonly');const r=tx.objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function idbSet(store,key,val){return new Promise((res,rej)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(val,key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
function idbDel(store,key){return new Promise((res,rej)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
async function saveState(){state.version=VERSION;await idbSet(STORE_KV,STATE_KEY,state)}

function parseMaybeJSON(s){try{return JSON.parse(s)}catch{return null}}
function looksLikeOrder(o){if(!o||typeof o!=='object'||Array.isArray(o))return 0;const keys=Object.keys(o).map(x=>x.toLowerCase());const marks=['client','customer','клиент','status','статус','material','материал','price','cost','цена','title','what','product','item','name','deadline','срок','photo'];return marks.reduce((a,m)=>a+(keys.some(k=>k.includes(m))?1:0),0)}
function findLegacy(){
  const candidates=[];
  for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i); if(!key)continue;
    const raw=localStorage.getItem(key); if(!raw||raw.length<2)continue;
    const val=parseMaybeJSON(raw); if(val==null)continue;
    if(Array.isArray(val) && val.length && typeof val[0]==='object'){
      const score=val.slice(0,5).reduce((s,o)=>s+looksLikeOrder(o),0);
      if(score>=3)candidates.push({key,orders:val,score:score+2});
    }
    if(val&&typeof val==='object'&&!Array.isArray(val)){
      for(const prop of Object.keys(val)){
        const arr=val[prop];
        if(Array.isArray(arr)&&arr.length&&typeof arr[0]==='object'){
          const score=arr.slice(0,5).reduce((s,o)=>s+looksLikeOrder(o),0)+(prop.toLowerCase().includes('order')?4:0);
          if(score>=3)candidates.push({key,root:val,prop,orders:arr,score});
        }
      }
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}
function first(o,names,def=''){for(const k of names){if(o[k]!==undefined&&o[k]!==null&&o[k]!=='')return o[k]}return def}
function dateFromAny(v){
  if(!v)return '';
  if(v instanceof Date&&!isNaN(v))return localDate(v);
  if(typeof v==='number'){const d=new Date(v);return isNaN(d)?'':localDate(d)}
  const s=String(v).trim();
  const iso=s.match(/(20\d{2})-(\d{2})-(\d{2})/);if(iso)return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ru=s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2}|\d{2})/);if(ru)return `${ru[3].length===2?'20'+ru[3]:ru[3]}-${pad(ru[2])}-${pad(ru[1])}`;
  const d=new Date(s);return isNaN(d)?'':localDate(d);
}
function timeFromAny(v){if(!v)return '';const s=String(v);const m=s.match(/(\d{1,2}):(\d{2})/);return m?`${pad(m[1])}:${m[2]}`:''}
function normStatus(s){s=String(s||'Новый').trim(); if(s==='Закрыт'||s==='Закрыто')return 'Завершён'; if(s==='Готово')return 'Готов'; return STATUS.includes(s)?s:'Новый'}
async function dataURLToBlob(dataURL){const r=await fetch(dataURL);return await r.blob()}
async function normalizeLegacyOrder(o,index){
  const id=String(first(o,['id','orderId','uuid'],uid()));
  const deadlineRaw=first(o,['deadline','dueDate','readyAt','readyDate','dateReady','срок'],'');
  const deadlineDate=first(o,['deadlineDate','readyDateOnly'],dateFromAny(deadlineRaw));
  const deadlineTime=first(o,['deadlineTime','readyTime'],timeFromAny(deadlineRaw)||'12:00');
  let photoVals=first(o,['photos','images','photo','image'],[]); if(typeof photoVals==='string')photoVals=[photoVals]; if(!Array.isArray(photoVals))photoVals=[];
  const photoKeys=[];
  for(let i=0;i<photoVals.length;i++){
    const p=photoVals[i];
    if(typeof p==='string'&&p.startsWith('data:image/')){
      try{const blob=await dataURLToBlob(p); const pk=`legacy-${id}-${i}`; await idbSet(STORE_PHOTOS,pk,blob); photoKeys.push(pk)}catch{}
    } else if(typeof p==='string'&&p.length<200 && !p.startsWith('http')) photoKeys.push(p);
  }
  return {
    id,createdAt:first(o,['createdAt','created','date','created_date'],new Date().toISOString()),
    client:String(first(o,['client','clientName','customer','customerName','fio','nameClient'],'')).trim(),
    phone:String(first(o,['phone','clientPhone','telephone','tel'],'')).trim(),
    item:String(first(o,['item','what','product','title','detail','part','work','description'],'Заказ')).trim(),
    qty:n(first(o,['qty','quantity','count'],1))||1,
    status:normStatus(first(o,['status','state'],'Новый')),
    material:String(first(o,['material','plastic'],'')).trim(),
    color:String(first(o,['color','colour'],'')).trim(),
    spoolPrice:n(first(o,['spoolPrice','rollPrice','plasticRollPrice'],0)),
    spoolWeight:n(first(o,['spoolWeight','rollWeight','plasticRollWeight'],1000))||1000,
    usedGrams:n(first(o,['usedGrams','weightUsed','plasticWeight','grams','weight'],0)),
    price:n(first(o,['price','orderPrice','cost','amount','total'],0)),
    paid:n(first(o,['paid','payment','prepaid'],0)),
    printerPower:n(first(o,['printerPower','powerWatts','power'],state.settings.printerPower||250)),
    printHours:n(first(o,['printHours','hours'],0)), printMinutes:n(first(o,['printMinutes','minutes'],0)),
    supplies:n(first(o,['supplies','consumables'],0)), packaging:n(first(o,['packaging','packing'],0)), delivery:n(first(o,['delivery','shipping'],0)), other:n(first(o,['other','otherExpenses','misc'],0)),
    deadlineDate,deadlineTime,reminder:String(first(o,['reminder','notifyBefore'],'30')),
    notes:String(first(o,['notes','note','comment'],'')).trim(), photoKeys
  };
}
async function migrateLegacy(){
  const legacy=findLegacy(); if(!legacy)return false;
  try{
    const orders=[];
    for(let i=0;i<legacy.orders.length;i++) orders.push(await normalizeLegacyOrder(legacy.orders[i],i));
    let generalExpenses=[]; let settings={...state.settings};
    if(legacy.root){
      const ge=legacy.root.generalExpenses||legacy.root.expenses||legacy.root.commonExpenses; if(Array.isArray(ge)) generalExpenses=ge.map(x=>({id:String(x.id||uid()),date:dateFromAny(x.date||x.createdAt)||localDate(new Date()),category:String(x.category||x.name||'Прочее'),amount:n(x.amount||x.value||x.sum),note:String(x.note||'')}));
      const st=legacy.root.settings||{}; settings.electricityRate=n(st.electricityRate||st.kwhPrice||st.tariff)||settings.electricityRate; settings.printerPower=n(st.printerPower||st.power)||settings.printerPower;
    }
    state={orders,generalExpenses,settings,version:VERSION}; await saveState(); legacyNotice=`Сохранённые заказы перенесены: ${orders.length}`; return true;
  }catch(e){console.error('migration',e);return false}
}

async function init(){
  db=await openDB();
  const saved=await idbGet(STORE_KV,STATE_KEY);
  if(saved&&saved.orders){state={...state,...saved,settings:{...state.settings,...(saved.settings||{})}};state.orders=state.orders.map(o=>({...o,status:normStatus(o.status),photoKeys:Array.isArray(o.photoKeys)?o.photoKeys:[]}));}
  else await migrateLegacy();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=184').catch(()=>{});
  render(); if(legacyNotice)toast(legacyNotice);
}

function orderCosts(o){
  const plastic=(n(o.spoolWeight)>0?n(o.spoolPrice)/n(o.spoolWeight)*n(o.usedGrams):0);
  const hours=n(o.printHours)+n(o.printMinutes)/60;
  const electricity=(n(o.printerPower)/1000)*hours*n(state.settings.electricityRate);
  const extra=n(o.supplies)+n(o.packaging)+n(o.delivery)+n(o.other);
  const total=plastic+electricity+extra;
  return {plastic,electricity,extra,total,profit:n(o.price)-total};
}
function monthKeyFromDate(v){const d=new Date(v);return isNaN(d)?'':`${d.getFullYear()}-${pad(d.getMonth()+1)}`}
function completedDate(o){return o.completedAt||o.updatedAt||o.createdAt}
function financeForMonth(date=new Date()){
  const key=`${date.getFullYear()}-${pad(date.getMonth()+1)}`;
  let income=0, orderExpense=0, cats={plastic:0,electricity:0,supplies:0,packaging:0,delivery:0,other:0};
  for(const o of state.orders){
    if(o.status!=='Завершён')continue;
    if(monthKeyFromDate(completedDate(o))!==key)continue;
    const c=orderCosts(o); income+=n(o.price); orderExpense+=c.total; cats.plastic+=c.plastic;cats.electricity+=c.electricity;cats.supplies+=n(o.supplies);cats.packaging+=n(o.packaging);cats.delivery+=n(o.delivery);cats.other+=n(o.other);
  }
  let general=0;
  for(const e of state.generalExpenses||[]){if(String(e.date||'').slice(0,7)===key){general+=n(e.amount);const cat=String(e.category||'').toLowerCase(); if(cat.includes('пласт'))cats.plastic+=n(e.amount);else if(cat.includes('элект'))cats.electricity+=n(e.amount);else if(cat.includes('расход'))cats.supplies+=n(e.amount);else if(cat.includes('упаков'))cats.packaging+=n(e.amount);else if(cat.includes('достав'))cats.delivery+=n(e.amount);else cats.other+=n(e.amount)}}
  return {income,expense:orderExpense+general,profit:income-orderExpense-general,cats};
}
function counts(){return {work:state.orders.filter(o=>WORK_STATUSES.has(o.status)).length,waiting:state.orders.filter(o=>o.status==='Готов').length,done:state.orders.filter(o=>o.status==='Завершён').length}}
function fmtDeadline(o){if(!o.deadlineDate)return 'Без срока';const [y,m,d]=o.deadlineDate.split('-');return `${d}.${m}.${y}${o.deadlineTime?' · '+o.deadlineTime:''}`}
function initials(name){const a=String(name||'?').trim().split(/\s+/).filter(Boolean);return (a[0]?.[0]||'?')+(a[1]?.[0]||'')}

async function photoURL(key){if(!key)return '';if(photoCache.has(key))return photoCache.get(key);const blob=await idbGet(STORE_PHOTOS,key);if(!blob)return '';const url=URL.createObjectURL(blob);photoCache.set(key,url);return url}
async function hydrateImages(root=document){
  const els=[...root.querySelectorAll('[data-photo-key]')];
  for(const el of els){const key=el.dataset.photoKey;const url=await photoURL(key);if(url)el.src=url}
}

function navHTML(){return `<nav class="nav">
  <button class="navBtn ${currentTab==='today'?'active':''}" data-tab="today"><span class="i">⌂</span><span>Сегодня</span></button>
  <button class="navBtn ${currentTab==='orders'?'active':''}" data-tab="orders"><span class="i">▤</span><span>Заказы</span></button>
  <button class="addBtn" data-action="newOrder">+</button>
  <button class="navBtn ${currentTab==='clients'?'active':''}" data-tab="clients"><span class="i">♙</span><span>Клиенты</span></button>
  <button class="navBtn ${currentTab==='finance'?'active':''}" data-tab="finance"><span class="i">₽</span><span>Финансы</span></button>
</nav>`}
function topHTML(title){const dt=new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long'}).format(new Date());return `<div class="topbar"><div><div class="eyebrow">${esc(dt)}</div><div class="title">${esc(title)}</div></div><button class="iconBtn" data-action="menu">•••</button></div>`}
function menuHTML(){return `<div class="menu"><button data-action="settings">⚙️ Настройки</button><button data-action="addExpense">＋ Общий расход</button><button data-action="backup">⬇️ Резервная копия</button><button data-action="import">⬆️ Восстановить</button><button disabled class="small muted">Версия ${VERSION}</button></div>`}

function orderCardHTML(o){const c=orderCosts(o);const p=o.photoKeys?.[0];return `<article class="orderPhotoCard" data-order-id="${esc(o.id)}">
  <div class="orderPhotoWrap">${p?`<img data-photo-key="${esc(p)}" alt="">`:`<div class="placeholder">3D</div>`}<div class="photoGradient"></div><span class="badge status-${esc(o.status)}">${esc(o.status)}</span></div>
  <div class="orderBody"><div class="orderName">${esc(o.item||'Заказ')}</div><div class="orderMeta">${esc(o.client||'Без клиента')} · ${esc(o.material||'Материал —')}${o.usedGrams?` · ${Math.round(o.usedGrams)} г`:''}</div><div class="orderPrice">${money(o.price)}</div><div class="orderBottom"><span>${esc(fmtDeadline(o))}</span><span>Расход ${money(c.total)}</span><span>Прибыль ${money(c.profit)}</span></div></div>
</article>`}

function todayHTML(){const f=financeForMonth(),ct=counts();const upcoming=[...state.orders].filter(o=>!['Завершён','Отменён'].includes(o.status)).sort((a,b)=>(a.deadlineDate+a.deadlineTime).localeCompare(b.deadlineDate+b.deadlineTime)).slice(0,4);return `<main class="screen">${topHTML('Сегодня')}
  <section class="card heroFinance"><div class="label">Доход за месяц</div><div class="money">${money(f.income)}</div><div class="twocol"><div class="metric"><span>Расходы</span><b>${money(f.expense)}</b></div><div class="metric"><span>Прибыль</span><b>${money(f.profit)}</b></div></div></section>
  <div class="stats3" style="margin-top:14px"><div class="stat"><div class="s">В работе</div><div class="n">${ct.work}</div></div><div class="stat"><div class="s">Ждут оплаты</div><div class="n">${ct.waiting}</div></div><div class="stat"><div class="s">Завершённые</div><div class="n">${ct.done}</div></div></div>
  <div class="sectionTitle">Ближайшие заказы</div><div class="orderGrid">${upcoming.length?upcoming.map(orderCardHTML).join(''):`<div class="empty">Нет активных заказов</div>`}</div></main>`}
function ordersHTML(){let arr=[...state.orders]; if(orderFilter!=='Все')arr=arr.filter(o=>o.status===orderFilter); if(searchText){const q=searchText.toLowerCase();arr=arr.filter(o=>[o.item,o.client,o.material,o.phone].join(' ').toLowerCase().includes(q))}arr.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));return `<main class="screen">${topHTML('Заказы')}<input class="search" id="orderSearch" placeholder="Поиск заказов..." value="${esc(searchText)}"><div class="filters">${['Все','В работе','Готов','Завершённые'].map(x=>{const target=x==='В работе'?'__work':x==='Завершённые'?'Завершён':x;const active=orderFilter===target||orderFilter===x;return `<button class="filterBtn ${active?'active':''}" data-filter="${esc(target)}">${x}</button>`}).join('')}</div><div class="orderGrid">${arr.length?arr.map(orderCardHTML).join(''):`<div class="empty">Заказов не найдено</div>`}</div></main>`}
function clientsData(){const m=new Map();for(const o of state.orders){const name=(o.client||'Без имени').trim();const key=(o.phone||'')+'|'+name.toLowerCase();if(!m.has(key))m.set(key,{key,name,phone:o.phone||'',orders:[]});m.get(key).orders.push(o)}return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'))}
function clientsHTML(){const cs=clientsData();return `<main class="screen">${topHTML('Клиенты')}<div class="card listCard">${cs.length?cs.map(c=>`<div class="row" data-client-key="${esc(c.key)}"><div class="avatar">${esc(initials(c.name))}</div><div class="grow"><div class="rowTitle">${esc(c.name)}</div><div class="rowSub">${esc(c.phone||'Телефон не указан')}</div></div><div class="right">${c.orders.length} ›</div></div>`).join(''):`<div class="empty">Клиенты появятся после добавления заказов</div>`}</div></main>`}
function financeHTML(){const f=financeForMonth();return `<main class="screen">${topHTML('Финансы')}<div class="financeTotals"><div class="financeBox"><span>Доход</span><b>${money(f.income)}</b></div><div class="financeBox"><span>Расход</span><b>${money(f.expense)}</b></div><div class="financeBox"><span>Прибыль</span><b>${money(f.profit)}</b></div></div><div class="sectionTitle">Расходы по категориям</div><div class="card" style="padding:8px 18px"><div class="financeRow"><span>Пластик</span><b>${money(f.cats.plastic)}</b></div><div class="financeRow"><span>Электричество</span><b>${money(f.cats.electricity)}</b></div><div class="financeRow"><span>Расходники</span><b>${money(f.cats.supplies)}</b></div><div class="financeRow"><span>Упаковка</span><b>${money(f.cats.packaging)}</b></div><div class="financeRow"><span>Доставка</span><b>${money(f.cats.delivery)}</b></div><div class="financeRow"><span>Прочее</span><b>${money(f.cats.other)}</b></div></div><button class="btn block" style="margin-top:16px" data-action="addExpense">＋ Добавить общий расход</button><p class="muted small" style="margin:16px 4px">Доход, себестоимость и прибыль заказа попадают сюда только после статуса «Завершён». Незавершённые заказы на финансовый итог месяца не влияют.</p></main>`}

function render(){
  let body=currentTab==='today'?todayHTML():currentTab==='orders'?ordersHTML():currentTab==='clients'?clientsHTML():financeHTML();
  document.getElementById('app').innerHTML=body+navHTML()+(modal||'');
  bind(); hydrateImages();
}

function bind(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{currentTab=b.dataset.tab;modal=null;render()});
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=e=>{e.stopPropagation();action(b.dataset.action,b)});
  document.querySelectorAll('[data-order-id]').forEach(el=>el.onclick=()=>openOrder(el.dataset.orderId));
  document.querySelectorAll('[data-client-key]').forEach(el=>el.onclick=()=>openClient(el.dataset.clientKey));
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{const v=b.dataset.filter;orderFilter=v==='__work'?'__work':v; if(v==='__work'){const arr=state.orders.filter(o=>WORK_STATUSES.has(o.status));modal=null;renderOrdersCustom(arr)}else render()});
  const s=document.getElementById('orderSearch');if(s)s.oninput=()=>{searchText=s.value;render()};
  const picker=document.getElementById('photoPicker');picker.onchange=handlePhotoFiles;
}
function renderOrdersCustom(arr){const root=document.getElementById('app');root.innerHTML=`<main class="screen">${topHTML('Заказы')}<input class="search" id="orderSearch" placeholder="Поиск заказов..." value="${esc(searchText)}"><div class="filters">${['Все','В работе','Готов','Завершённые'].map(x=>`<button class="filterBtn ${x==='В работе'?'active':''}" data-filter="${x==='В работе'?'__work':x==='Завершённые'?'Завершён':x}">${x}</button>`).join('')}</div><div class="orderGrid">${arr.length?arr.map(orderCardHTML).join(''):`<div class="empty">Заказов не найдено</div>`}</div></main>${navHTML()}`;bind();hydrateImages()}

function toast(msg){const old=document.querySelector('.toast');if(old)old.remove();const d=document.createElement('div');d.className='toast';d.textContent=msg;document.body.appendChild(d);setTimeout(()=>d.remove(),2800)}
function action(a,b){
  if(a==='newOrder')openOrderForm(); else if(a==='menu')toggleMenu(); else if(a==='settings')openSettings(); else if(a==='addExpense')openExpense(); else if(a==='backup')backup(); else if(a==='import')restore();
}
function toggleMenu(){const old=document.querySelector('.menu');if(old){old.remove();return}document.querySelector('.topbar').insertAdjacentHTML('beforeend',menuHTML());bind()}

function defaultOrder(){const d=new Date();d.setDate(d.getDate()+1);d.setHours(12,0,0,0);return {id:uid(),createdAt:new Date().toISOString(),client:'',phone:'',item:'',qty:1,status:'Новый',material:'PETG',color:'',spoolPrice:0,spoolWeight:1000,usedGrams:0,price:0,paid:0,printerPower:state.settings.printerPower||250,printHours:0,printMinutes:0,supplies:0,packaging:0,delivery:0,other:0,deadlineDate:localDate(d),deadlineTime:'12:00',reminder:'30',notes:'',photoKeys:[]}}
function formField(label,id,value='',type='text',extra=''){return `<div class="field"><label>${label}</label><input id="${id}" type="${type}" value="${esc(value)}" ${extra}></div>`}
function orderFormHTML(o,isEdit=false){const c=orderCosts(o);return `<div class="modalOverlay" data-close="overlay"><div class="modal"><div class="modalHead"><div class="modalTitle">${isEdit?'Редактирование':'Новый заказ'}</div><button class="closeBtn" data-close="modal">×</button></div>
<button class="btn voiceBtn block" id="voiceStart">🎙 Заполнить заказ голосом</button><div class="photoHint">Например: «Клиент Иван Петров, корпус, две штуки, PETG чёрный, 180 грамм, цена 1500, срок завтра к 18:00».</div>
<div class="sectionTitle">Фото детали</div><div class="photoStrip" id="photoStrip">${(o.photoKeys||[]).map(k=>`<img class="thumb" data-photo-key="${esc(k)}" data-existing-photo="${esc(k)}">`).join('')}<button class="addPhoto" id="addPhoto">＋<br>Фото</button></div><div class="photoHint">Фото автоматически сжимаются и хранятся отдельно от заказов, поэтому больше не должны переполнять память приложения.</div>
<div class="formGrid" style="margin-top:16px">${formField('Клиент','f_client',o.client)}${formField('Телефон','f_phone',o.phone,'tel')}${formField('Что изготовить','f_item',o.item)}<div class="field2">${formField('Количество','f_qty',o.qty,'number','min="1"')}${selectStatus(o.status)}</div><div class="field2">${formField('Материал','f_material',o.material)}${formField('Цвет','f_color',o.color)}</div>
<div class="field3">${formField('Стоимость катушки, ₽','f_spoolPrice',o.spoolPrice,'number','step="0.01"')}${formField('Вес катушки, г','f_spoolWeight',o.spoolWeight,'number')}${formField('Потрачено, г','f_usedGrams',o.usedGrams,'number','step="0.1"')}</div>
<div class="field2">${formField('Цена заказа, ₽','f_price',o.price,'number','step="0.01"')}${formField('Оплачено, ₽','f_paid',o.paid,'number','step="0.01"')}</div>
<div class="field3">${formField('Мощность, Вт','f_power',o.printerPower,'number')}${formField('Печать, часов','f_hours',o.printHours,'number','step="1"')}${formField('Минут','f_minutes',o.printMinutes,'number','min="0" max="59"')}</div>
<div class="field2">${formField('Расходники, ₽','f_supplies',o.supplies,'number')}${formField('Упаковка, ₽','f_packaging',o.packaging,'number')}</div><div class="field2">${formField('Доставка, ₽','f_delivery',o.delivery,'number')}${formField('Прочее, ₽','f_other',o.other,'number')}</div>
<div class="field2">${formField('Срок готовности — дата','f_date',o.deadlineDate,'date')}${formField('Время','f_time',o.deadlineTime,'time')}</div>${selectReminder(o.reminder)}<div class="field"><label>Заметки</label><textarea id="f_notes">${esc(o.notes)}</textarea></div></div>
<div class="card summary" id="costSummary" style="margin-top:16px"><div class="sumRow"><span>Стоимость пластика</span><strong>${money(c.plastic)}</strong></div><div class="sumRow"><span>Электричество</span><strong>${money(c.electricity)}</strong></div><div class="sumRow"><span>Общий расход</span><strong>${money(c.total)}</strong></div><div class="sumRow profit"><span>Чистая прибыль</span><strong>${money(c.profit)}</strong></div></div>
<button class="btn primary block" id="saveOrder" style="margin-top:16px">${isEdit?'Сохранить изменения':'Сохранить заказ'}</button>${isEdit?`<button class="btn danger block" id="deleteOrder" style="margin-top:10px">Удалить заказ</button>`:''}</div></div>`}
function selectStatus(v){return `<div class="field"><label>Статус</label><select id="f_status">${STATUS.map(x=>`<option ${x===v?'selected':''}>${x}</option>`).join('')}</select></div>`}
function selectReminder(v){return `<div class="field"><label>Напомнить о сроке</label><select id="f_reminder"><option value="15" ${v==='15'?'selected':''}>за 15 минут</option><option value="30" ${v==='30'?'selected':''}>за 30 минут</option><option value="60" ${v==='60'?'selected':''}>за 1 час</option><option value="120" ${v==='120'?'selected':''}>за 2 часа</option><option value="1440" ${v==='1440'?'selected':''}>за 1 день</option></select></div>`}

function openOrderForm(existing=null){editingOrderId=existing?.id||null;pickedPhotos=[];modal=orderFormHTML(existing?{...existing}:defaultOrder(),!!existing);render();setupOrderForm(existing)}
function readForm(base={}){return {...base,client:val('f_client'),phone:val('f_phone'),item:val('f_item'),qty:n(val('f_qty'))||1,status:val('f_status'),material:val('f_material'),color:val('f_color'),spoolPrice:n(val('f_spoolPrice')),spoolWeight:n(val('f_spoolWeight'))||1000,usedGrams:n(val('f_usedGrams')),price:n(val('f_price')),paid:n(val('f_paid')),printerPower:n(val('f_power'))||state.settings.printerPower||250,printHours:n(val('f_hours')),printMinutes:n(val('f_minutes')),supplies:n(val('f_supplies')),packaging:n(val('f_packaging')),delivery:n(val('f_delivery')),other:n(val('f_other')),deadlineDate:val('f_date'),deadlineTime:val('f_time'),reminder:val('f_reminder'),notes:val('f_notes')};}
function val(id){return document.getElementById(id)?.value??''}
function setupOrderForm(existing){
  document.querySelectorAll('[data-close]').forEach(x=>x.onclick=e=>{if(x.dataset.close==='overlay'&&e.target!==x)return;modal=null;render()});
  document.getElementById('addPhoto').onclick=()=>document.getElementById('photoPicker').click();
  document.getElementById('voiceStart').onclick=startVoice;
  document.getElementById('saveOrder').onclick=()=>saveOrder(existing);
  if(existing)document.getElementById('deleteOrder').onclick=()=>deleteOrder(existing.id);
  document.querySelectorAll('.formGrid input,.formGrid select').forEach(el=>el.oninput=updateCostSummary);
  hydrateImages(document.querySelector('.modal'));
}
function updateCostSummary(){const o=readForm({});const c=orderCosts(o);const box=document.getElementById('costSummary');if(box)box.innerHTML=`<div class="sumRow"><span>Стоимость пластика</span><strong>${money(c.plastic)}</strong></div><div class="sumRow"><span>Электричество</span><strong>${money(c.electricity)}</strong></div><div class="sumRow"><span>Общий расход</span><strong>${money(c.total)}</strong></div><div class="sumRow profit"><span>Чистая прибыль</span><strong>${money(c.profit)}</strong></div>`}
async function saveOrder(existing){
  let o=readForm(existing?{...existing}:defaultOrder());
  if(!o.item&&!o.client){toast('Укажи клиента или что нужно изготовить');return}
  const prevStatus=existing?.status;
  o.updatedAt=new Date().toISOString();
  if(o.status==='Завершён'&&prevStatus!=='Завершён')o.completedAt=new Date().toISOString();
  if(o.status!=='Завершён'&&prevStatus==='Завершён')delete o.completedAt;
  const keep=[...(existing?.photoKeys||[])];
  for(const p of pickedPhotos){const k=`photo-${o.id}-${uid()}`;await idbSet(STORE_PHOTOS,k,p.blob);keep.push(k)}
  o.photoKeys=keep;
  const idx=state.orders.findIndex(x=>x.id===o.id);if(idx>=0)state.orders[idx]=o;else state.orders.push(o);
  try{await saveState();modal=null;render();toast(o.status==='Завершён'?'Заказ сохранён. Доход и прибыль учтены в финансах.':'Заказ сохранён. В финансы попадёт после завершения.')}catch(e){console.error(e);toast('Не удалось сохранить заказ')}
}
async function deleteOrder(id){if(!confirm('Удалить этот заказ?'))return;const o=state.orders.find(x=>x.id===id);state.orders=state.orders.filter(x=>x.id!==id);await saveState();if(o)for(const k of o.photoKeys||[])await idbDel(STORE_PHOTOS,k).catch(()=>{});modal=null;render()}

async function compressImage(file){
  const data=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)});
  const img=await new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=data});
  const max=1280;let w=img.width,h=img.height;const scale=Math.min(1,max/Math.max(w,h));w=Math.max(1,Math.round(w*scale));h=Math.max(1,Math.round(h*scale));
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;canvas.getContext('2d',{alpha:false}).drawImage(img,0,0,w,h);
  let quality=.72;let blob=await new Promise(res=>canvas.toBlob(res,'image/jpeg',quality));
  while(blob&&blob.size>650000&&quality>.45){quality-=.08;blob=await new Promise(res=>canvas.toBlob(res,'image/jpeg',quality))}
  return blob;
}
async function handlePhotoFiles(e){const files=[...e.target.files].slice(0,3);if(!files.length)return;try{for(const f of files){const blob=await compressImage(f);if(blob)pickedPhotos.push({blob,url:URL.createObjectURL(blob)})}renderPickedPhotos()}catch(err){console.error(err);toast('Не удалось обработать фото')}finally{e.target.value=''}}
function renderPickedPhotos(){const strip=document.getElementById('photoStrip');if(!strip)return;for(const p of pickedPhotos){if(strip.querySelector(`[src="${CSS.escape(p.url)}"]`))continue;const im=document.createElement('img');im.className='thumb';im.src=p.url;strip.insertBefore(im,document.getElementById('addPhoto'))}}

function openOrder(id){selectedOrderId=id;const o=state.orders.find(x=>x.id===id);if(!o)return;const c=orderCosts(o),p=o.photoKeys?.[0];modal=`<div class="modalOverlay"><div class="modal"><div class="modalHead"><div class="modalTitle">${esc(o.item||'Заказ')}</div><button class="closeBtn" data-close="modal">×</button></div>${p?`<div class="detailHero"><img data-photo-key="${esc(p)}"></div>`:''}<div class="photoStrip">${(o.photoKeys||[]).map(k=>`<img class="thumb" data-photo-key="${esc(k)}">`).join('')}</div><div class="card detailInfo" style="margin-top:12px"><div class="rowTitle">${esc(o.client||'Без клиента')}</div><div class="rowSub">${esc(o.phone||'Телефон не указан')}</div><div class="clientActions">${o.phone?`<button class="btn primary" id="callClient">☎ Позвонить</button>`:''}<button class="btn" id="calendarBtn">＋ Календарь</button></div><div class="kv"><span>Статус</span><b>${esc(o.status)}</b></div><div class="kv"><span>Материал</span><b>${esc(o.material||'—')}</b></div><div class="kv"><span>Цвет</span><b>${esc(o.color||'—')}</b></div><div class="kv"><span>Количество</span><b>${o.qty}</b></div><div class="kv"><span>Вес пластика</span><b>${Math.round(o.usedGrams||0)} г</b></div><div class="kv"><span>Время печати</span><b>${o.printHours||0} ч ${o.printMinutes||0} мин</b></div><div class="kv"><span>Стоимость</span><b>${money(o.price)}</b></div><div class="kv"><span>Расход</span><b>${money(c.total)}</b></div><div class="kv"><span>Прибыль</span><b>${money(c.profit)}</b></div><div class="kv"><span>Срок</span><b>${esc(fmtDeadline(o))}</b></div>${o.notes?`<div class="kv"><span>Заметки</span><b>${esc(o.notes)}</b></div>`:''}</div><button class="btn primary block" id="editOrder" style="margin-top:14px">Изменить</button></div></div>`;render();document.querySelector('[data-close="modal"]').onclick=()=>{modal=null;render()};document.getElementById('editOrder').onclick=()=>openOrderForm(o);const cb=document.getElementById('callClient');if(cb)cb.onclick=()=>location.href=`tel:${o.phone.replace(/[^+\d]/g,'')}`;document.getElementById('calendarBtn').onclick=()=>addCalendar(o);hydrateImages(document.querySelector('.modal'))}

function openClient(key){const c=clientsData().find(x=>x.key===key);if(!c)return;modal=`<div class="modalOverlay"><div class="modal"><div class="modalHead"><div><div class="modalTitle">${esc(c.name)}</div><div class="muted">${esc(c.phone||'')}</div></div><button class="closeBtn" data-close="modal">×</button></div>${c.phone?`<button class="btn primary block" id="clientCall">☎ Позвонить</button>`:''}<div class="sectionTitle">Предыдущие заказы</div><div class="orderGrid">${c.orders.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(orderCardHTML).join('')}</div></div></div>`;render();document.querySelector('[data-close="modal"]').onclick=()=>{modal=null;render()};if(c.phone)document.getElementById('clientCall').onclick=()=>location.href=`tel:${c.phone.replace(/[^+\d]/g,'')}`;document.querySelectorAll('.modal [data-order-id]').forEach(el=>el.onclick=()=>openOrder(el.dataset.orderId));hydrateImages(document.querySelector('.modal'))}

function addCalendar(o){
  if(!o.deadlineDate){toast('Сначала укажи срок готовности');return}
  const start=new Date(`${o.deadlineDate}T${o.deadlineTime||'12:00'}:00`);const end=new Date(start.getTime()+60*60*1000);const rem=Math.max(0,n(o.reminder));
  const fmt=d=>`${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  const desc=[`Клиент: ${o.client||''}`,`Телефон: ${o.phone||''}`,`Материал: ${o.material||''}`,`Статус: ${o.status}`,`Цена: ${money(o.price)}`].join('\\n');
  const ics=`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//3D Print//RU\r\nBEGIN:VEVENT\r\nUID:${o.id}@3dprint\r\nDTSTAMP:${fmt(new Date())}\r\nDTSTART:${fmt(start)}\r\nDTEND:${fmt(end)}\r\nSUMMARY:${(o.item||'Заказ 3D-печати').replace(/[,;]/g,' ')}\r\nDESCRIPTION:${desc.replace(/[,;]/g,' ')}\r\nBEGIN:VALARM\r\nTRIGGER:-PT${rem}M\r\nACTION:DISPLAY\r\nDESCRIPTION:Срок заказа\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const blob=new Blob([ics],{type:'text/calendar;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`3d-order-${(o.client||o.item||'order').replace(/[^\wа-яё-]+/gi,'_')}.ics`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
}

function openSettings(){modal=`<div class="modalOverlay"><div class="modal"><div class="modalHead"><div class="modalTitle">Настройки</div><button class="closeBtn" data-close="modal">×</button></div><div class="formGrid">${formField('Стоимость электричества, ₽ за 1 кВт·ч','set_rate',state.settings.electricityRate,'number','step="0.01"')}${formField('Мощность принтера по умолчанию, Вт','set_power',state.settings.printerPower,'number')}</div><button class="btn primary block" id="saveSettings" style="margin-top:16px">Сохранить</button><p class="muted small">Электричество заказа = мощность принтера × время печати × тариф.</p></div></div>`;render();document.querySelector('[data-close="modal"]').onclick=()=>{modal=null;render()};document.getElementById('saveSettings').onclick=async()=>{state.settings.electricityRate=n(val('set_rate'));state.settings.printerPower=n(val('set_power'))||250;await saveState();modal=null;render();toast('Настройки сохранены')}}
function openExpense(){modal=`<div class="modalOverlay"><div class="modal"><div class="modalHead"><div class="modalTitle">Общий расход</div><button class="closeBtn" data-close="modal">×</button></div><div class="formGrid">${formField('Дата','ex_date',localDate(new Date()),'date')}<div class="field"><label>Категория</label><select id="ex_cat"><option>Пластик</option><option>Электричество</option><option>Расходники</option><option>Упаковка</option><option>Доставка</option><option selected>Прочее</option></select></div>${formField('Сумма, ₽','ex_amount',0,'number','step="0.01"')}${formField('Комментарий','ex_note','')}</div><button class="btn primary block" id="saveExpense" style="margin-top:16px">Добавить расход</button></div></div>`;render();document.querySelector('[data-close="modal"]').onclick=()=>{modal=null;render()};document.getElementById('saveExpense').onclick=async()=>{state.generalExpenses.push({id:uid(),date:val('ex_date'),category:val('ex_cat'),amount:n(val('ex_amount')),note:val('ex_note')});await saveState();modal=null;render();toast('Расход добавлен')}}

function backup(){const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`3d-print-backup-${localDate(new Date())}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}
function restore(){const inp=document.createElement('input');inp.type='file';inp.accept='application/json';inp.onchange=()=>{const f=inp.files[0];if(!f)return;const r=new FileReader();r.onload=async()=>{try{const s=JSON.parse(r.result);if(!s.orders)throw 0;state={...state,...s,settings:{...state.settings,...(s.settings||{})}};await saveState();render();toast('Данные восстановлены')}catch{toast('Не удалось прочитать резервную копию')}};r.readAsText(f)};inp.click()}

function startVoice(){
  const formSnapshot=readForm(editingOrderId?state.orders.find(x=>x.id===editingOrderId)||{}:{});
  modal+=`<div id="voiceOverlay" class="modalOverlay" style="z-index:70"><div class="modal" style="max-height:75vh"><div class="modalHead"><div class="modalTitle">Голосовой ввод</div><button class="closeBtn" id="closeVoice">×</button></div><div class="voicePanel"><button class="mic" id="micBtn">🎙</button><div style="margin-top:16px;font-weight:800" id="voiceState">Нажми и говори</div><div class="transcript" id="transcript">Клиент, деталь, количество, материал, цвет, вес пластика, цена и срок…</div><textarea id="manualSpeech" class="search" style="margin-top:14px;min-height:100px" placeholder="Если распознавание не работает — надиктуй сюда через микрофон клавиатуры iPhone"></textarea><button class="btn primary block" id="parseManual">Заполнить поля</button></div></div></div>`;
  document.getElementById('app').insertAdjacentHTML('beforeend',modal.match(/<div id="voiceOverlay"[\s\S]*$/)?.[0]||'');
  document.getElementById('closeVoice').onclick=()=>document.getElementById('voiceOverlay')?.remove();document.getElementById('parseManual').onclick=()=>{const t=val('manualSpeech');if(!t)return;applyVoice(t);document.getElementById('voiceOverlay')?.remove()};document.getElementById('micBtn').onclick=()=>recognizeVoice();
}
function recognizeVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){document.getElementById('voiceState').textContent='Используй микрофон клавиатуры ниже';document.getElementById('manualSpeech').focus();return}
  const r=new SR();r.lang='ru-RU';r.continuous=false;r.interimResults=true;let final='';document.getElementById('voiceState').textContent='Слушаю…';r.onresult=e=>{let all='';for(let i=e.resultIndex;i<e.results.length;i++){all+=e.results[i][0].transcript+' ';if(e.results[i].isFinal)final+=e.results[i][0].transcript+' '}document.getElementById('transcript').textContent=(final||all).trim()};r.onerror=()=>{document.getElementById('voiceState').textContent='Не получилось. Можно надиктовать в поле ниже.'};r.onend=()=>{const t=final.trim()||document.getElementById('transcript').textContent;if(t&& !t.startsWith('Клиент,')){applyVoice(t);document.getElementById('voiceOverlay')?.remove()}};try{r.start()}catch{document.getElementById('manualSpeech').focus()}
}
function wordNumber(s){const map={один:1,одна:1,одно:1,два:2,две:2,три:3,четыре:4,пять:5,шесть:6,семь:7,восемь:8,девять:9,десять:10};return map[String(s).toLowerCase()]||n(s)}
function parseVoice(text){
  const t=text.replace(/ё/g,'е').replace(/\s+/g,' ').trim();const low=t.toLowerCase();const out={};
  let m;
  m=t.match(/(?:клиент|заказчик)\s+([^,.;]+?)(?=\s+(?:телефон|номер|нужно|надо|изготов|напечат|деталь|корпус|материал|цена|стоимость|срок|к\s+\d)|[,.;]|$)/i);if(m)out.client=m[1].trim();
  m=t.match(/(?:телефон|номер)\s*[:\-]?\s*(\+?[\d\s()\-]{7,20})/i);if(m)out.phone=m[1].replace(/\s+/g,' ').trim();
  const mats=['PETG','PLA','ABS','ASA','TPU','PA','Nylon','PC'];for(const mat of mats){if(new RegExp(`\\b${mat}\\b`,'i').test(t)){out.material=mat.toUpperCase();break}}
  const colors=['черный','чёрный','белый','серый','красный','синий','голубой','зеленый','зелёный','желтый','жёлтый','оранжевый','фиолетовый','розовый','прозрачный','коричневый'];for(const c of colors){if(low.includes(c.replace(/ё/g,'е'))){out.color=c.replace('черный','Чёрный').replace('чёрный','Чёрный').replace(/^./,x=>x.toUpperCase());break}}
  m=t.match(/(?:количество\s*)?(\d+|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)\s*(?:шт|штук|штуки|штука)/i);if(m)out.qty=wordNumber(m[1]);
  m=t.match(/(?:ушло|расход|потрачено|вес(?:\s+пластика)?)\s*(?:около\s*)?(\d+(?:[.,]\d+)?)\s*(?:г|грамм)/i);if(m)out.usedGrams=n(m[1]);
  m=t.match(/(?:цена|стоимость(?:\s+заказа)?|заказ\s+на)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(?:руб|₽)?/i);if(m)out.price=n(m[1].replace(/\s/g,''));
  m=t.match(/(?:оплачено|предоплата)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(?:руб|₽)?/i);if(m)out.paid=n(m[1].replace(/\s/g,''));
  m=t.match(/(?:печать|время печати)\s*(\d+(?:[.,]\d+)?)\s*(?:ч|час)/i);if(m)out.printHours=n(m[1]);m=t.match(/(?:и\s*)?(\d+)\s*минут/i);if(m)out.printMinutes=n(m[1]);
  m=t.match(/(?:мощность)\s*(\d+)\s*(?:вт|ватт)/i);if(m)out.printerPower=n(m[1]);
  const now=new Date();let date=null;if(low.includes('послезавтра')){date=new Date(now);date.setDate(date.getDate()+2)}else if(low.includes('завтра')){date=new Date(now);date.setDate(date.getDate()+1)}else if(low.includes('сегодня'))date=new Date(now);m=t.match(/(?:срок|готов(?:о|ность)?|к)\s*(?:на\s*)?(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](20\d{2}|\d{2}))?/i);if(m){date=new Date(m[3]?(m[3].length===2?2000+n(m[3]):n(m[3])):now.getFullYear(),n(m[2])-1,n(m[1]))}if(date)out.deadlineDate=localDate(date);
  m=t.match(/(?:к|до|в)\s*(\d{1,2})(?::(\d{2}))?\s*(?:час(?:а|ов)?|ч)?/i);if(m)out.deadlineTime=`${pad(m[1])}:${m[2]||'00'}`;
  const itemMatch=t.match(/(?:нужно|надо|изготовить|сделать|напечатать|печатаем|деталь)\s+(.+?)(?=\s+(?:\d+|из\s+|материал|PETG|PLA|ABS|ASA|TPU|цвет|черн|бел|сер|красн|син|голуб|зелен|желт|стоимость|цена|срок|готов|ушло|расход|потрачено)|[,.;]|$)/i);if(itemMatch)out.item=itemMatch[1].replace(/^напечата(?:ть|й)\s*/i,'').trim();
  if(!out.item){const known=t.match(/\b(корпус[^,.;]*|крепление[^,.;]*|держатель[^,.;]*|фигурк[^,.;]*|деталь[^,.;]*)/i);if(known)out.item=known[1].trim()}
  return out;
}
function setField(id,v){const el=document.getElementById(id);if(el&&v!==undefined&&v!==null&&v!=='')el.value=v}
function applyVoice(text){const x=parseVoice(text);setField('f_client',x.client);setField('f_phone',x.phone);setField('f_item',x.item);setField('f_qty',x.qty);setField('f_material',x.material);setField('f_color',x.color);setField('f_usedGrams',x.usedGrams);setField('f_price',x.price);setField('f_paid',x.paid);setField('f_power',x.printerPower);setField('f_hours',x.printHours);setField('f_minutes',x.printMinutes);setField('f_date',x.deadlineDate);setField('f_time',x.deadlineTime);updateCostSummary();const filled=Object.keys(x).length;toast(filled?`Распознано полей: ${filled}`:'Не удалось разобрать фразу — можно заполнить вручную')}

init().catch(e=>{console.error(e);document.getElementById('app').innerHTML='<div class="screen"><h1>Не удалось открыть данные</h1><p>Перезапусти приложение.</p></div>'});
