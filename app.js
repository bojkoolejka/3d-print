const STORE_KEY='print3d_crm_v1';
const state={screen:'home', filter:'Все'};

function nowISO(){return new Date().toISOString()}
function fmtMoney(n){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Number(n||0))+' ₽'}
function fmtDate(d){if(!d)return '—'; return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(d))}
function fmtDateTime(d){if(!d)return '—'; return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(d))}
function pickDate(input){if(!input)return; try{if(input.showPicker)input.showPicker();else input.focus()}catch(e){input.focus()}}
function icsEscape(s){return String(s||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;')}
function icsDate(d){const x=new Date(d);return `${x.getUTCFullYear()}${String(x.getUTCMonth()+1).padStart(2,'0')}${String(x.getUTCDate()).padStart(2,'0')}T${String(x.getUTCHours()).padStart(2,'0')}${String(x.getUTCMinutes()).padStart(2,'0')}00Z`}
async function downloadCalendarEvent(o){if(!o||!o.due){alert('Сначала укажи срок готовности.');return}const start=new Date(o.due);const end=new Date(start.getTime()+30*60000);const reminder=Math.max(1,Number(o.reminderMinutes||30));const body=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//3D Zakazy//RU','CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',`UID:${o.id}@3d-zakazy`,`DTSTAMP:${icsDate(new Date())}`,`DTSTART:${icsDate(start)}`,`DTEND:${icsDate(end)}`,`SUMMARY:${icsEscape('Срок заказа: '+(o.item||'3D печать'))}`,`DESCRIPTION:${icsEscape((o.client||'')+' '+(o.phone||'')+'\n'+(o.notes||''))}`,'BEGIN:VALARM',`TRIGGER:-PT${reminder}M`,'ACTION:DISPLAY',`DESCRIPTION:До срока заказа осталось ${reminder} мин.`,'END:VALARM','END:VEVENT','END:VCALENDAR'].join('\r\n');const file=new File([body],`3d-order-${(o.client||'client').replace(/[^a-zA-Zа-яА-Я0-9_-]+/g,'_')}.ics`,{type:'text/calendar'});try{if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({files:[file],title:'Напоминание о заказе'});return}}catch(e){if(e&&e.name==='AbortError')return}const blob=new Blob([body],{type:'text/calendar;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=file.name;a.target='_blank';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000)}
function monthKey(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`}
function uid(){return crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)}

function seed(){
  return {
    orders:[
      {id:uid(),client:'Иванов Сергей',phone:'+7 912 345-67-89',item:'Корпус для блока питания',qty:2,material:'PETG',color:'Чёрный',spoolCost:1500,spoolWeight:1000,usedGrams:320,salePrice:3500,electricity:120,consumables:80,packaging:50,delivery:0,misc:0,status:'Печатается',createdAt:nowISO(),due:new Date(Date.now()+86400000).toISOString().slice(0,16),paid:3500,notes:'',inventoryMaterialId:null},
      {id:uid(),client:'Сидорова Елена',phone:'+7 905 123-45-67',item:'Крепление для камеры',qty:1,material:'PLA',color:'Серый',spoolCost:1200,spoolWeight:1000,usedGrams:140,salePrice:1800,electricity:60,consumables:30,packaging:30,delivery:0,misc:0,status:'Готов к печати',createdAt:nowISO(),due:new Date(Date.now()+2*86400000).toISOString().slice(0,16),paid:0,notes:'',inventoryMaterialId:null}
    ],
    inventory:[
      {id:uid(),type:'PETG',color:'Чёрный',remaining:620,costPerSpool:1500,spoolWeight:1000},
      {id:uid(),type:'PETG',color:'Белый',remaining:1200,costPerSpool:1550,spoolWeight:1000},
      {id:uid(),type:'PLA',color:'Серый',remaining:850,costPerSpool:1200,spoolWeight:1000}
    ],
    extraExpenses:[]
  }
}
function load(){try{return JSON.parse(localStorage.getItem(STORE_KEY))||seed()}catch(e){return seed()}}
let db=load();
function save(){localStorage.setItem(STORE_KEY,JSON.stringify(db));}

function calcOrder(o){
  const plastic=(Number(o.spoolCost||0)/Math.max(1,Number(o.spoolWeight||1000)))*Number(o.usedGrams||0);
  const expenses=plastic+Number(o.electricity||0)+Number(o.consumables||0)+Number(o.packaging||0)+Number(o.delivery||0)+Number(o.misc||0);
  const profit=Number(o.salePrice||0)-expenses;
  return {plastic,expenses,profit};
}
function isThisMonth(date){return monthKey(new Date(date))===monthKey(new Date())}
function monthOrders(){return db.orders.filter(o=>isThisMonth(o.createdAt))}
function monthExtraExpenses(){return db.extraExpenses.filter(e=>isThisMonth(e.date))}
function monthTotals(){
  const orders=monthOrders();
  const income=orders.reduce((s,o)=>s+Number(o.salePrice||0),0);
  const orderExpenses=orders.reduce((s,o)=>s+calcOrder(o).expenses,0);
  const extra=monthExtraExpenses().reduce((s,e)=>s+Number(e.amount||0),0);
  return {income,expenses:orderExpenses+extra,profit:income-orderExpenses-extra};
}

const content=document.getElementById('content');
const title=document.getElementById('screenTitle');
const todayLabel=document.getElementById('todayLabel');
const sheet=document.getElementById('sheet');
const backdrop=document.getElementById('modalBackdrop');

todayLabel.textContent=new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long'}).format(new Date());

function setScreen(name){state.screen=name;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.screen===name));render()}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setScreen(b.dataset.screen)));
document.getElementById('newOrderBtn').onclick=()=>openOrderForm();
document.getElementById('quickBackupBtn').onclick=()=>openMoreMenu();

document.getElementById('importInput').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{db=JSON.parse(await f.text());save();render();alert('Данные восстановлены')}catch{alert('Не удалось прочитать файл')}});

function render(){
  if(state.screen==='home')renderHome();
  if(state.screen==='orders')renderOrders();
  if(state.screen==='finance')renderFinance();
  if(state.screen==='more')renderMore();
}

function renderHome(){
  title.textContent='Сегодня'; const t=monthTotals();
  const active=db.orders.filter(o=>!['Готов','Выдан','Отменён'].includes(o.status));
  const ready=db.orders.filter(o=>o.status==='Готов').length;
  const unpaid=db.orders.filter(o=>Number(o.paid||0)<Number(o.salePrice||0)&&o.status!=='Отменён').length;
  content.innerHTML=`
    <section class="card dark">
      <div class="muted">Доход за месяц</div><div class="big-money">${fmtMoney(t.income)}</div>
      <div class="money-row"><div class="money-block"><small>Расходы</small><strong>${fmtMoney(t.expenses)}</strong></div><div class="money-block"><small>Прибыль</small><strong>${fmtMoney(t.profit)}</strong></div></div>
    </section>
    <div class="grid3"><div class="stat"><span class="muted">В работе</span><strong>${active.length}</strong></div><div class="stat"><span class="muted">Готово</span><strong>${ready}</strong></div><div class="stat"><span class="muted">Ждут оплаты</span><strong>${unpaid}</strong></div></div>
    <div class="section-title"><h2>Ближайшие заказы</h2><button class="link-btn" onclick="setScreen('orders')">Все</button></div>
    <div class="list">${db.orders.slice().sort((a,b)=>(a.due||'').localeCompare(b.due||'')).slice(0,5).map(orderCard).join('')||'<div class="empty">Пока нет заказов</div>'}</div>`;
}

function orderCard(o){const c=calcOrder(o);return `<article class="order-card" onclick="openOrder('${o.id}')"><div class="order-main"><div class="thumb">3D</div><div><div class="order-title">${esc(o.client||'Без имени')}</div><div class="order-sub">${esc(o.item||'Без описания')} · ${esc(o.material||'')}</div><span class="badge ${o.status==='Печатается'?'dark':''}">${esc(o.status||'Новый')}</span></div><div class="price">${fmtMoney(o.salePrice)}</div></div><div class="order-sub" style="margin-top:9px">Расход ${fmtMoney(c.expenses)} · прибыль ${fmtMoney(c.profit)}${o.due?' · срок '+fmtDate(o.due):''}</div></article>`}

function renderOrders(){title.textContent='Заказы'; const filters=['Все','Новый','Моделирование','Готов к печати','Печатается','Готов','Выдан']; const q=state.q||''; let arr=db.orders.filter(o=>(state.filter==='Все'||o.status===state.filter)&&JSON.stringify(o).toLowerCase().includes(q.toLowerCase()));
content.innerHTML=`<input class="search" placeholder="Поиск по клиенту, детали, материалу..." value="${esc(q)}" oninput="state.q=this.value;renderOrders()"><div class="segmented">${filters.map(f=>`<button class="${state.filter===f?'active':''}" onclick="state.filter='${f}';renderOrders()">${f}</button>`).join('')}</div><div class="list">${arr.map(orderCard).join('')||'<div class="empty">Ничего не найдено</div>'}</div>`}

function renderFinance(){title.textContent='Финансы'; const t=monthTotals(); const orders=monthOrders(); const cats={Пластик:0,Электричество:0,Расходники:0,Упаковка:0,Доставка:0,Прочее:0}; orders.forEach(o=>{const c=calcOrder(o);cats.Пластик+=c.plastic;cats.Электричество+=Number(o.electricity||0);cats.Расходники+=Number(o.consumables||0);cats.Упаковка+=Number(o.packaging||0);cats.Доставка+=Number(o.delivery||0);cats.Прочее+=Number(o.misc||0)}); monthExtraExpenses().forEach(e=>cats.Прочее+=Number(e.amount||0));
content.innerHTML=`<section class="card"><div class="muted">Текущий месяц</div><div class="kpi"><div><span class="muted">Доход</span><strong>${fmtMoney(t.income)}</strong></div><div><span class="muted">Расход</span><strong>${fmtMoney(t.expenses)}</strong></div><div><span class="muted">Прибыль</span><strong>${fmtMoney(t.profit)}</strong></div></div></section><section class="card"><div class="section-title" style="margin-top:0"><h2>Расходы по категориям</h2></div><div class="table-like">${Object.entries(cats).map(([k,v])=>`<div class="table-row"><span>${k}</span><strong>${fmtMoney(v)}</strong></div>`).join('')}</div></section><button class="secondary" onclick="openExpenseForm()">＋ Добавить общий расход</button>`}

function renderMore(){title.textContent='Ещё'; content.innerHTML=`<section class="card"><h2 style="margin-top:0">Склад пластика</h2>${db.inventory.map(i=>{const pct=Math.min(100,Math.round(i.remaining/Math.max(1,i.spoolWeight)*100));return `<div class="table-row"><div><strong>${esc(i.type)} ${esc(i.color)}</strong><div class="muted">Остаток: ${Math.round(i.remaining)} г</div><div class="bar" style="margin-top:7px;width:180px"><span style="width:${pct}%"></span></div></div><div>${pct}%</div></div>`}).join('')||'<div class="empty">Склад пуст</div>'}<button class="secondary" style="margin-top:12px" onclick="openMaterialForm()">＋ Добавить материал</button></section><section class="card"><h2 style="margin-top:0">Данные</h2><button class="secondary" onclick="exportBackup()">Сделать резервную копию</button><div style="height:8px"></div><button class="secondary" onclick="document.getElementById('importInput').click()">Восстановить из файла</button></section>`}

function openSheet(html){sheet.innerHTML=html;sheet.classList.remove('hidden');backdrop.classList.remove('hidden');backdrop.onclick=closeSheet}
function closeSheet(){sheet.classList.add('hidden');backdrop.classList.add('hidden');sheet.innerHTML=''}
function sheetHeader(name){return `<div class="sheet-header"><h2>${name}</h2><button class="close-btn" onclick="closeSheet()">×</button></div>`}

function openOrder(id){const o=db.orders.find(x=>x.id===id);if(!o)return; const c=calcOrder(o);openSheet(`${sheetHeader('Карточка заказа')}<section class="card"><div class="row between"><div><div class="muted">Клиент</div><h2 style="margin:3px 0">${esc(o.client)}</h2><div class="muted">${esc(o.phone||'')}</div></div><span class="badge dark">${esc(o.status)}</span></div></section><section class="card"><div class="table-row"><span>Что печатаем</span><strong>${esc(o.item)}</strong></div><div class="table-row"><span>Количество</span><strong>${o.qty||1} шт.</strong></div><div class="table-row"><span>Материал</span><strong>${esc(o.material)} / ${esc(o.color)}</strong></div><div class="table-row"><span>Расход пластика</span><strong>${o.usedGrams||0} г</strong></div><div class="table-row"><span>Срок</span><strong>${fmtDateTime(o.due)}</strong></div></section>${o.due?`<button class="secondary" onclick="downloadCalendarEvent(db.orders.find(x=>x.id==='${o.id}'))">◷ Добавить напоминание в календарь</button><div style="height:12px"></div>`:''}<section class="calc"><div class="calc-row"><span>Стоимость заказа</span><strong>${fmtMoney(o.salePrice)}</strong></div><div class="calc-row"><span>Пластик</span><strong>${fmtMoney(c.plastic)}</strong></div><div class="calc-row"><span>Все расходы</span><strong>${fmtMoney(c.expenses)}</strong></div><div class="calc-row total"><span>Прибыль</span><strong>${fmtMoney(c.profit)}</strong></div></section><div style="height:12px"></div><button class="primary" onclick="closeSheet();openOrderForm('${o.id}')">Редактировать заказ</button><div style="height:8px"></div><button class="secondary danger" onclick="deleteOrder('${o.id}')">Удалить</button>`)}

function openOrderForm(id=null){const o=id?db.orders.find(x=>x.id===id):{id:uid(),client:'',phone:'',item:'',qty:1,material:'PETG',color:'',spoolCost:1500,spoolWeight:1000,usedGrams:0,salePrice:0,electricity:0,consumables:0,packaging:0,delivery:0,misc:0,status:'Новый',createdAt:nowISO(),due:'',paid:0,notes:'',inventoryMaterialId:null};
openSheet(`${sheetHeader(id?'Редактирование':'Новый заказ')}<form class="form" id="orderForm" onsubmit="saveOrderForm(event,'${o.id}',${id?'true':'false'})">
  <div class="form-grid"><div class="form-group"><label>Клиент</label><input name="client" value="${esc(o.client)}" required></div><div class="form-group"><label>Телефон</label><input name="phone" value="${esc(o.phone||'')}"></div></div>
  <div class="form-group"><label>Что нужно изготовить</label><input name="item" value="${esc(o.item)}" required></div>
  <div class="form-grid"><div class="form-group"><label>Количество, шт.</label><input type="number" min="1" name="qty" value="${o.qty||1}"></div><div class="form-group"><label>Статус</label><select name="status">${['Новый','Моделирование','Готов к печати','Печатается','Готов','Выдан','Отменён'].map(s=>`<option ${o.status===s?'selected':''}>${s}</option>`).join('')}</select></div></div>
  <div class="form-grid"><div class="form-group"><label>Материал</label><input name="material" value="${esc(o.material||'')}"></div><div class="form-group"><label>Цвет</label><input name="color" value="${esc(o.color||'')}"></div></div>
  <div class="form-grid"><div class="form-group"><label>Стоимость катушки, ₽</label><input class="calc-input" type="number" step="0.01" name="spoolCost" value="${o.spoolCost||0}"></div><div class="form-group"><label>Вес катушки, г</label><input class="calc-input" type="number" step="1" name="spoolWeight" value="${o.spoolWeight||1000}"></div></div>
  <div class="form-group"><label>Потрачено пластика на заказ, г</label><input class="calc-input" type="number" step="0.1" name="usedGrams" value="${o.usedGrams||0}"></div>
  <div class="form-grid"><div class="form-group"><label>Цена заказа, ₽</label><input class="calc-input" type="number" step="0.01" name="salePrice" value="${o.salePrice||0}"></div><div class="form-group"><label>Оплачено, ₽</label><input type="number" step="0.01" name="paid" value="${o.paid||0}"></div></div>
  <div class="form-grid"><div class="form-group"><label>Электричество, ₽</label><input class="calc-input" type="number" step="0.01" name="electricity" value="${o.electricity||0}"></div><div class="form-group"><label>Расходники, ₽</label><input class="calc-input" type="number" step="0.01" name="consumables" value="${o.consumables||0}"></div></div>
  <div class="form-grid"><div class="form-group"><label>Упаковка, ₽</label><input class="calc-input" type="number" step="0.01" name="packaging" value="${o.packaging||0}"></div><div class="form-group"><label>Доставка, ₽</label><input class="calc-input" type="number" step="0.01" name="delivery" value="${o.delivery||0}"></div></div>
  <div class="form-group"><label>Прочие расходы, ₽</label><input class="calc-input" type="number" step="0.01" name="misc" value="${o.misc||0}"></div>
  <div class="form-group"><label>Срок готовности</label><div class="date-time-grid"><div><span class="mini-label">Дата</span><input id="dueDateInput" type="date" name="dueDate" value="${o.due?String(o.due).slice(0,10):''}" required></div><div><span class="mini-label">Время</span><input id="dueTimeInput" type="time" name="dueTime" value="${o.due?String(o.due).slice(11,16):'12:00'}" required></div></div></div>
  <div class="check-row"><input id="calendarReminder" type="checkbox" name="calendarReminder" ${o.calendarReminder!==false?'checked':''}><label for="calendarReminder">Напомнить о сроке</label><select class="reminder-select" name="reminderMinutes"><option value="15" ${Number(o.reminderMinutes||30)===15?'selected':''}>за 15 мин</option><option value="30" ${Number(o.reminderMinutes||30)===30?'selected':''}>за 30 мин</option><option value="60" ${Number(o.reminderMinutes||30)===60?'selected':''}>за 1 час</option><option value="120" ${Number(o.reminderMinutes||30)===120?'selected':''}>за 2 часа</option></select></div>
  <div class="reminder-note">После сохранения iPhone предложит открыть/поделиться событием календаря. Добавь его в «Календарь» — уведомление сработает в выбранное время.</div>
  <div class="form-group"><label>Заметки</label><textarea name="notes" rows="3">${esc(o.notes||'')}</textarea></div>
  <section class="calc" id="liveCalc"></section>
  <button class="primary" type="submit">${id?'Сохранить изменения':'Создать заказ'}</button>
  ${!id?'<button class="secondary" type="button" onclick="startVoice()">🎙 Заполнить голосом</button>':''}
</form>`); bindLiveCalc();}

function bindLiveCalc(){const f=document.getElementById('orderForm'); if(!f)return; const update=()=>{const obj=Object.fromEntries(new FormData(f).entries()); const c=calcOrder(obj); document.getElementById('liveCalc').innerHTML=`<div class="calc-row"><span>Стоимость пластика</span><strong>${fmtMoney(c.plastic)}</strong></div><div class="calc-row"><span>Общий расход</span><strong>${fmtMoney(c.expenses)}</strong></div><div class="calc-row total"><span>Чистая прибыль</span><strong>${fmtMoney(c.profit)}</strong></div>`}; f.querySelectorAll('.calc-input').forEach(i=>i.addEventListener('input',update)); update()}

function saveOrderForm(e,id,isEdit){e.preventDefault(); const f=e.target; const fd=new FormData(f); const v=Object.fromEntries(fd.entries()); const wantsReminder=fd.has('calendarReminder'); const dueDate=v.dueDate||''; const dueTime=v.dueTime||''; v.due=(dueDate&&dueTime)?`${dueDate}T${dueTime}`:''; v.reminderMinutes=Number(v.reminderMinutes||30); delete v.calendarReminder; delete v.dueDate; delete v.dueTime; ['qty','spoolCost','spoolWeight','usedGrams','salePrice','paid','electricity','consumables','packaging','delivery','misc'].forEach(k=>v[k]=Number(v[k]||0)); v.id=id; v.calendarReminder=wantsReminder; v.createdAt=isEdit?(db.orders.find(x=>x.id===id)?.createdAt||nowISO()):nowISO(); if(isEdit){db.orders=db.orders.map(x=>x.id===id?{...x,...v}:x)} else db.orders.unshift(v); save(); const saved=db.orders.find(x=>x.id===id); closeSheet(); render(); if(wantsReminder&&saved?.due){setTimeout(()=>downloadCalendarEvent(saved),150)}}
function deleteOrder(id){if(!confirm('Удалить заказ?'))return; db.orders=db.orders.filter(x=>x.id!==id); save(); closeSheet(); render()}

function openExpenseForm(){openSheet(`${sheetHeader('Новый расход')}<form class="form" onsubmit="saveExpense(event)"><div class="form-group"><label>Название</label><input name="name" placeholder="Например, новое сопло" required></div><div class="form-group"><label>Сумма, ₽</label><input type="number" step="0.01" name="amount" required></div><div class="form-group"><label>Дата</label><input type="date" name="date" value="${new Date().toISOString().slice(0,10)}"></div><button class="primary">Добавить расход</button></form>`)}
function saveExpense(e){e.preventDefault();const v=Object.fromEntries(new FormData(e.target).entries());db.extraExpenses.unshift({id:uid(),name:v.name,amount:Number(v.amount||0),date:new Date(v.date).toISOString()});save();closeSheet();render()}
function openMaterialForm(){openSheet(`${sheetHeader('Материал на складе')}<form class="form" onsubmit="saveMaterial(event)"><div class="form-grid"><div class="form-group"><label>Материал</label><input name="type" placeholder="PETG" required></div><div class="form-group"><label>Цвет</label><input name="color" placeholder="Чёрный" required></div></div><div class="form-grid"><div class="form-group"><label>Остаток, г</label><input type="number" name="remaining" required></div><div class="form-group"><label>Вес катушки, г</label><input type="number" name="spoolWeight" value="1000" required></div></div><div class="form-group"><label>Стоимость катушки, ₽</label><input type="number" name="costPerSpool" required></div><button class="primary">Сохранить</button></form>`)}
function saveMaterial(e){e.preventDefault();const v=Object.fromEntries(new FormData(e.target).entries());db.inventory.unshift({id:uid(),type:v.type,color:v.color,remaining:Number(v.remaining),spoolWeight:Number(v.spoolWeight),costPerSpool:Number(v.costPerSpool)});save();closeSheet();render()}

function openMoreMenu(){openSheet(`${sheetHeader('Действия')}<button class="secondary" onclick="exportBackup()">Сделать резервную копию</button><div style="height:8px"></div><button class="secondary" onclick="document.getElementById('importInput').click();closeSheet()">Восстановить данные</button><div style="height:8px"></div><button class="secondary" onclick="resetDemo()">Сбросить демо-данные</button><div class="version-note">Версия 1.2</div>`)}
function exportBackup(){const blob=new Blob([JSON.stringify(db,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`3d-orders-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href)}
function resetDemo(){if(!confirm('Удалить текущие данные и вернуть демо?'))return;db=seed();save();closeSheet();render()}

function startVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert('На этом устройстве браузер не поддерживает прямое распознавание речи. Можно использовать диктовку iPhone в любое текстовое поле.');return}
  const r=new SR();r.lang='ru-RU';r.interimResults=false;r.maxAlternatives=1;
  r.onresult=e=>{const text=e.results[0][0].transcript;const form=document.getElementById('orderForm');if(form){form.notes.value=(form.notes.value+' '+text).trim();}}
  r.onerror=()=>alert('Не удалось распознать речь. Попробуй ещё раз или используй диктовку клавиатуры iPhone.');r.start();
}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

window.pickDate=pickDate;window.downloadCalendarEvent=downloadCalendarEvent;window.setScreen=setScreen;window.openOrder=openOrder;window.openOrderForm=openOrderForm;window.closeSheet=closeSheet;window.saveOrderForm=saveOrderForm;window.deleteOrder=deleteOrder;window.openExpenseForm=openExpenseForm;window.saveExpense=saveExpense;window.openMaterialForm=openMaterialForm;window.saveMaterial=saveMaterial;window.exportBackup=exportBackup;window.resetDemo=resetDemo;window.startVoice=startVoice;window.state=state;window.renderOrders=renderOrders;

if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}))}
render();
