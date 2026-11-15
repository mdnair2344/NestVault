// Integration tests: start the real server and call it over HTTP.
// Default: in-memory database stand-in (no Atlas needed).  With TEST_ATLAS=1 the same tests run against MONGODB_URI (a temporary database is created and dropped).
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path'),crypto=require('node:crypto');
const ATLAS=!!process.env.TEST_ATLAS,PORT=3900+Math.floor(Math.random()*90),B='http://localhost:'+PORT,DBN='nv_test_'+crypto.randomBytes(4).toString('hex'),OV=51;
let proc,T,T2,out='';
async function call(p,{m='GET',json,body,tok=T,hd={}}={}){const r=await fetch(B+p,{method:m,headers:{...(tok?{Authorization:'Bearer '+tok}:{}),...(json?{'Content-Type':'application/json'}:{}),...hd},body:json?JSON.stringify(json):body});
  const ct=r.headers.get('content-type')||'';const o=ct.includes('json')?await r.json():Buffer.from(await r.arrayBuffer());return r.ok?o:{status:r.status,error:o.error}}
const post=(p,json,o={})=>call(p,{m:'POST',json,...o}),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const put=(tok,id,i,buf)=>call(`/api/vault/upload/${id}/${i}`,{m:'PUT',body:buf,tok,hd:{'Content-Type':'application/octet-stream'}});
async function allRecs(tok=T){let r=await post('/api/sync',{changes:[],since:0,epoch:null},{tok}),a=r.records;while(r.more){r=await post('/api/sync',{changes:[],since:r.cursor,epoch:r.epoch},{tok});a=a.concat(r.records)}return a}
async function upload(tok,len,name,extra={}){const data=crypto.randomBytes(len),plain=len-OV,phash=crypto.createHash('sha256').update(data).digest('hex'),c=await post('/api/vault/check',{phash,size:plain},{tok});if(c.dedup)return{c};
  const n=Math.ceil(len/c.chunk),s=await post('/api/vault/upload/start',{phash,size:plain,total:len,chunks:n},{tok});if(s.error)return{s};
  for(let i=0;i<n;i++)assert.ok((await put(tok,s.uploadId,i,data.subarray(i*c.chunk,(i+1)*c.chunk))).ok);
  return{data,s,n,phash,done:await post(`/api/vault/upload/${s.uploadId}/complete`,{name,...extra},{tok})}}
before(async()=>{const env={...process.env,MONGODB_URI:ATLAS?process.env.MONGODB_URI:'fake',PORT,LOG:'off',QUOTA_MB:'10',MAX_FILE_MB:'3',APP_URL:B,ADMIN_CODE:'admin-code-1',EDITOR_CODE:'editor-code-1',TRUST_PROXY:'1'};if(ATLAS)env.DB_NAME=DBN;else env.NESTVAULT_FAKE_DB='1';
  proc=spawn('node',[path.join(__dirname,'..','server.js')],{env});proc.stdout.on('data',d=>out+=d);
  await new Promise((ok,no)=>{const iv=setInterval(()=>out.includes('running')&&(clearInterval(iv),ok()),50);proc.on('exit',c=>no(Error('server exited '+c)));setTimeout(()=>no(Error('timeout: '+out)),20000)});
  T=(await post('/api/signup',{email:'main@test.io',name:'Main User',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'longenough123',confirm:'longenough123'},{tok:null})).token;T2=(await post('/api/signup',{email:'other@test.io',name:'Other',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'longenough123',confirm:'longenough123'},{tok:null})).token});
after(async()=>{proc.kill();if(ATLAS){const {MongoClient}=require('mongodb'),c=new MongoClient(process.env.MONGODB_URI);await c.connect();await c.db(DBN).dropDatabase();await c.close()}});

