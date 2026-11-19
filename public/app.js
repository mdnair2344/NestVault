'use strict';
const $=s=>document.querySelector(s),h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const PR={critical:0,high:1,normal:2,low:3},DEF={title:'Untitled',body:'',category:'general',priority:'normal',status:'open'},CH=512*1024,MAXF=25*1048576,PAGE=30;
const J=(k,d)=>{try{return JSON.parse(localStorage[k])}catch{return d}};
const S={user:null,token:null,refresh:null,net:'online',recs:[],outbox:[],conflicts:J('nvConf',[]),view:'dashboard',budget:0,auto:true,cats:J('nvCats',[]),q:'',cat:'',st:'',shown:PAGE,pass:'',vq:'',vt:'',vd:'',vault:[],stats:{},syncing:false,last:null,retry:{n:0,at:0},lastPull:0,notes:J('nvNotes',[]),alertSince:J('nvAlert',0)};
const kb=n=>n==null?'-':n<1024?(n|0)+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB',dt=t=>new Date(t).toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
const ago=t=>{const s=(Date.now()-t)/1000|0;return s<60?'just now':s<3600?(s/60|0)+' min ago':s<86400?(s/3600|0)+' h ago':new Date(t).toLocaleDateString()},dur=ms=>ms==null?'-':ms<1000?ms+' ms':ms<60000?(ms/1000).toFixed(1)+' s':(ms/60000).toFixed(1)+' min';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),nid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
function toast(m,t=''){const e=document.createElement('div');e.className='toast '+t;e.textContent=m;$('#toasts').append(e);setTimeout(()=>e.remove(),4500)}
function notify(m,t=''){toast(m,t);S.notes.unshift({at:Date.now(),m,read:0});S.notes=S.notes.slice(0,50);localStorage.nvNotes=JSON.stringify(S.notes);bell()}
const bell=()=>{const n=S.notes.filter(x=>!x.read).length;$('#bellN').textContent=n||''};
function setTheme(t){document.documentElement.dataset.theme=t;localStorage.nvTheme=t;for(const id of['#themeA','#themeB'])$(id).textContent=t==='dark'?'Light mode':'Dark mode'}
setTheme(localStorage.nvTheme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'));

/* ---------- IndexedDB (one transaction per write; safe across tabs) ---------- */
let DB;const idb=n=>new Promise((ok,no)=>{const r=indexedDB.open(n,2);r.onupgradeneeded=()=>{for(const s of['records','outbox','uploads','safety'])if(!r.result.objectStoreNames.contains(s))r.result.createObjectStore(s,{keyPath:'id'})};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
const kv=(st,fn)=>new Promise((ok,no)=>{const t=DB.transaction(st,'readwrite');fn(t.objectStore(st));t.oncomplete=ok;t.onerror=()=>no(t.error)});
const kvPut=(st,v)=>kv(st,s=>s.put(v)),kvDel=(st,k)=>kv(st,s=>s.delete(k)),kvClear=st=>kv(st,s=>s.clear());
const all=st=>new Promise((ok,no)=>{const r=DB.transaction(st).objectStore(st).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
const writeTx=fn=>new Promise((ok,no)=>{const t=DB.transaction(['records','outbox'],'readwrite');fn(t.objectStore('records'),t.objectStore('outbox'));t.oncomplete=ok;t.onerror=()=>no(t.error)});
const getR=(s,k,cb)=>{s.get(k).onsuccess=e=>cb(e.target.result)};
async function reload(){S.recs=await all('records');S.outbox=await all('outbox')}
const BC=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('nv'):null,ping=()=>BC&&BC.postMessage(1);
if(BC)BC.onmessage=async()=>{if(!S.token||!DB)return;await reload();badge();if(!(document.activeElement&&$('#view').contains(document.activeElement)))render()};

/* ---------- restore lock: shared by all tabs through localStorage ---------- */
const busyKey=()=>'nvBusy_'+(S.user?S.user.id:'');const isBusy=()=>+localStorage[busyKey()]>Date.now();
const setBusy=sec=>{localStorage[busyKey()]=sec?Date.now()+sec*1000:0;document.body.classList.toggle('busy',!!sec)};
async function snapshotLocal(reason){await reload();await kvPut('safety',{id:Date.now(),reason,records:S.recs,outbox:S.outbox});const a=(await all('safety')).sort((x,y)=>y.id-x.id);for(const o of a.slice(5))await kvDel('safety',o.id)}
async function guarded(fn){const run=async()=>{S.syncing=true;badge();setBusy(240);try{return await fn()}finally{setBusy(0);S.syncing=false;badge()}};
  return navigator.locks?navigator.locks.request('nv-sync-'+S.user.id,{mode:'exclusive'},run):run()} // waits for any sync in another tab, blocks new ones
const clearLocalIfIdle=()=>new Promise((ok,no)=>{const t=DB.transaction(['records','outbox'],'readwrite'),rs=t.objectStore('records'),os=t.objectStore('outbox'); // outbox is re-checked inside the same transaction that clears the data
  os.count().onsuccess=e=>{if(e.target.result){no(Error('Unsynced changes appeared. Local data was left untouched.'));t.abort()}else rs.clear()};t.oncomplete=ok;t.onabort=()=>no(Error('Cancelled'))});

/* ---------- API ---------- */
let rp=null;const saveSess=()=>localStorage.nvSession=JSON.stringify({token:S.token,refresh:S.refresh,user:S.user});
const refreshTok=()=>rp||(rp=(async()=>{try{const r=await fetch('/api/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh:S.refresh})});if(!r.ok)return false;const j=await r.json();S.token=j.token;S.refresh=j.refresh;saveSess();return true}catch{return null}finally{setTimeout(()=>rp=null,0)}})());
async function api(p,o={},retry=true){
  if(S.net==='offline')throw Error('You are offline');
  let r;try{r=await fetch(p,{method:o.method||'GET',headers:{...(S.token?{Authorization:'Bearer '+S.token}:{}),...(o.headers||{}),...(o.json?{'Content-Type':'application/json'}:{})},body:o.json?JSON.stringify(o.json):o.body})}catch{throw Error('Server unreachable')}
  if(r.status===401&&S.token&&retry&&p!=='/api/refresh'){const ok=await refreshTok();if(ok)return api(p,o,false);if(ok===false){forceLogout();throw Error('Session expired - please sign in again')}throw Error('Server unreachable')}
  if(o.bin){if(!r.ok)throw Error('Download failed');return r.arrayBuffer()}
  const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Request failed');return j}
const post=(p,json)=>api(p,{method:'POST',json});
const gzip=async s=>typeof CompressionStream==='undefined'?null:new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();

/* ---------- auth ---------- */
let mode='login',SO=null;
const ROLE_HELP={viewer:'Can view records, files and backups. Cannot change anything.',editor:'Can create, edit and delete records, upload files and run backups.',admin:'Full control, including creating accounts and changing roles. A new administrator can sign in only after another administrator approves the account (the very first administrator is approved automatically).'};
function roleUi(){const r=$('#suRole').value,need=r==='editor'||r==='admin',c=$('#suCode');c.hidden=!need;c.disabled=!need;$('#roleHelp').textContent=ROLE_HELP[r]||'';
  if(need){$('#codeLbl').textContent=(r==='admin'?'Administrator':'Editor')+' access password';$('#codeHelp').textContent=r==='admin'?'The administrator access password from the server settings.':'Ask your administrator for the editor access password.'}}
async function signupOpts(){try{SO=await fetch('/api/signup-options').then(x=>x.json())}catch{return}
  for(const o of $('#suRole').options)if(o.value&&SO[o.value]===false&&!o.disabled){o.disabled=true;o.textContent+=' (not enabled on this server)'}}
async function enter(j) {
  S.token = j.token;
  S.refresh = j.refresh;
  S.user = j.user;

  // Save session and load user database
  saveSess();
  DB = await idb('nestvault-' + j.user.id);
  await reload();

  // Show application
  $('#auth').hidden = true;
  $('#app').hidden = false;

  // User information
  $('#uname').textContent = j.user.name;
  $('#avatar').textContent = j.user.name
    .split(' ')
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // Hide Backup and Trash for Reader accounts
  const isReader = j.user.role === 'viewer';

  $('#navBackups').hidden = isReader;
  $('#navTrash').hidden = isReader;

  // Existing application functionality
  if (window.cloudEnter) cloudEnter(j.user);

  bell();
  go('dashboard');

  if (S.net !== 'offline') {
    sync(true).catch(() => {});
  }
}
function forceLogout(){if(window.cloudLeave)cloudLeave();localStorage.removeItem('nvSession');S.token=S.refresh=null;S.user=null;S.pass='';$('#app').hidden=true;$('#auth').hidden=false}
async function doLogout(){
  if(S.token&&S.net!=='offline')await fetch('/api/logout',{method:'POST',headers:{Authorization:'Bearer '+S.token}}).catch(()=>{});
  await writeTx((r,o)=>{r.clear();o.clear()}).catch(()=>{});await kvClear('uploads').catch(()=>{});await kvClear('safety').catch(()=>{});S.recs=[];S.outbox=[];forceLogout()}
$('#authform').addEventListener('submit',async e=>{e.preventDefault();$('#autherr').textContent='';const f=Object.fromEntries(new FormData(e.target));if(mode==='signup'&&f.password!==f.confirm){$('#autherr').textContent='The two passwords do not match';return}
  try{const r=await fetch('/api/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f)}),j=await r.json();if(!r.ok)throw Error(j.error);if(j.pending){act.tab({t:'login'});$('#authok').textContent='Account created. '+j.message;$('#authok').hidden=false;return}await enter(j);if(mode==='signup')fetch('/api/config').then(x=>x.json()).then(k=>toast(k.mail?`Account created. A verification email was sent to ${f.email}.`:'Account created. No email service is configured on this server, so no verification email was sent.',k.mail?'':'err')).catch(()=>{})}catch(x){$('#autherr').textContent=x.message==='Failed to fetch'?'Server unreachable':x.message}});

/* ---------- local writes: each edit bumps a revision so a sync only removes what the server acknowledged ---------- */
async function saveLocal(id,fields){if(isBusy()){toast('A restore is running. Editing is paused for a moment.','err');return false}const now=Date.now();
  await writeTx((rs,os)=>getR(rs,id,rec=>{rec=rec?Object.assign(rec,fields,{updated:now}):{id,version:0,...DEF,...fields,updated:now};rs.put(rec);
    getR(os,id,ob=>{ob=ob||{id,base:rec.version,fields:{},ts:now,edits:0,naive:0,rev:0};Object.assign(ob.fields,fields);ob.ts=now;ob.edits++;ob.rev++;ob.naive+=JSON.stringify({id,base:ob.base,fields}).length+40;os.put(ob)})}));
  await reload();badge();ping();return true}
async function deleteLocal(id){if(isBusy()){toast('A restore is running. Editing is paused for a moment.','err');return false}
  await writeTx((rs,os)=>getR(rs,id,rec=>{rs.delete(id);getR(os,id,ob=>{if(rec&&rec.version===0){if(ob)os.delete(id);return}
    ob=ob||{id,base:rec?rec.version:0,fields:{},ts:Date.now(),edits:0,naive:0,rev:0};ob.deleted=true;ob.edits++;ob.rev++;ob.naive+=60;os.put(ob)})}));
  await reload();badge();ping();return true}
const catOf=o=>{const r=S.recs.find(x=>x.id===o.id);return r?r.category:o.fields.category};
const pri=o=>PR[(S.recs.find(r=>r.id===o.id)||{}).priority||'normal'];
const csize=o=>JSON.stringify({id:o.id,base:o.base,fields:o.fields,deleted:o.deleted}).length;
function plan(){const cap=S.budget*1024;let used=0;
  return[...S.outbox].sort((a,b)=>pri(a)-pri(b)||a.ts-b.ts).map(o=>{const sz=csize(o),sel=!S.cats.length||o.deleted||S.cats.includes(catOf(o)),fit=sel&&(!cap||used+sz<=cap);if(fit)used+=sz;return{o,sz,fit,sel}})}
function badge(){$('#pendBadge').textContent=S.outbox.length||'';const p=$('#pill'),n=S.net,w=S.retry.at>Date.now()?`, retry in ${Math.ceil((S.retry.at-Date.now())/1000)} s`:'';
  p.className=n==='offline'?'off':n==='slow'?'slow':'';p.textContent=(n==='offline'?'Offline':n==='slow'?'Slow connection':'Online')+': '+(S.syncing?'syncing':S.outbox.length?S.outbox.length+' pending':'synced')+w}
setInterval(()=>{if(S.token){badge();document.body.classList.toggle('busy',isBusy())}},1000);

/* ---------- sync: cross-tab lock, cursor-based incremental pull, retry with backoff ---------- */
async function sync(quiet){
  if(S.syncing||!S.token||isBusy())return;if(S.net==='offline'){if(!quiet)toast('Offline. Changes are saved on this device and will sync later.','err');return}
  const go=()=>run(quiet);if(navigator.locks)return navigator.locks.request('nv-sync-'+S.user.id,{ifAvailable:true},l=>l?go():null);return go()}
async function run(quiet){
  await reload();const send=plan().filter(x=>x.fit).map(x=>x.o);
  if(S.outbox.length&&!send.length&&!quiet)toast('Nothing to send: check the bandwidth limit and the selected categories','err');
  S.syncing=true;badge();
  try{const ck='nvCur_'+S.user.id,key=S.cats.join('|'),cur=J(ck,{}),same=cur.key===key;
    const changes=send.map(o=>({id:o.id,base:o.base,fields:o.fields,deleted:o.deleted,rev:o.rev})),json=JSON.stringify({changes,cats:S.cats,since:same?cur.since||0:0,epoch:same?cur.epoch:null,alertSince:S.alertSince}),gz=await gzip(json);
    let j=await api('/api/sync',{method:'POST',body:gz||json,headers:{...(gz?{'X-Encoding':'gzip'}:{}),'X-Naive':send.reduce((a,o)=>a+o.naive,0),'X-Edits':send.reduce((a,o)=>a+o.edits,0),'Content-Type':'application/json'}});
    const first=j;let recs=[...j.records];
    while(j.more){j=await post('/api/sync',{changes:[],cats:S.cats,since:j.cursor,epoch:first.epoch});recs=recs.concat(j.records)} // pull the rest page by page
    const ack=new Map(first.acks.map(a=>[a.id,a.rev])),ver=new Map(recs.map(r=>[r.id,r.version])),cats=S.cats;
    await new Promise((ok,no)=>{const t=DB.transaction(['records','outbox'],'readwrite'),rs=t.objectStore('records'),os=t.objectStore('outbox');
      os.getAll().onsuccess=e=>{const left=new Set();
        for(const o of e.target.result){if(!ack.has(o.id)){left.add(o.id);continue}
          if(ack.get(o.id)===o.rev)os.delete(o.id); // remove only the exact revision the server acknowledged
          else{left.add(o.id);o.base=ver.get(o.id)??o.base;os.put(o)}} // edited while syncing: keep it
        if(first.full)rs.getAll().onsuccess=e2=>{const loc=e2.target.result,srv=recs.filter(r=>!r.deleted&&!left.has(r.id)),ids=new Set(srv.map(r=>r.id));
          rs.clear();[...srv,...loc.filter(l=>!ids.has(l.id)&&(left.has(l.id)||(cats.length&&!cats.includes(l.category))))].forEach(r=>rs.put(r))};
        else for(const r of recs){if(left.has(r.id))continue;if(r.deleted)rs.delete(r.id);else rs.put(r)}};
      t.oncomplete=ok;t.onerror=()=>no(t.error)});
    const top=recs.reduce((m,r)=>Math.max(m,r.seq||0),0),prev=first.full?0:cur.since||0;localStorage[ck]=JSON.stringify({key,since:Math.max(prev,top-5),epoch:first.epoch}); // small overlap guards against late writes
    await reload();S.conflicts=first.openConflicts;localStorage.nvConf=JSON.stringify(S.conflicts);S.retry={n:0,at:0};S.lastPull=Date.now();ping();
    for(const a of first.alerts){notify('Server alert: '+a.msg,'err');S.alertSince=Math.max(S.alertSince,a.ts);localStorage.nvAlert=S.alertSince}
    S.last={at:Date.now(),changes:send.length,edits:send.reduce((a,o)=>a+o.edits,0),sent:first.sent,saved:first.saved,conflicts:first.conflicts,waiting:S.outbox.length,pulled:recs.length};
    if(first.conflicts)notify(`${first.conflicts} conflict(s) need your decision. The server version was kept and yours was saved.`,'err');
    else if(send.length)toast(`Synced ${send.length} change(s), ${kb(first.sent)} sent`)}
  catch(e){const r=S.retry;r.n++;const d=Math.min(5000*2**(r.n-1),300000);r.at=Date.now()+d;if(r.n===1||r.n%3===0)notify('Sync failed: '+e.message+`. Retrying in ${dur(d)}.`,'err');if(S.auto)setTimeout(()=>{if(S.net!=='offline')sync(true)},d)}
  finally{S.syncing=false;badge();if(['dashboard','records','sync','trash'].includes(S.view))render()}}
setInterval(()=>{if(S.token&&S.auto&&S.net!=='offline'&&S.retry.at<=Date.now()&&(S.outbox.length||Date.now()-S.lastPull>60000))sync(true)},15000);

/* ---------- navigation ---------- */
const TITLES={dashboard:'Overview',records:'Records',sync:'Sync',vault:'Vault',backups:'Backups',trash:'Trash',shared:'Shared with me',account:'Account',admin:'Administration'};
function go(v) {
  // Prevent Reader accounts from accessing Backup and Trash
  if (
    S.user?.role === 'viewer' &&
    ['backups', 'trash'].includes(v)
  ) {
    v = 'dashboard';
    toast('You do not have permission to access this section.');
  }

  S.view = v;
  document.body.classList.remove('navopen');

  document.querySelectorAll('nav a').forEach(a =>
    a.classList.toggle('on', a.dataset.v === v)
  );

  $('#crumb').innerHTML =
    `<a href="#" data-act="go" data-v="dashboard">Home</a><span>&rsaquo;</span>${h(TITLES[v] || v)}`;

  render();
}
async function render(){badge();const f=V[S.view];if(!f)return;const y=scrollY;try{$('#view').innerHTML=await f()}catch(e){$('#view').innerHTML=`<div class="note warn">${h(e.message)}</div>`}scrollTo(0,y)}
const offNote=()=>S.net==='offline'?'<div class="note warn">You are offline. This section needs a connection. Records still work offline.</div>':'';
const V={},fail=e=>offNote()||`<div class="note warn">${h(e.message)}</div>`;
const evText=e=>({sync:`Synced ${e.changes} change(s) from ${e.edits} edits, saved ${kb(e.saved)}`,conflict:`Conflict on "${h(e.title)}" (${Object.keys(e.fields||{}).join(', ')})`,resolve:`Resolved conflict on "${h(e.title)}", field ${h(e.field)}: kept ${e.choice==='mine'?'your version':'server version'}`,backup:`${h(e.type)} backup: ${e.items} items, ${kb(e.bytes)}`,restore:`Restored ${h(e.what)}${e.ms!=null?' in '+dur(e.ms):''}`,dedup:`Duplicate skipped: ${h(e.name)} (same as ${h(e.same)}), saved ${kb(e.saved)}`,vault:`Uploaded ${h(e.name)} v${e.version}`,verify:`${e.ok?'Passed':'FAILED'}: ${h(e.what)}`,disaster:h(e.msg),login:`Signed in from ${h(e.device)}`,logout:'Signed out',session:h(e.msg),delete:`Moved to trash: ${h(e.title)}`,purge:`Deleted permanently: ${h(e.what)}`,export:'Data exported',share:`Shared "${h(e.what)}" with ${h(e.with)} (${e.perm})`,'share-edit':`${h(e.by)} edited shared record "${h(e.what)}"`,alert:`ALERT: ${h(e.msg)}`}[e.kind]||h(e.kind));

/* ---------- overview ---------- */
V.dashboard=async()=>{
  try{S.stats=await api('/api/stats');localStorage.nvStats=JSON.stringify(S.stats)}catch{S.stats=J('nvStats',{})}
  const s=S.stats,pr=s.protection||{},ok=x=>x?'<span class="good">backed up</span>':'<span class="bad">not backed up</span>',cnt=p=>S.recs.filter(r=>r.priority===p).length;
  return`<h2>Overview</h2><p class="mut">${h(S.user.name)}</p>${offNote()}
  ${S.outbox.length?`<div class="note warn">${S.outbox.length} change(s) exist only on this device until they sync. <button data-act="expunsynced">Download them</button></div>`:''}
  ${s.verified===false?`<div class="note">Your email address (${h(S.user.email)}) is not verified. <button data-act="sendverify">Send verification email</button></div>`:''}
  ${S.conflicts.length?`<div class="note bad">${S.conflicts.length} sync conflict(s) need a decision. <a href="#" data-act="go" data-v="sync">Review</a></div>`:''}
  ${pr.last!==undefined?`<div class="note ${pr.protected?'':'warn'}">${pr.protected?'All data is covered by a backup.':'Some changes are not backed up yet.'} Records: ${ok(pr.records)}. Vault: ${ok(pr.vault)}. Last backup: ${pr.last?ago(pr.last):'never'}.</div>`:''}
  <div class="tiles"><div class="tile ${S.outbox.length?'warn':''}"><b>${S.outbox.length}</b><span>Changes waiting to sync</span></div><div class="tile"><b>${s.records??'-'}</b><span>Records in the cloud</span></div>
  <div class="tile ${(s.openConflicts??S.conflicts.length)?'bad':''}"><b>${s.openConflicts??S.conflicts.length} / ${s.conflicts??0}</b><span>Conflicts (open / total)</span></div><div class="tile"><b>${s.vault??0}</b><span>Vault files</span></div>
  <div class="tile"><b>${s.backups??0}</b><span>Backups</span></div><div class="tile"><b>${s.trash??0}</b><span>In trash</span></div><div class="tile"><b>${kb(s.saved)}</b><span>Bandwidth saved (estimate)</span></div><div class="tile"><b>${kb(s.dedup)}</b><span>Duplicate data avoided</span></div></div>
  <h3>Local records by priority</h3><table style="max-width:260px"><tr><th>Priority</th><th>Count</th></tr>${Object.keys(PR).map(p=>`<tr><td class="p-${p}">${p}</td><td>${cnt(p)}</td></tr>`).join('')}</table>
  <h3>Recent activity</h3>${(s.events||[]).map(e=>`<div class="ev"><time>${ago(e.ts)}</time><span>${evText(e)}</span></div>`).join('')||'<p class="mut">Nothing yet.</p>'}`};

/* ---------- records ---------- */
const cats=()=>[...new Set(S.recs.map(r=>r.category))].sort();
const stat=r=>S.conflicts.some(c=>c.record===r.id)?'<span class="bad">conflict</span>':S.outbox.some(o=>o.id===r.id)?'<span class="pend">pending</span>':`<span class="sync-ok">synced v${r.version}</span>`;
const confBox=c=>`<div class="box"><b>${h(c.title)}</b>, field <code>${h(c.field)}</code><table><tr><th>Server (kept)</th><th>Yours (saved)</th></tr><tr><td>${h(c.server)}</td><td>${h(c.client)}</td></tr></table>
  <button data-act="cres" data-id="${c.id}" data-c="server">Keep server version</button> <button data-act="cres" data-id="${c.id}" data-c="mine">Use my version</button></div>`;
function recList(){const q=S.q.toLowerCase();
  const l=S.recs.filter(r=>(!S.cat||r.category===S.cat)&&(!S.st||r.status===S.st)&&(!q||(r.title+' '+r.body+' '+r.category).toLowerCase().includes(q))).sort((a,b)=>PR[a.priority]-PR[b.priority]||b.updated-a.updated);
  if(!l.length)return'<p class="mut">No records.</p>';
  return`<table><tr><th>Title</th><th>Priority</th><th class="hide-s">Status</th><th class="hide-s">Category</th><th>Sync</th><th></th></tr>${l.slice(0,S.shown).map(r=>`<tr><td><b>${h(r.title)}</b>${r.body?`<br><span class="mut">${h(r.body.slice(0,120))}</span>`:''}</td><td class="p-${r.priority}">${r.priority}</td><td class="hide-s">${r.status}</td><td class="hide-s">${h(r.category)}</td><td>${stat(r)}</td>
  <td class="act"><button data-act="edit" data-id="${r.id}">Edit</button> <button data-act="hist" data-id="${r.id}">History</button> <button data-act="share" data-id="${r.id}" ${S.net==='offline'?'disabled title="Sharing needs a connection"':''}>Share</button> <button class="danger" data-act="delrec" data-id="${r.id}">Delete</button></td></tr>`).join('')}</table>
  <p class="mut">Showing ${Math.min(S.shown,l.length)} of ${l.length}. ${l.length>S.shown?'<button data-act="more">Show more</button>':''}</p>`}
V.records=()=>`<div class="row sb"><h2>Records</h2><button class="primary" data-act="edit">New record</button></div><p class="mut">Everything here works offline.</p>${S.conflicts.map(confBox).join('')}
  <div class="row" style="margin-bottom:10px"><input class="grow" placeholder="Search" value="${h(S.q)}" data-inp="q"><select data-chg="cat"><option value="">All categories</option>${cats().map(c=>`<option ${S.cat===c?'selected':''}>${h(c)}</option>`).join('')}</select>
  <select data-chg="st"><option value="">Any status</option>${['open','in-progress','done'].map(c=>`<option ${S.st===c?'selected':''}>${c}</option>`).join('')}</select></div><div id="list">${recList()}</div>`;
function editDlg(id){const r=S.recs.find(x=>x.id===id)||{...DEF};
  $('#dlg').innerHTML=`<form id="recform" data-id="${id||''}"><h3 style="margin-top:0">${id?'Edit record':'New record'}</h3><label>Title<input name="title" required maxlength="200" value="${h(r.title==='Untitled'&&!id?'':r.title)}"></label>
  <label>Details<textarea name="body" rows="4">${h(r.body)}</textarea></label><div class="row"><label class="grow">Category<input name="category" list="cl" value="${h(r.category)}"><datalist id="cl">${cats().map(c=>`<option>${h(c)}`).join('')}</datalist></label>
  <label class="grow">Priority<select name="priority">${Object.keys(PR).map(p=>`<option ${r.priority===p?'selected':''}>${p}</option>`).join('')}</select></label>
  <label class="grow">Status<select name="status">${['open','in-progress','done'].map(p=>`<option ${r.status===p?'selected':''}>${p}</option>`).join('')}</select></label></div>
  <div class="row" style="justify-content:flex-end"><button type="button" data-act="close">Cancel</button><button class="primary">Save</button></div></form>`;$('#dlg').showModal()}

/* ---------- sync ---------- */
V.sync=()=>{const pl=plan(),fit=pl.filter(x=>x.fit),L=S.last;
  return`<div class="row sb"><h2>Sync</h2><button class="primary" data-act="sync" ${S.syncing?'disabled':''}>Sync now</button></div>
  <p class="mut">Urgent records go first. Several edits to one record are sent as one change. If two devices edit the same field, nothing is overwritten: you choose.</p>
  <div class="box row"><label style="margin:0">Bandwidth limit per sync <select data-chg="budget" style="display:inline;width:auto"><option value="0">None</option>${[1,2,5,10].map(k=>`<option value="${k}" ${S.budget===k?'selected':''}>${k} KB</option>`).join('')}</select></label>
    <label style="margin:0"><input type="checkbox" ${S.auto?'checked':''} data-chg="auto">Sync automatically when online</label><button data-act="gen">Add 18 test edits</button></div>
  <div class="box"><b>Selective sync</b> <span class="mut">(tick categories to sync only those; none ticked = all)</span><div class="row" style="margin-top:6px">${cats().map(c=>`<label style="margin:0"><input type="checkbox" data-chg="selcat" value="${h(c)}" ${S.cats.includes(c)?'checked':''}>${h(c)}</label>`).join('')||'<span class="mut">No categories yet</span>'}</div></div>
  ${S.retry.n?`<div class="note warn">Last sync failed. Retrying automatically with increasing delay (attempt ${S.retry.n}).</div>`:''}
  ${S.conflicts.length?`<h3>Conflicts to resolve (${S.conflicts.length})</h3>${S.conflicts.map(confBox).join('')}`:''}
  <h3>Waiting to sync: ${S.outbox.length} (${fit.length} in the next sync, about ${kb(fit.reduce((a,x)=>a+x.sz,0))})</h3>
  ${pl.length?`<table><tr><th>Record</th><th>Priority</th><th>Edits</th><th>Size</th><th>Next sync</th></tr>${pl.map(({o,sz,fit,sel})=>{const r=S.recs.find(x=>x.id===o.id);return`<tr><td>${h(r?r.title:'(deleted record)')}</td><td class="p-${r?r.priority:'low'}">${r?r.priority:'-'}</td><td>${o.edits} merged into 1</td><td>${kb(sz)}</td><td>${fit?'yes':sel?'no, over the limit':'no, category not selected'}</td></tr>`}).join('')}</table>`:'<p class="mut">Nothing waiting.</p>'}
  ${L?`<h3>Last sync (${ago(L.at)})</h3><p>${L.edits} edits sent as ${L.changes} changes, ${kb(L.sent)} over the network (${kb(L.saved)} saved). ${L.pulled} record(s) received. ${L.conflicts} conflict(s). ${L.waiting} still waiting.</p>`:''}`};

/* ---------- trash ---------- */
V.trash=async()=>{let t;try{t=await api('/api/trash')}catch(e){return fail(e)}
  return`<h2>Trash</h2><p class="mut">Deleted records and files stay here until you delete them permanently.</p>
  <h3>Records (${t.records.length})</h3>${t.records.length?`<table>${t.records.map(r=>`<tr><td>${h(r.title)}<br><span class="mut">${h(r.category)}, deleted ${ago(r.at)}</span></td><td class="act"><button data-act="untr" data-id="${r.id}">Restore</button> <button class="danger" data-act="purge" data-id="${r.id}">Delete permanently</button></td></tr>`).join('')}</table>`:'<p class="mut">None.</p>'}
  <h3>Vault files (${t.vault.length})</h3>${t.vault.length?`<table>${t.vault.map(f=>`<tr><td>${h(f.name)} v${f.version}<br><span class="mut">${kb(f.size)}</span></td><td class="act"><button data-act="untv" data-id="${f.id}">Restore</button> <button class="danger" data-act="purgev" data-id="${f.id}">Delete permanently</button></td></tr>`).join('')}</table>`:'<p class="mut">None.</p>'}`};

/* ---------- shared records (online only) ---------- */
V.shared=async()=>{let l;try{l=await api('/api/shared')}catch(e){return fail(e)}
  return`<h2>Shared with me</h2><p class="mut">Records other people shared with you. Shared records can only be viewed and edited while you are online; they do not use the offline queue.</p>
  ${l.length?`<table><tr><th>Record</th><th>Owner</th><th>Access</th><th></th></tr>${l.map(r=>`<tr><td><b>${h(r.title)}</b><br><span class="mut">${h(r.body.slice(0,120))}</span></td><td>${h(r.owner)}</td><td>${r.perm}</td><td class="act">${r.perm==='edit'?`<button data-act="edsh" data-id="${r.shareId}" data-r="${r.id}">Edit</button> `:''}<button data-act="unshare" data-id="${r.shareId}" data-leave="1">Remove</button></td></tr>`).join('')}</table>`:'<p class="mut">Nothing shared with you.</p>'}`};
async function shareDlg(id){const r=S.recs.find(x=>x.id===id);if(!r||!r.version)return toast('Sync this record first, then share it','err');
  let l;try{l=await api(`/api/records/${id}/shares`)}catch(e){return toast(e.message,'err')}
  $('#dlg').innerHTML=`<h3 style="margin-top:0">Share "${h(r.title)}"</h3>${l.length?`<table>${l.map(s=>`<tr><td>${h(s.email)}</td><td>${s.perm}</td><td><button data-act="unshare" data-id="${s.id}" data-rid="${id}">Remove</button></td></tr>`).join('')}</table>`:'<p class="mut">Not shared yet.</p>'}
  <form id="shform" data-id="${id}" class="row"><input class="grow" name="email" type="email" placeholder="Email of a NestVault user" required><select name="perm"><option value="view">Can view</option><option value="edit">Can edit</option></select><button class="primary">Share</button></form><p><button data-act="close">Close</button></p>`;$('#dlg').showModal()}

/* ---------- vault ---------- */
const ICON={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',pdf:'application/pdf',txt:'text/plain',md:'text/plain',csv:'text/plain',json:'text/plain'};
const ext=n=>(n.split('.').pop()||'').toLowerCase(),ftype=n=>{const m=ICON[ext(n)]||'';return m.startsWith('image')?'image':m==='application/pdf'?'pdf':m.startsWith('text')?'text':'other'};
const strength=p=>p.length<12?['weak','bad','use at least 12 characters']:(/[a-z]/.test(p)+/[A-Z]/.test(p)+/\d/.test(p)+/[^\w]/.test(p)>=3||p.length>=20)?['strong','good','good']:['fair','pend','add capitals, numbers or symbols, or make it longer'];
function vList(){const q=S.vq.toLowerCase(),now=Date.now(),lim={day:864e5,week:6048e5,month:2592e6}[S.vd];
  const l=S.vault.filter(f=>(!q||(f.name+' '+f.folder+' '+f.tags+' '+ext(f.name)+' '+new Date(f.ts).toLocaleDateString()).toLowerCase().includes(q))&&(!S.vt||ftype(f.name)===S.vt)&&(!lim||now-f.ts<lim));
  return l.length?`<table><tr><th>Name</th><th class="hide-s">Folder</th><th class="hide-s">Tags</th><th>Ver</th><th>Size</th><th class="hide-s">Added</th><th></th></tr>${l.map(f=>`<tr><td>${h(f.name)}</td><td class="hide-s">${h(f.folder||'-')}</td><td class="hide-s">${h(f.tags||'-')}</td><td>${f.version}</td><td>${kb(f.size)}</td><td class="hide-s">${ago(f.ts)}</td>
  <td class="act"><button data-act="prev" data-id="${f.id}">Preview</button> <button data-act="dl" data-id="${f.id}">Download</button> <button data-act="vfy" data-id="${f.id}">Verify</button> <button class="danger" data-act="delv" data-id="${f.id}">Delete</button></td></tr>`).join('')}</table>`:'<p class="mut">No files.</p>'}
V.vault=async()=>{let a;try{[S.vault,a]=await Promise.all([api('/api/vault'),api('/api/account')])}catch(e){return fail(e)}const st=strength(S.pass),pend=await all('uploads'),pct=Math.min(100,a.quota.used/a.quota.limit*100);
  return`<h2>Vault</h2><p class="mut">Files are encrypted in your browser before upload. The server never sees the passphrase or the contents. If you forget the passphrase the files cannot be recovered.</p>
  <div class="box"><label>Passphrase (12+ characters, kept in memory only)<input id="pass" type="password" value="${h(S.pass)}" data-inp="pass" autocomplete="off"></label><p id="meter" class="${S.pass?st[1]:'mut'}">${S.pass?st[0]+': '+st[2]:''}</p>
  <div class="row"><input type="file" id="file" class="grow"><input id="folder" placeholder="Folder (optional)"><input id="tags" placeholder="Tags, comma separated"><button class="primary" data-act="upfile">Encrypt and upload</button></div>
  <p class="mut" id="prog">Files up to ${Math.round(MAXF/1048576)} MB are uploaded in 512 KB pieces. Storage used: ${kb(a.quota.used)} of ${kb(a.quota.limit)}.</p><div class="meter"><i style="width:${pct}%"></i></div>
  <label style="margin-top:10px">Or write a secure note<textarea id="note" rows="2"></textarea></label><button data-act="upnote">Encrypt and save note</button></div>
  ${pend.length?`<div class="note warn"><b>Interrupted uploads</b>${pend.map(u=>`<div class="row" style="margin-top:6px"><span class="grow">${h(u.name)} (${kb(u.size)})</span><button data-act="resumeup" data-id="${u.id}">Resume</button><button data-act="dropup" data-id="${u.id}">Discard</button></div>`).join('')}</div>`:''}
  <div class="row sb"><h3 style="margin:0">Files (${S.vault.length})</h3><div class="row"><input placeholder="Search name, folder, tag, type, date" value="${h(S.vq)}" data-inp="vq" style="min-width:230px"><select data-chg="vt"><option value="">All types</option>${['image','pdf','text','other'].map(t=>`<option ${S.vt===t?'selected':''}>${t}</option>`).join('')}</select>
  <select data-chg="vd"><option value="">Any date</option>${[['day','Last 24 hours'],['week','Last 7 days'],['month','Last 30 days']].map(([v,t])=>`<option value="${v}" ${S.vd===v?'selected':''}>${t}</option>`).join('')}</select></div></div><div id="vlist">${vList()}</div>`};
const toB64=u=>{let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return btoa(s)};
const hex=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
const ITER=600000; // stored in each file header so it can be raised later without breaking old files
async function key(p,salt,it){const m=await crypto.subtle.importKey('raw',new TextEncoder().encode(p),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:it,hash:'SHA-256'},m,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function enc(buf,p){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(p,salt,ITER),buf)),o=new Uint8Array(35+ct.length);
  o.set([78,86,2]);new DataView(o.buffer).setUint32(3,ITER);o.set(salt,7);o.set(iv,23);o.set(ct,35);return o} // "NV" | version | iterations | salt | iv | ciphertext
async function dec(o,p){const it=new DataView(o.buffer,o.byteOffset).getUint32(3);return crypto.subtle.decrypt({name:'AES-GCM',iv:o.slice(23,35)},await key(p,o.slice(7,23),it),o.slice(35))}
async function sendUpload(rec,have=[]){const prog=t=>{const e=$('#prog');if(e)e.textContent=t},done=new Set(have);
  for(let i=0;i<rec.chunks;i++){if(done.has(i))continue;prog(`Uploading piece ${i+1} of ${rec.chunks}...`);
    for(let tr=0;;tr++){try{await api(`/api/vault/upload/${rec.id}/${i}`,{method:'PUT',body:rec.data.slice(i*rec.chunk,(i+1)*rec.chunk),headers:{'Content-Type':'application/octet-stream'}});break}catch(e){if(tr>=2)throw e;await sleep(800*(tr+1))}}}
  const j=await post(`/api/vault/upload/${rec.id}/complete`,{name:rec.name,folder:rec.folder,tags:rec.tags});await kvDel('uploads',rec.id);return j}
async function upload(name,buf){if(S.pass.length<12)return toast('Passphrase must be at least 12 characters','err');if(buf.byteLength>MAXF)return toast('File is larger than '+Math.round(MAXF/1048576)+' MB','err');
  const prog=t=>{const e=$('#prog');if(e)e.textContent=t};let rec=null;
  try{const phash=await hex(buf),c=await post('/api/vault/check',{phash,size:buf.byteLength,name});if(c.dedup){prog('');toast(`Already stored as "${c.of}". Not uploaded again.`);return render()}
    prog('Encrypting...');const data=await enc(buf,S.pass),n=Math.ceil(data.length/c.chunk),s=await post('/api/vault/upload/start',{phash,size:buf.byteLength,total:data.length,chunks:n});
    rec={id:s.uploadId,name,folder:($('#folder')||{}).value||'',tags:($('#tags')||{}).value||'',size:buf.byteLength,phash,total:data.length,chunks:n,chunk:s.chunk,data,ts:Date.now()};
    await kvPut('uploads',rec); // keep the encrypted data so an interrupted upload can resume after a reload
    const j=await sendUpload(rec);toast(j.dedup?`Already stored as "${j.of}".`:`Stored as version ${j.version}`);render()}
  catch(e){prog('');toast(rec?'Upload interrupted: '+e.message+'. You can resume it below.':e.message,'err');render()}}
async function resumeUpload(id){const rec=(await all('uploads')).find(x=>x.id===id);if(!rec)return;
  try{let st;try{st=await api('/api/vault/upload/'+id)}catch(e){if(/Unknown upload/.test(e.message)){await kvDel('uploads',id);toast('That upload expired on the server. Please upload the file again.','err');return render()}throw e}
    if(st.state!=='open'){await kvDel('uploads',id);toast('That upload was already finished.');return render()}
    const j=await sendUpload(rec,st.received);toast(j.dedup?`Already stored as "${j.of}".`:`Upload finished: version ${j.version}`);render()}catch(e){toast('Could not resume: '+e.message,'err')}}
async function openFile(id){if(!S.pass){toast('Enter the passphrase first','err');return null}const f=S.vault.find(x=>x.id===id);if(!f)return null;
  try{const buf=await dec(new Uint8Array(await api(`/api/vault/${id}/file`,{bin:true})),S.pass);if(await hex(buf)!==f.phash){toast('Decrypted content does not match its original hash. The file is damaged.','err');return null}return{f,buf}}
  catch(e){toast(e.name==='OperationError'?'Wrong passphrase, could not decrypt':e.message,'err');return null}}

/* ---------- backups ---------- */
const SCHED=[[0,'Off'],[1,'Every minute (testing)'],[5,'Every 5 minutes'],[15,'Every 15 minutes'],[60,'Hourly'],[1440,'Daily'],[10080,'Weekly'],[43200,'Monthly']];
V.backups=async()=>{let list,me,bs;try{[list,me,bs]=await Promise.all([api('/api/backups'),api('/api/me'),api('/api/backup-status')])}catch(e){return fail(e)}
  const pc=x=>x?'<span class="good">backed up</span>':'<span class="bad">changes not backed up</span>',ig=bs.integrity;
  return`<div class="row sb"><h2>Backups</h2><button class="primary" data-act="mkbk">Back up now</button></div>
  <p class="mut">Snapshots of records and vault, compressed, with a checksum. A restore shows a preview first and always keeps a safety copy.</p>
  <dl><dt>Records</dt><dd>${pc(bs.records)}</dd><dt>Vault</dt><dd>${pc(bs.vault)}</dd><dt>Last backup</dt><dd>${bs.last?dt(bs.last):'never'}</dd>
  <dt>Integrity and backup reference audit</dt><dd>${ig?`${ig.ok?'<span class="good">passed</span>':'<span class="bad">FAILED</span>'}: ${ig.backups??0} backups and ${ig.blobs??0} referenced files audited, ${ago(ig.ts)} <button data-act="integ">Run now</button>${ig.ok?'':'<br>'+ig.bad.map(h).join('<br>')}`:'not run yet <button data-act="integ">Run now</button>'}</dd></dl>
  <div class="box row"><label style="margin:0">Scheduled backups <select data-chg="auto_bk" style="display:inline;width:auto">${SCHED.map(([v,t])=>`<option value="${v}" ${me.autobackup===v?'selected':''}>${t}</option>`).join('')}</select></label>
    <label style="margin:0">Scheduled recovery drill <select data-chg="drill_s" style="display:inline;width:auto">${[[0,'Off'],[24,'Daily'],[168,'Weekly']].map(([v,t])=>`<option value="${v}" ${me.drill===v?'selected':''}>${t}</option>`).join('')}</select></label></div>
  <p class="mut">Retention: every backup for 24 hours, then one per day for 7 days, then one per week for 5 weeks. The last 10 manual backups are kept, and safety copies for 14 days.</p>
  <h3>Snapshots (${list.length})</h3>${list.length?`<table><tr><th>When</th><th>Label</th><th class="hide-s">Type</th><th>Items</th><th class="hide-s">Size</th><th></th></tr>${list.map(b=>`<tr><td>${dt(b.ts)}</td><td>${h(b.label)}</td><td class="hide-s">${h(b.kind)}</td><td>${b.count}</td><td class="hide-s">${kb(b.size)}</td>
  <td class="act"><button data-act="vbk" data-id="${b.id}">Verify</button> <button data-act="drill" data-id="${b.id}">Test recovery</button> <button class="primary" data-act="rbk" data-id="${b.id}">Restore</button> <button class="danger" data-act="dbk" data-id="${b.id}">Delete</button></td></tr>`).join('')}</table>`:'<p class="mut">No backups yet.</p>'}`};
async function restoreDlg(id){let p;try{p=await api(`/api/backups/${id}/preview`)}catch(e){return toast(e.message,'err')}
  const lst=a=>a.length?`<br><span class="mut">${a.map(h).join(', ')}</span>`:'',pend=S.outbox.length;
  $('#dlg').innerHTML=`<h3 style="margin-top:0">Restore "${h(p.label)}"</h3><p class="mut">Taken ${dt(p.ts)}</p>
  <p>Added from the backup: <b>${p.add}</b> record(s)${lst(p.sample.add)}</p><p>Reverted to older content: <b>${p.change}</b> record(s)${lst(p.sample.change)}</p><p>Not in this backup and removed if you replace: <b>${p.lose}</b> record(s)${lst(p.sample.lose)}</p><p>Vault: ${p.vaultAdd} file(s) added, ${p.vaultLose} removed if you replace.</p>
  ${p.newer?`<div class="note warn">${p.newer} record(s) were changed after this backup. Replacing would lose those changes.</div>`:''}${pend?`<div class="note warn">${pend} offline change(s) have not synced. Sync first, so nothing is lost.</div>`:''}
  <div class="row" style="justify-content:flex-end"><button data-act="close">Cancel</button>${pend?'<button data-act="sync">Sync first</button>':''}<button data-act="dorestore" data-id="${id}" data-m="copy">Restore as new copies</button><button class="danger" data-act="dorestore" data-id="${id}" data-m="replace" ${pend?'disabled':''}>Replace current data</button></div>`;$('#dlg').showModal()}

/* ---------- account ---------- */
const download=(name,data,type='application/json')=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)};
async function localBox(){const snaps=(await all('safety')).sort((x,y)=>y.id-x.id);
  return`<h3>Data on this device</h3><p>${S.outbox.length} change(s) not yet synced. Unsynced changes exist only in this browser; another device cannot see them.</p>
  <p><button data-act="expunsynced" ${S.outbox.length?'':'disabled'}>Download unsynced data</button></p>
  <div class="row"><input type="file" id="impf" accept=".json,application/json" class="grow"><button data-act="impfile">Import records from a JSON file</button></div><p class="mut">Accepts a file from "Download unsynced data" or "Records (JSON)". Imported records are added as new records.</p>
  <p class="mut">Safety snapshots (taken automatically before a replace-restore or the ransomware drill):</p>${snaps.length?`<table>${snaps.map(x=>`<tr><td>${dt(x.id)}, ${h(x.reason)}</td><td>${x.records.length} records, ${x.outbox.length} pending</td><td><button data-act="dlsnap" data-id="${x.id}">Download</button></td></tr>`).join('')}</table>`:'<p class="mut">None.</p>'}`}
V.account=async()=>{let cloud;try{const[a,ss,au]=await Promise.all([api('/api/account'),api('/api/sessions'),api('/api/audit')]);
  cloud=`<h3>Profile</h3><dl><dt>Name</dt><dd>${h(a.user.name)}</dd><dt>Email</dt><dd>${h(a.user.email)}</dd><dt>Mobile</dt><dd>${h(a.user.phone||'-')}</dd><dt>Organisation</dt><dd>${h(a.user.org||'-')}</dd><dt>Role</dt><dd>${h(a.user.role)} (only an administrator can change roles)</dd></dl>
  <h3>Storage</h3><div class="meter" style="max-width:360px"><i style="width:${Math.min(100,a.quota.used/a.quota.limit*100)}%"></i></div><p>${kb(a.quota.used)} of ${kb(a.quota.limit)} used (vault files and backups). Largest file: ${Math.round(a.quota.maxFile/1048576)} MB.</p>
  <h3>Export</h3><p><button data-act="exp" data-f="json">Records (JSON)</button> <button data-act="exp" data-f="csv">Records (CSV)</button> <button data-act="exp" data-f="vault">Vault list (JSON)</button></p>
  <div class="row sb"><h3>Signed-in devices (${ss.length})</h3><button class="danger" data-act="revall">Sign out all other devices</button></div>
  <table>${ss.map(s=>`<tr><td>${h(s.device)} ${s.current?'<b>(this device)</b>':''}<br><span class="mut">signed in ${dt(s.created)}, last active ${ago(s.last)}</span></td><td>${s.current?'':`<button data-act="revoke" data-id="${s.id}">Sign out</button>`}</td></tr>`).join('')}</table>
  <h3>Change password</h3><form id="pwform" class="row"><input name="current" type="password" placeholder="Current password" required autocomplete="current-password"><input name="password" type="password" placeholder="New password (10+ characters, letters and numbers)" required class="grow" autocomplete="new-password"><button class="primary">Change</button></form>
  <p class="mut">Changing it signs out all other devices.</p>
  <h3>Activity log</h3><div style="max-height:340px;overflow:auto">${au.map(e=>`<div class="ev"><time>${dt(e.ts)}</time><span>${evText(e)}</span></div>`).join('')}</div>`}catch(e){cloud=fail(e)}
  return`<h2>Account</h2>${cloud}${await localBox()}`};

/* ---------- events ---------- */
const act={
  theme:()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'),
  tab:(d)=>{mode=d.t;const su=mode==='signup';for(const id of['suTop','suMid','suBot']){$('#'+id).hidden=!su;$('#'+id).disabled=!su}
    $('#authTitle').textContent=su?'Create your account':'Sign in';$('#pwhint').hidden=!su;$('#authBtn').textContent=su?'Create account':'Sign in';$('#authform').password.autocomplete=su?'new-password':'current-password';
    $('#swap').textContent=su?'I already have an account':'Create an account';$('#swap').dataset.t=su?'login':'signup';$('#autherr').textContent='';$('#authok').hidden=true;if(su){roleUi();if(!SO)signupOpts()}},
  menu:()=>document.body.classList.toggle('navopen'),
  go:d=>go(d.v),logout:()=>{if(S.outbox.length){$('#dlg').innerHTML=`<h3 style="margin-top:0">Unsynced changes</h3><p>${S.outbox.length} change(s) exist only on this device. If you sign out now they are lost.</p><p class="row"><button data-act="expunsynced">Download them first</button><button class="danger" data-act="dologout">Sign out anyway</button><button data-act="close">Cancel</button></p>`;$('#dlg').showModal()}else doLogout()},dologout:()=>{$('#dlg').close();doLogout()},close:()=>$('#dlg').close(),sync:async()=>{if($('#dlg').open)$('#dlg').close();await sync()},more:()=>{S.shown+=PAGE;$('#list').innerHTML=recList()},
  bell:()=>{$('#dlg').innerHTML=`<h3 style="margin-top:0">Alerts</h3>${S.notes.map(n=>`<div class="ev"><time>${ago(n.at)}</time><span>${h(n.m)}</span></div>`).join('')||'<p class="mut">Nothing yet.</p>'}<p><button data-act="clrnotes">Clear</button> <button data-act="close">Close</button></p>`;S.notes.forEach(n=>n.read=1);localStorage.nvNotes=JSON.stringify(S.notes);bell();$('#dlg').showModal()},
  clrnotes:()=>{S.notes=[];localStorage.nvNotes='[]';bell();$('#dlg').close()},
  edit:d=>editDlg(d.id),
  delrec:async d=>{if(confirm('Move this record to the trash?')&&await deleteLocal(d.id))render()},
  hist:async d=>{try{const v=await api(`/api/records/${d.id}/versions`);$('#dlg').innerHTML=`<h3 style="margin-top:0">Version history</h3>${v.map(x=>`<div class="ev"><div style="flex:1"><b>v${x.version}</b>, ${ago(x.ts)}<br><span class="mut">${h(x.title)} (${x.priority}, ${x.status})</span></div><button data-act="rver" data-id="${d.id}" data-v="${x.version}">Restore</button></div>`).join('')||'<p class="mut">Not synced yet.</p>'}<p><button data-act="close">Close</button></p>`;$('#dlg').showModal()}catch(e){toast(e.message==='You are offline'?'History is stored in the cloud. Go online to view it.':e.message,'err')}},
  rver:async d=>{try{await post(`/api/records/${d.id}/restore`,{version:+d.v});$('#dlg').close();await sync(true);toast('Version restored');render()}catch(e){toast(e.message,'err')}},
  cres:async d=>{try{const j=await post(`/api/conflicts/${d.id}/resolve`,{choice:d.c});S.conflicts=j.openConflicts;localStorage.nvConf=JSON.stringify(S.conflicts);await sync(true);toast('Conflict resolved');render()}catch(e){toast(e.message,'err')}},
  gen:async()=>{let l=S.recs.slice(0,3);if(!l.length){for(const t of['Clinic stock count','Field visit report'])if(!await saveLocal(nid(),{title:t}))return;l=S.recs.slice(0,2)}
    for(let i=1;i<=18;i++){const r=l[i%l.length];if(!await saveLocal(r.id,{body:`Field note update ${i}, ${new Date().toLocaleTimeString()}`,status:i%5?'in-progress':'done'}))return}toast('18 edits queued, merged into '+S.outbox.length+' change(s)');render()},
  untr:async d=>{try{await post(`/api/records/${d.id}/undelete`);await sync(true);toast('Record restored');render()}catch(e){toast(e.message,'err')}},
  purge:async d=>{if(confirm('Delete this record permanently?'))try{await api(`/api/records/${d.id}/purge`,{method:'DELETE'});render()}catch(e){toast(e.message,'err')}},
  untv:async d=>{try{await post(`/api/vault/${d.id}/undelete`);render()}catch(e){toast(e.message,'err')}},
  purgev:async d=>{if(confirm('Delete this file permanently?'))try{await api(`/api/vault/${d.id}/purge`,{method:'DELETE'});render()}catch(e){toast(e.message,'err')}},
  share:d=>shareDlg(d.id),
  unshare:async d=>{try{await api('/api/shares/'+d.id,{method:'DELETE'});if(d.rid)shareDlg(d.rid);else render()}catch(e){toast(e.message,'err')}},
  edsh:async d=>{try{const l=await api('/api/shared'),r=l.find(x=>x.shareId===d.id);if(!r)return;$('#dlg').innerHTML=`<form id="shedit" data-id="${d.id}"><h3 style="margin-top:0">Edit shared record</h3><label>Title<input name="title" value="${h(r.title)}" required></label><label>Details<textarea name="body" rows="4">${h(r.body)}</textarea></label>
    <div class="row"><label class="grow">Priority<select name="priority">${Object.keys(PR).map(p=>`<option ${r.priority===p?'selected':''}>${p}</option>`).join('')}</select></label><label class="grow">Status<select name="status">${['open','in-progress','done'].map(p=>`<option ${r.status===p?'selected':''}>${p}</option>`).join('')}</select></label></div><div class="row" style="justify-content:flex-end"><button type="button" data-act="close">Cancel</button><button class="primary">Save</button></div></form>`;$('#dlg').showModal()}catch(e){toast(e.message,'err')}},
  upfile:async()=>{const f=$('#file').files[0];if(!f)return toast('Choose a file first','err');upload(f.name,await f.arrayBuffer())},
  upnote:async()=>{const t=$('#note').value.trim();if(!t)return toast('Write a note first','err');upload('note-'+new Date().toISOString().slice(0,16).replace(/\D/g,'')+'.txt',new TextEncoder().encode(t).buffer)},
  dl:async d=>{const r=await openFile(d.id);if(r){download(r.f.name,r.buf,'application/octet-stream');toast('Decrypted, verified and downloaded')}},
  prev:async d=>{const r=await openFile(d.id);if(!r)return;const t=ftype(r.f.name),url=URL.createObjectURL(new Blob([r.buf],{type:ICON[ext(r.f.name)]||'application/octet-stream'}));
    $('#dlg').innerHTML=`<h3 style="margin-top:0">${h(r.f.name)}</h3><p class="mut">Decrypted in your browser. Integrity verified.</p>${t==='image'?`<img src="${url}" style="max-width:100%">`:t==='pdf'?`<iframe src="${url}" style="width:100%;height:60vh;border:1px solid var(--line)"></iframe>`:t==='text'?`<pre style="white-space:pre-wrap;max-height:50vh;overflow:auto;background:var(--soft);padding:10px">${h(new TextDecoder().decode(r.buf).slice(0,20000))}</pre>`:'<p>No preview for this file type. Use Download.</p>'}<p><button data-act="close">Close</button></p>`;$('#dlg').showModal()},
  vfy:async d=>{try{const j=await post(`/api/vault/${d.id}/verify`);toast(j.ok?'Stored file is intact':'Stored file is damaged',j.ok?'':'err')}catch(e){toast(e.message,'err')}},
  delv:async d=>{if(confirm('Move this file to the trash?'))try{await api('/api/vault/'+d.id,{method:'DELETE'});render()}catch(e){toast(e.message,'err')}},
  mkbk:async()=>{try{await post('/api/backups',{label:'Manual backup'});toast('Backup created');render()}catch(e){toast(e.message,'err')}},
  vbk:async d=>{try{const j=await post(`/api/backups/${d.id}/verify`);toast(j.ok?'Backup checksum is valid':'Backup is damaged',j.ok?'':'err')}catch(e){toast(e.message,'err')}},
  integ:async()=>{try{const j=await post('/api/integrity');toast(j.ok?`Integrity check passed (${j.checked} items)`:'Integrity check FAILED: '+j.bad.join(', '),j.ok?'':'err');render()}catch(e){toast(e.message,'err')}},
  drill:async d=>{try{let id=d.id;if(d.latest){const l=await api('/api/backups');if(!l.length)return toast('No backups yet','err');id=l[0].id}
    const j=await post(`/api/backups/${id}/drill`),m=`${j.ok?'Passed':'FAILED'}: ${j.items} items checked in ${dur(j.ms)}. Data loss window ${dur(j.rpoMs)}.`;toast(m,j.ok?'':'err');if(d.latest)render()}catch(e){toast(e.message,'err')}},
  dbk:async d=>{if(confirm('Delete this backup?'))try{await api('/api/backups/'+d.id,{method:'DELETE'});render()}catch(e){toast(e.message,'err')}},
  rbk:d=>restoreDlg(d.id),
  dorestore:d=>{if(d.m==='replace'&&!confirm('Replace ALL current records and files with this backup? A safety copy is taken first.'))return;
    return guarded(async()=>{try{await reload();if(d.m==='replace'){if(S.outbox.length)throw Error(`${S.outbox.length} change(s) have not synced yet. Sync them first.`);await snapshotLocal('before restore')} // re-checked now that editing and syncing are locked
      const j=await post(`/api/backups/${d.id}/restore`,{mode:d.m,confirm:d.m==='replace'});if(d.m==='replace')await clearLocalIfIdle();localStorage.removeItem('nvCur_'+S.user.id);await reload();$('#dlg').close();
      notify(`Restored ${j.restored} items (${j.mode}) in ${dur(j.ms)}${j.mode==='replace'?`. Data loss window ${dur(j.rpoMs)}.`:'.'}`)}catch(e){toast(e.message,'err')}}).then(async()=>{await sync(true);render()})},
  probe:async()=>{try{await post('/api/infra/probe',{seconds:+$('#psec').value});toast('Probe started. Trigger the failover in Atlas now.');render()}catch(e){toast(e.message,'err')}},
  disaster:async()=>{if(!confirm('This deletes your cloud records and vault files. A snapshot of the data on this device is saved first. Continue?'))return;
    await guarded(async()=>{try{await snapshotLocal('before ransomware drill');await post('/api/disaster');await writeTx((r,o)=>{r.clear();o.clear()});await reload();localStorage.removeItem('nvCur_'+S.user.id);notify('Data deleted. Restore it from Backups.','err')}catch(e){toast(e.message,'err')}});go('backups')},
  expunsynced:()=>download('nestvault-unsynced.json',JSON.stringify((()=>{const ids=new Set(S.outbox.map(o=>o.id));return{kind:'nestvault-unsynced',exported:new Date().toISOString(),records:S.recs.filter(r=>ids.has(r.id)).map(({id,title,body,category,priority,status})=>({id,title,body,category,priority,status})),deleted:S.outbox.filter(o=>o.deleted).map(o=>o.id)}})(),null,2)),
  dlsnap:async d=>{const x=(await all('safety')).find(v=>String(v.id)===d.id);if(x)download('nestvault-snapshot-'+x.id+'.json',JSON.stringify({kind:'nestvault-unsynced',records:x.records.map(({id,title,body,category,priority,status})=>({id,title,body,category,priority,status})),pending:x.outbox.length},null,2))},
  impfile:async()=>{const f=$('#impf').files[0];if(!f)return toast('Choose a JSON file first','err');let j;try{j=JSON.parse(await f.text())}catch{return toast('That file is not valid JSON','err')}
    const list=Array.isArray(j)?j:Array.isArray(j.records)?j.records:null;if(!list)return toast('No records found in that file','err');let n=0;
    for(const r of list){if(!r||typeof r.title!=='string'||!r.title.trim())continue;if(!await saveLocal(nid(),{title:r.title.slice(0,200),body:String(r.body||'').slice(0,5000),category:String(r.category||'general').slice(0,40),priority:r.priority in PR?r.priority:'normal',status:['open','in-progress','done'].includes(r.status)?r.status:'open'}))break;n++}
    toast(`Imported ${n} record(s). They will sync when you are online.`);render();sync(true)},
  resumeup:d=>resumeUpload(d.id),dropup:async d=>{await kvDel('uploads',d.id);render()},
  sendverify:async()=>{try{const j=await post('/api/email/send-verification');toast(j.already?'Your email is already verified.':j.mail?`Verification email sent to ${S.user.email}. Check your inbox (and spam folder).`:'This server has no email service configured, so no email was sent. The link was printed in the server console.',j.mail||j.already?'':'err')}catch(e){toast(e.message,'err')}},
  forgot:async()=>{let mail=true;try{mail=(await (await fetch('/api/config')).json()).mail}catch{}$('#dlg').innerHTML=`<form id="fpform"><h3 style="margin-top:0">Reset your password</h3><label>Email<input name="email" type="email" required></label>${mail?'<p class="mut">Enter the email address you sign in with. If an account exists for it, a reset link is emailed to that address. Check the spam folder too.</p>':'<div class="note warn">This server has no email service configured, so nothing will be emailed. The link is printed in the server console instead. See the README ("Email") to set up SMTP.</div>'}<div class="row" style="justify-content:flex-end"><button type="button" data-act="close">Cancel</button><button class="primary">Send link</button></div></form>`;$('#dlg').showModal()},  revoke:async d=>{try{await api('/api/sessions/'+d.id,{method:'DELETE'});render()}catch(e){toast(e.message,'err')}},
  revall:async()=>{try{await post('/api/sessions/revoke-others');toast('Signed out of all other devices');render()}catch(e){toast(e.message,'err')}},
  exp:async d=>{try{if(d.f==='vault')download('nestvault-vault.json',JSON.stringify((await api('/api/export')).vault,null,2));
    else{const r=S.recs.map(({id,title,body,category,priority,status,version,updated})=>({id,title,body,category,priority,status,version,updated:new Date(updated).toISOString()}));
      if(d.f==='json')download('nestvault-records.json',JSON.stringify(r,null,2));else{const c=v=>'"'+String(v).replace(/"/g,'""')+'"',k=Object.keys(r[0]||{id:1});download('nestvault-records.csv',[k.join(','),...r.map(x=>k.map(y=>c(x[y])).join(','))].join('\n'),'text/csv')}}}catch(e){toast(e.message,'err')}}
};
document.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b&&act[b.dataset.act]){if(b.tagName==='A')e.preventDefault();act[b.dataset.act](b.dataset,b)}});
document.addEventListener('change',async e=>{const k=e.target.dataset.chg,v=e.target.value;if(!k)return;
  if(k==='suRole')roleUi();
  else if(k==='cat'){S.cat=v;S.shown=PAGE;$('#list').innerHTML=recList()}else if(k==='st'){S.st=v;S.shown=PAGE;$('#list').innerHTML=recList()}
  else if(k==='budget'){S.budget=+v;render()}else if(k==='auto'){S.auto=e.target.checked}
  else if(k==='selcat'){S.cats=[...document.querySelectorAll('[data-chg=selcat]:checked')].map(x=>x.value);localStorage.nvCats=JSON.stringify(S.cats);render()}
  else if(k==='vt'){S.vt=v;$('#vlist').innerHTML=vList()}else if(k==='vd'){S.vd=v;$('#vlist').innerHTML=vList()}
  else if(k==='auto_bk'||k==='drill_s'){try{await post('/api/settings',k==='auto_bk'?{autobackup:+v}:{drill:+v});toast('Saved')}catch(x){toast(x.message,'err')}}});
document.addEventListener('input',e=>{const k=e.target.dataset.inp;if(k==='q'){S.q=e.target.value;S.shown=PAGE;$('#list').innerHTML=recList()}else if(k==='vq'){S.vq=e.target.value;$('#vlist').innerHTML=vList()}
  else if(k==='pass'){S.pass=e.target.value;const st=strength(S.pass),m=$('#meter');m.className=S.pass?st[1]:'mut';m.textContent=S.pass?st[0]+': '+st[2]:''}});
document.addEventListener('submit',async e=>{const id=e.target.id;
  if(id==='pwform'){e.preventDefault();try{await post('/api/password',Object.fromEntries(new FormData(e.target)));e.target.reset();toast('Password changed. Other devices were signed out.');render()}catch(x){toast(x.message,'err')}return}
  if(id==='shform'){e.preventDefault();try{await post(`/api/records/${e.target.dataset.id}/share`,Object.fromEntries(new FormData(e.target)));shareDlg(e.target.dataset.id)}catch(x){toast(x.message,'err')}return}
  if(id==='fpform'||id==='rsform'){e.preventDefault();const f=Object.fromEntries(new FormData(e.target));try{const r=await fetch(id==='fpform'?'/api/password/forgot':'/api/password/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(id==='rsform'?{...f,token:e.target.dataset.token}:f)}),j=await r.json();if(!r.ok)throw Error(j.error);
      $('#dlg').close();toast(id==='fpform'?'If that email has an account, a reset link was sent. Check your inbox and spam folder.':'Password changed. You can sign in now.')}catch(x){toast(x.message,'err')}return}
  if(id==='shedit'){e.preventDefault();try{await post(`/api/shared/${e.target.dataset.id}/edit`,{fields:Object.fromEntries(new FormData(e.target))});$('#dlg').close();toast('Saved');render()}catch(x){toast(x.message,'err')}return}
  if(id!=='recform')return;e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),rid=e.target.dataset.id,r=S.recs.find(x=>x.id===rid);
  const fields=r?Object.fromEntries(Object.entries(f).filter(([k,v])=>r[k]!==v)):f;if(r&&!Object.keys(fields).length){$('#dlg').close();return}
  if(!await saveLocal(rid||nid(),fields))return;$('#dlg').close();toast(S.net==='offline'?'Saved on this device. It will sync when you are online.':'Saved');render();if(S.net!=='offline'&&S.auto)sync(true)});
addEventListener('online',()=>{toast('Connection restored');if(S.token&&S.auto){S.retry={n:0,at:0};sync(true)}});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
(async()=>{const m=location.hash.match(/^#(reset|verify)=([\w-]+)$/);if(!m)return;history.replaceState(null,'',location.pathname);
  if(m[1]==='verify'){try{const r=await fetch('/api/email/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:m[2]})}),j=await r.json();if(!r.ok)throw Error(j.error);toast('Email address verified.')}catch(e){toast(e.message,'err')}}
  else{$('#dlg').innerHTML=`<form id="rsform" data-token="${m[2]}"><h3 style="margin-top:0">Choose a new password</h3><label>New password<input name="password" type="password" required autocomplete="new-password"></label><p class="mut">At least 10 characters, with letters and numbers.</p><div class="row" style="justify-content:flex-end"><button class="primary">Change password</button></div></form>`;$('#dlg').showModal()}})();
try{const s=J('nvSession',null);if(s&&s.token)enter(s)}catch{}