test('health and security headers',async()=>{const r=await fetch(B+'/health');assert.equal((await r.json()).ok,true);assert.ok(r.headers.get('content-security-policy'));assert.equal(r.headers.get('x-frame-options'),'DENY')});
test('signup validation and login failure',async()=>{assert.match((await post('/api/signup',{email:'a@b.co',name:'Ann',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'short1',confirm:'short1'},{tok:null})).error,/10\+/);assert.equal((await post('/api/login',{email:'nobody@x.io',password:'x'},{tok:null})).status,401)});
test('sync: create, incremental cursor, pagination',async()=>{
  const ch=Array.from({length:250},(_,i)=>({id:'p'+i,base:0,rev:1,fields:{title:'R'+i}}));let r=await post('/api/sync',{changes:ch,since:0,epoch:null});
  assert.equal(r.records.length,200);assert.equal(r.more,true);assert.equal(r.acks.length,250);const e=r.epoch;let all=r.records,cur=r.cursor;
  while(r.more){r=await post('/api/sync',{changes:[],since:cur,epoch:e});all=all.concat(r.records);cur=r.cursor}assert.ok(all.length>=250);
  const inc=await post('/api/sync',{changes:[{id:'p1',base:1,rev:2,fields:{body:'x'}}],since:cur,epoch:e});assert.equal(inc.full,false);assert.deepEqual(inc.records.map(x=>x.id),['p1'])});
test('conflict: server wins, both versions kept, resolved manually; device clock ignored',async()=>{
  await post('/api/sync',{changes:[{id:'c1',base:0,rev:1,fields:{title:'T',body:'orig'}}]});await post('/api/sync',{changes:[{id:'c1',base:1,rev:1,fields:{body:'A'}}]});
  const r=await post('/api/sync',{changes:[{id:'c1',base:1,rev:2,fields:{body:'B'},ts:9e15}]});assert.equal(r.conflicts,1);const cf=r.openConflicts.find(x=>x.record==='c1');assert.equal(cf.server,'A');assert.equal(cf.client,'B');
  await post(`/api/conflicts/${cf.id}/resolve`,{choice:'mine'});assert.equal((await allRecs()).find(x=>x.id==='c1').body,'B')});
test('unknown base is a conflict, not an overwrite',async()=>{assert.equal((await post('/api/sync',{changes:[{id:'c1',base:0,rev:3,fields:{body:'stale'}}]})).conflicts,1)});
test('recycle bin',async()=>{await post('/api/sync',{changes:[{id:'c1',base:50,rev:9,deleted:true}]});assert.ok((await call('/api/trash')).records.some(x=>x.id==='c1'));await post('/api/records/c1/undelete');assert.ok(!(await call('/api/trash')).records.some(x=>x.id==='c1'))});

test('ownership: another user cannot read or change a record',async()=>{
  await post('/api/sync',{changes:[{id:'own1',base:0,rev:1,fields:{title:'Mine'}}]});
  for(const [m,p,j] of [['GET','/api/records/own1/versions'],['POST','/api/records/own1/restore',{version:1}],['POST','/api/records/own1/undelete'],['DELETE','/api/records/own1/purge']])assert.equal((await call(p,{m,json:j,tok:T2})).status,404);
  await post('/api/sync',{changes:[{id:'own1',base:1,rev:1,fields:{title:'Hijack'}}]},{tok:T2});assert.equal((await allRecs()).find(x=>x.id==='own1').title,'Mine')});

test('vault: strict chunked upload, dedup, download, verify',async()=>{
  const u=await upload(T,1300000,'big.bin',{folder:'docs',tags:'a,b'});assert.equal(u.done.version,1);
  assert.equal((await post('/api/vault/check',{phash:u.phash,size:u.data.length-OV})).dedup,true);
  const f=(await call('/api/vault')).find(x=>x.name==='big.bin');assert.equal(f.tags,'a,b');assert.ok((await call(`/api/vault/${f.id}/file`)).equals(u.data));assert.equal((await post(`/api/vault/${f.id}/verify`)).ok,true);assert.equal((await call(`/api/vault/${f.id}/file`,{tok:T2})).status,404)});
test('vault: upload validation (sizes, chunk sizes, double completion, bad sessions)',async()=>{
  const len=600000,data=crypto.randomBytes(len),phash=crypto.createHash('sha256').update(data).digest('hex');
  assert.equal((await post('/api/vault/upload/start',{phash,size:len,total:len,chunks:2})).status,400,'total must equal size + overhead');
  assert.equal((await post('/api/vault/upload/start',{phash,size:len-OV,total:len,chunks:5})).status,400,'chunk count must match');
  const s=await post('/api/vault/upload/start',{phash,size:len-OV,total:len,chunks:2}),CH=524288;
  assert.equal((await put(T,s.uploadId,0,data.subarray(0,1000))).status,400,'non-final chunk must be full size');assert.equal((await put(T,s.uploadId,5,Buffer.alloc(10))).status,400,'chunk number out of range');
  assert.equal((await put(T2,s.uploadId,0,data.subarray(0,CH))).status,404,'other users cannot use the session');
  assert.ok((await put(T,s.uploadId,0,data.subarray(0,CH))).ok);assert.equal((await put(T,s.uploadId,1,data.subarray(CH,CH+5))).status,400,'last chunk must have the exact remaining size');
  assert.equal((await post(`/api/vault/upload/${s.uploadId}/complete`,{name:'x'})).status,400,'incomplete upload refused');
  const st=await call('/api/vault/upload/'+s.uploadId);assert.deepEqual(st.received,[0]);          // resume: only the missing piece is sent
  assert.ok((await put(T,s.uploadId,1,data.subarray(CH))).ok);assert.equal((await post(`/api/vault/upload/${s.uploadId}/complete`,{name:'resumed.bin'})).version,1);
  assert.equal((await post(`/api/vault/upload/${s.uploadId}/complete`,{name:'again.bin'})).status,409,'cannot complete twice');assert.equal((await put(T,s.uploadId,1,data.subarray(CH))).status,409,'cannot write to a finished upload');
  const par=await Promise.all([1,2,3].map(()=>post(`/api/vault/upload/${s.uploadId}/complete`,{name:'p.bin'})));assert.ok(par.every(x=>x.status===409))});
test('vault: quota is enforced atomically for parallel uploads',async()=>{
  const U=(await post('/api/signup',{email:'quota@test.io',name:'Quota',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'longenough123',confirm:'longenough123'},{tok:null})).token,len=2900000+OV,res=await Promise.all(Array.from({length:6},(_,i)=>post('/api/vault/upload/start',{phash:crypto.createHash('sha256').update('q'+i).digest('hex'),size:len-OV,total:len,chunks:Math.ceil(len/524288)},{tok:U})));
  const ok=res.filter(r=>r.uploadId).length;assert.equal(ok,3,'only 3 x 2.9 MB fit in 10 MB');assert.equal(res.filter(r=>r.status===413).length,3)});

test('backups: preview, copy restore, replace restore (confirm), drill, history',async()=>{
  await post('/api/backups',{label:'t1'});const bk=(await call('/api/backups'))[0];assert.equal((await call('/api/backup-status')).protected,true);
  await post('/api/sync',{changes:[{id:'newer',base:0,rev:1,fields:{title:'Newer than backup'}}]});assert.equal((await call('/api/backup-status')).records,false);
  const pv=await call(`/api/backups/${bk.id}/preview`);assert.ok(pv.lose>=1&&pv.newer>=1);
  const n0=(await call('/api/stats')).records,cp=await post(`/api/backups/${bk.id}/restore`,{mode:'copy'});assert.ok(cp.restored>0&&(await call('/api/stats')).records>n0);
  assert.equal((await post(`/api/backups/${bk.id}/restore`,{mode:'replace'})).status,400);const rp=await post(`/api/backups/${bk.id}/restore`,{mode:'replace',confirm:true});assert.ok(rp.restored>0);
  const f=(await call('/api/vault')).find(x=>x.name==='big.bin');assert.ok(f,'vault file survives replace-restore');assert.equal((await post(`/api/vault/${f.id}/verify`)).ok,true);
  assert.equal((await post(`/api/backups/${bk.id}/drill`)).ok,true);assert.ok((await call('/api/recoveries')).length>=2);
  assert.equal((await post('/api/sync',{changes:[],since:5,epoch:0})).full,true,'epoch bump forces full resync')});
test('parallel restores never corrupt data (each succeeds or is refused)',async()=>{
  const bk=(await call('/api/backups'))[0],rs=await Promise.all([1,2,3].map(()=>post(`/api/backups/${bk.id}/restore`,{mode:'replace',confirm:true})));
  assert.ok(rs.filter(r=>r.restored).length>=1);assert.ok(rs.every(r=>r.restored||r.status===409));
  assert.equal((await post('/api/integrity')).ok,true);assert.equal((await post('/api/sync',{changes:[]})).status,undefined)});
test('recovery after the cloud data is deleted',async()=>{
  await post('/api/backups',{label:'before-disaster'});const bk=(await call('/api/backups'))[0],before=(await call('/api/stats')).records;
  assert.ok((await post('/api/disaster')).ok);assert.equal((await call('/api/stats')).records,0);assert.equal((await call('/api/vault')).length,0);
  const r=await post(`/api/backups/${bk.id}/restore`,{mode:'replace',confirm:true});assert.equal((await call('/api/stats')).records,before);
  const f=(await call('/api/vault')).find(x=>x.name==='big.bin');assert.ok(f);assert.equal((await post(`/api/vault/${f.id}/verify`)).ok,true);assert.ok((await call(`/api/vault/${f.id}/file`)).length>1000000)});
test('integrity and backup reference audit; quota usage',async()=>{const r=await post('/api/integrity');assert.equal(r.ok,true);assert.ok(r.backups>=1&&r.blobs>=1);assert.ok((await call('/api/account')).quota.used>0)});

test('two devices: offline edits merge, same-field edits conflict',async()=>{
  const sg=(await post('/api/signup',{email:'dev@test.io',name:'Dev',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'longenough123',confirm:'longenough123'},{tok:null})).token,A=(await post('/api/login',{email:'dev@test.io',password:'longenough123'},{tok:null})).token,Bt=(await post('/api/login',{email:'dev@test.io',password:'longenough123'},{tok:null})).token;void sg;
  await post('/api/sync',{changes:[{id:'d1',base:0,rev:1,fields:{title:'Plan',body:'v1'}}]},{tok:A});assert.equal((await allRecs(Bt)).find(x=>x.id==='d1').version,1);
  await post('/api/sync',{changes:[{id:'d1',base:1,rev:2,fields:{title:'Plan A'}}]},{tok:A});                  // device A edits the title
  const m=await post('/api/sync',{changes:[{id:'d1',base:1,rev:2,fields:{body:'v2 from B'}}]},{tok:Bt});assert.equal(m.conflicts,0);  // device B (offline, older base) edits another field: merges
  const c=await post('/api/sync',{changes:[{id:'d1',base:1,rev:3,fields:{title:'Plan B'}}]},{tok:Bt});assert.equal(c.conflicts,1);   // same field: conflict, nothing lost
  const r=(await allRecs(A)).find(x=>x.id==='d1');assert.equal(r.title,'Plan A');assert.equal(r.body,'v2 from B');assert.equal(c.openConflicts[0].client,'Plan B')});
test('sessions: refresh rotation, revoke, logout',async()=>{const s=await post('/api/login',{email:'main@test.io',password:'longenough123'},{tok:null}),r=await post('/api/refresh',{refresh:s.refresh},{tok:null});assert.ok(r.token);assert.equal((await post('/api/refresh',{refresh:s.refresh},{tok:null})).status,401);
  await post('/api/logout',{},{tok:r.token});assert.equal((await call('/api/stats',{tok:r.token})).status,401)});
test('password reset and email verification',async()=>{
  const mail=re=>(out.match(re)||[]).pop(),S=await post('/api/signup',{email:'reset@test.io',name:'Reset',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'firstpassword1',confirm:'firstpassword1'},{tok:null});await sleep(100);
  const vt=mail(/#verify=([\w-]+)/g)&&out.match(/#verify=([\w-]+)/g).pop().split('=')[1];assert.equal((await call('/api/stats',{tok:S.token})).verified,false);assert.equal((await post('/api/email/verify',{token:vt},{tok:null})).ok,true);assert.equal((await call('/api/stats',{tok:S.token})).verified,true);assert.equal((await post('/api/email/verify',{token:vt},{tok:null})).status,400,'tokens are single use');
  assert.equal((await post('/api/password/forgot',{email:'nobody@nowhere.io'},{tok:null})).ok,true,'same answer for unknown emails');assert.equal((await post('/api/password/forgot',{email:'reset@test.io'},{tok:null})).ok,true);await sleep(100);
  const rt=out.match(/#reset=([\w-]+)/g).pop().split('=')[1];assert.equal((await post('/api/password/reset',{token:rt,password:'weak'},{tok:null})).status,400);
  assert.equal((await post('/api/password/reset',{token:rt,password:'secondpassword2'},{tok:null})).ok,true);assert.equal((await post('/api/password/reset',{token:rt,password:'thirdpassword3'},{tok:null})).status,400,'reset link is single use');
  assert.equal((await call('/api/stats',{tok:S.token})).status,401,'old sessions are signed out');assert.equal((await post('/api/login',{email:'reset@test.io',password:'firstpassword1'},{tok:null})).status,401);assert.ok((await post('/api/login',{email:'reset@test.io',password:'secondpassword2'},{tok:null})).token)});
test('sharing: view vs edit, isolation',async()=>{
  await post('/api/sync',{changes:[{id:'sh1',base:0,rev:1,fields:{title:'Shared one'}}]});assert.equal((await post('/api/records/sh1/share',{email:'other@test.io',perm:'view'})).ok,true);
  const l=await call('/api/shared',{tok:T2});assert.equal(l[0].title,'Shared one');assert.equal((await post(`/api/shared/${l[0].shareId}/edit`,{fields:{title:'x'}},{tok:T2})).status,403);
  await post('/api/records/sh1/share',{email:'other@test.io',perm:'edit'});assert.equal((await post(`/api/shared/${l[0].shareId}/edit`,{fields:{body:'edited by other'}},{tok:T2})).ok,true);
  assert.equal((await allRecs()).find(x=>x.id==='sh1').body,'edited by other');assert.equal((await call('/api/records/sh1/versions',{tok:T2})).status,404)});
test('retention keeps newest versions only',async()=>{for(let i=0;i<25;i++)await post('/api/sync',{changes:[{id:'v1',base:i||0,rev:i+1,fields:{body:'b'+i,title:'V'}}]});assert.ok((await call('/api/records/v1/versions')).length<=20)});
test('metrics and failover probe',async()=>{const m=await call('/api/metrics');assert.ok(m.requests>10);assert.equal((await post('/api/infra/probe',{seconds:10})).started,true);await sleep(1500);const p=await call('/api/infra/probe');assert.ok(p.ok>0&&p.failed===0)});

/* ---- accounts and roles ---- */
let ipn=0;const NEWIP=()=>({tok:null,hd:{'x-forwarded-for':'10.9.'+(ipn++)+'.1'}}); // each sign-up comes from its own address so the rate limiter does not interfere
const SU={phone:'9876543210',org:'Test Clinic',password:'longenough123',confirm:'longenough123'};
test('demo accounts are gone',async()=>{assert.equal((await post('/api/demo',{},NEWIP())).status,404);assert.equal((await fetch(B+'/api/config').then(r=>r.json())).demoAdmin,undefined)});
test('sign-up asks for every field and the role access password',async()=>{
  const bad=async(x,re,st=400)=>{const r=await post('/api/signup',{email:'x@test.io',name:'Xavier',role:'viewer',...SU,...x},NEWIP());assert.equal(r.status,st,JSON.stringify(x));assert.match(r.error,re)};
  await bad({name:''},/full name/i);await bad({email:'nope'},/email/i);await bad({phone:'abc'},/mobile/i);await bad({org:''},/organisation/i);await bad({role:''},/role/i);await bad({role:'boss'},/role/i);
  await bad({confirm:'different12345'},/match/);await bad({password:'short1',confirm:'short1'},/10\+/);
  await bad({role:'editor'},/Wrong editor/,403);await bad({role:'editor',code:'wrong'},/Wrong editor/,403);await bad({role:'admin',code:'editor-code-1'},/Wrong admin/,403)});
test('viewer needs no access password and is read-only',async()=>{
  const v=await post('/api/signup',{email:'view@test.io',name:'Vera Viewer',role:'viewer',...SU},NEWIP());assert.equal(v.user.role,'viewer');
  const w=await post('/api/sync',{changes:[{id:'v1',base:0,rev:1,fields:{title:'nope'}}]},{tok:v.token});assert.equal(w.status,403);
  assert.equal((await call('/api/admin/users',{tok:v.token})).status,403);
  const me=await call('/api/account',{tok:v.token});assert.equal(me.user.phone,'9876543210');assert.equal(me.user.org,'Test Clinic')});
test('administrators: the first is automatic, later ones need approval from another administrator; roles change only through administrators',async()=>{
  assert.deepEqual(await call('/api/signup-options',NEWIP()),{admin:true,editor:true,viewer:true});
  const ed=await post('/api/signup',{email:'ed@test.io',name:'Edna Editor',role:'editor',code:'editor-code-1',...SU},NEWIP());assert.equal(ed.user.role,'editor');
  assert.equal((await call('/api/admin/users',{tok:ed.token})).status,403);assert.equal((await post('/api/admin/users/'+ed.user.id+'/role',{role:'admin'},{tok:ed.token})).status,403,'editor cannot promote self');
  const ad=await post('/api/signup',{email:'boss@test.io',name:'Ada Admin',role:'admin',code:'admin-code-1',...SU},NEWIP());assert.equal(ad.user.role,'admin','first administrator is approved automatically');
  const p2=await post('/api/signup',{email:'boss2@test.io',name:'Second Admin',role:'admin',code:'admin-code-1',...SU},NEWIP());
  assert.equal(p2.pending,true);assert.equal(p2.token,undefined);
  const lg=await post('/api/login',{email:'boss2@test.io',password:'longenough123'},NEWIP());assert.equal(lg.status,403);assert.match(lg.error,/approval/);
  const list0=await call('/api/admin/users',{tok:ad.token}),pend=list0.find(u=>u.email==='boss2@test.io');assert.equal(pend.pending,true);
  assert.equal((await post('/api/admin/users/'+pend.id+'/role',{role:'editor'},{tok:ad.token})).status,409,'pending account must be approved or rejected first');
  assert.equal((await post('/api/admin/users/'+pend.id+'/approve',{},{tok:ed.token})).status,403,'only administrators approve');
  assert.ok((await call('/api/audit',{tok:ad.token})).some(e=>/waiting for approval/.test(e.msg||'')),'existing administrators are alerted');
  assert.equal((await post('/api/admin/users/'+pend.id+'/approve',{},{tok:ad.token})).ok,true);
  const ok=await post('/api/login',{email:'boss2@test.io',password:'longenough123'},NEWIP());assert.equal(ok.user.role,'admin');
  assert.equal((await post('/api/admin/users/'+ad.user.id+'/approve',{},{tok:ad.token})).status,403,'nobody approves their own account');
  const p3=await post('/api/signup',{email:'boss3@test.io',name:'Third Admin',role:'admin',code:'admin-code-1',...SU},NEWIP());assert.equal(p3.pending,true);
  const id3=(await call('/api/admin/users',{tok:ad.token})).find(u=>u.email==='boss3@test.io').id;
  assert.equal((await post('/api/admin/users/'+id3+'/reject',{},{tok:ok.token})).ok,true);assert.equal((await post('/api/login',{email:'boss3@test.io',password:'longenough123'},NEWIP())).status,401);
  const mk=(role,email)=>post('/api/admin/users',{name:'Made '+role,email,role,phone:'9123456780',org:'Ward 7',password:'temporary-pass1'},{tok:ad.token});
  assert.equal((await mk('viewer','m2@test.io')).role,'viewer');assert.equal((await mk('boss','m3@test.io')).status,400);
  assert.equal((await post('/api/admin/users/'+ed.user.id+'/role',{role:'viewer'},{tok:ad.token})).role,'viewer');
  assert.equal((await post('/api/admin/users/'+ad.user.id+'/role',{role:'viewer'},{tok:ad.token})).status,400,'cannot change own role');
  assert.equal((await post('/api/admin/users/'+ed.user.id+'/role',{role:'admin'},{tok:ad.token})).role,'admin');
  assert.equal((await post('/api/admin/users/'+ed.user.id+'/role',{role:'editor'},{tok:ok.token})).role,'editor')});
