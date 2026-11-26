'use strict';

if(!process.env.VERCEL&&!process.env.NESTVAULT_SERVERLESS)require('node:dns').setServers(['8.8.8.8']); // local DNS pin for Atlas lookups; not needed on serverless hosts

// NestVault server: plain Node.js REST API on MongoDB Atlas. No web framework.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
try{for(const l of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m&&!l.trim().startsWith('#')&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^["']|["']$/g,'')}}catch{}
const {MongoClient}=process.env.NESTVAULT_FAKE_DB?require('./test/fake-mongodb'):require('mongodb');
const E=process.env,PORT=E.PORT||3000,PUB=path.join(__dirname,'public'),PROD=E.NODE_ENV==='production',SERVERLESS=!!(E.VERCEL||E.NESTVAULT_SERVERLESS); // SERVERLESS: Vercel functions (no timers, no listen)
const rbac=require('./rbac'),bus=new (require('node:events'))();bus.setMaxListeners(0); // roles policy + in-process change bus for live updates
if(!E.MONGODB_URI){console.error('\nMissing MONGODB_URI. Copy .env.example to .env and paste your MongoDB Atlas connection string (see README).\n');process.exit(1)}
if(PROD&&!E.JWT_SECRET){console.error('JWT_SECRET is required when NODE_ENV=production');process.exit(1)}
let SECRET=E.JWT_SECRET;if(!SECRET){const f=path.join(__dirname,'.secret');if(!fs.existsSync(f))fs.writeFileSync(f,crypto.randomBytes(32).toString('hex'));SECRET=fs.readFileSync(f,'utf8')}
const QUOTA=(+E.QUOTA_MB||100)*1048576,MAXFILE=(+E.MAX_FILE_MB||25)*1048576,KEEPV=+E.VERSIONS_KEEP||20,INTEGRITY_H=+E.INTEGRITY_HOURS||6,RTO_T=+E.RTO_TARGET_MIN||5,RPO_T=+E.RPO_TARGET_MIN||5,ACCESS_TTL=15*60e3,REFRESH_TTL=30*864e5,CHUNK=512*1024,OVERHEAD=51/* 35-byte file header + 16-byte GCM tag added by the browser */,APP_URL=E.APP_URL||`http://localhost:${E.PORT||3000}`;

/* ---------- database (+ optional separate backup store) ---------- */
const MOPT={serverSelectionTimeoutMS:10000,retryWrites:true,retryReads:true,maxPoolSize:SERVERLESS?5:(+E.DB_POOL||20),maxIdleTimeMS:60000,readPreference:'primaryPreferred'}; // retryable writes/reads + primaryPreferred: keeps working while Atlas elects a new primary
const client=new MongoClient(E.MONGODB_URI,MOPT);
const client2=E.BACKUP_MONGODB_URI?new MongoClient(E.BACKUP_MONGODB_URI,MOPT):null;
let D,BD;const C=n=>D.collection(n),B=n=>BD.collection(n);
async function initDb(){
  await client.connect();D=client.db(E.DB_NAME||'nestvault');if(client2){await client2.connect();BD=client2.db(E.BACKUP_DB_NAME||'nestvault_backups')}else BD=D;
  const ix=(c,k,o)=>c.createIndex(k,o);
  await ix(C('users'),{email:1},{unique:true});await ix(C('records'),{user_id:1,seq:1});await ix(C('versions'),{record_id:1,version:1});await ix(C('vault'),{user_id:1,name:1});
  await ix(C('blobs'),{blob:1,n:1});await ix(C('events'),{user_id:1,ts:-1});await ix(C('conflicts'),{user_id:1,status:1});await ix(C('sessions'),{user_id:1});await ix(C('shares'),{with:1});
  await ix(C('ratelimit'),{exp:1},{expireAfterSeconds:0});await ix(C('uploads'),{user_id:1,state:1});await ix(C('tokens'),{expAt:1},{expireAfterSeconds:0});await ix(B('backups'),{user_id:1,ts:-1});await ix(B('bk_blobs'),{blob:1,n:1});
  await ix(C('records'),{user_id:1,deleted:1,seq:-1});await ix(C('health'),{exp:1},{expireAfterSeconds:0});await ix(C('users'),{role:1});
}
let readyP=null;const ready=()=>readyP||(readyP=initDb().catch(e=>{readyP=null;throw e})); // connect once per instance (also reused by warm serverless invocations)

/* ---------- helpers ---------- */
const nid=()=>crypto.randomBytes(8).toString('hex');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const bad=(s,m)=>Object.assign(new Error(m),{status:s});
const sign=o=>{const b=Buffer.from(JSON.stringify(o)).toString('base64url');return b+'.'+crypto.createHmac('sha256',SECRET).update(b).digest('base64url')};
const verify=t=>{const[b,s]=(t||'').split('.');if(!b||!s)return null;const e=crypto.createHmac('sha256',SECRET).update(b).digest('base64url');if(s.length!==e.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(e)))return null;try{const o=JSON.parse(Buffer.from(b,'base64url'));return o.exp>Date.now()?o:null}catch{return null}};
const hashPw=(pw,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+crypto.scryptSync(pw,salt,64).toString('hex');
const checkPw=(pw,h)=>{const[s,k]=h.split(':');return crypto.timingSafeEqual(Buffer.from(k,'hex'),crypto.scryptSync(pw,s,64))};
const ev=(u,kind,detail={})=>C('events').insertOne({_id:nid(),user_id:u,ts:Date.now(),kind,detail});
const alert=(u,msg)=>ev(u,'alert',{msg});
async function limit(key,max,win=300000){const now=Date.now(),d=await C('ratelimit').findOne({_id:key}),hits=((d&&d.hits)||[]).filter(t=>now-t<win);
  if(hits.length>=max)throw bad(429,'Too many attempts. Try again in a few minutes.');hits.push(now);await C('ratelimit').updateOne({_id:key},{$set:{hits,exp:new Date(now+win)}},{upsert:true})}
const pwOk=p=>p.length>=10&&/[A-Za-z]/.test(p)&&/\d/.test(p);
const dev=req=>{const ua=req.headers['user-agent']||'';return((ua.match(/Edg|Chrome|Firefox|Safari/)||['Browser'])[0].replace('Edg','Edge'))+' on '+((ua.match(/Windows|Android|iPhone|iPad|Mac OS X|Linux/)||['unknown OS'])[0])};
const touch=async(u,what)=>{const r=await C('users').updateOne({_id:u},{$set:{data_mod:Date.now(),[what+'_mod']:Date.now()}});bus.emit('u:'+u);return r}; // bus: instant push to this user's live (SSE) connections
async function withLock(u,key,ttl,fn,wait=0){const f='lock_'+key,end=Date.now()+wait; // per-user lock stored in MongoDB, so it works across server instances
  for(;;){const now=Date.now(),r=await C('users').updateOne({_id:u,$or:[{[f]:{$lt:now}},{[f]:{$exists:false}}]},{$set:{[f]:now+ttl}});
    if(r.matchedCount)break;if(Date.now()>=end)throw bad(409,key==='restore'?'Another restore is already running':'Server busy, please retry');await sleep(60)}
  try{return await fn()}finally{await C('users').updateOne({_id:u},{$set:{[f]:0}})}}
const guard=async u=>{const d=await C('users').findOne({_id:u});if(d&&(d.lock_restore||0)>Date.now())throw bad(423,'A restore is in progress. Try again in a moment.')};
async function mutate(owner,r,set){const res=await C('records').updateOne({_id:r._id,user_id:owner,version:r.version},{$set:{...set,version:r.version+1,updated:Date.now(),seq:await nextSeq(owner)}}); // ownership + version guard
  if(!res.matchedCount)throw bad(409,'The record changed meanwhile. Reload and try again.');await snap(owner,r._id);await touch(owner,'rec')}
const nextSeq=async(u,n=1)=>{const d=await C('users').findOneAndUpdate({_id:u},{$inc:{seq:n}},{returnDocument:'after'});return d.seq-n+1}; // per-user change counter -> incremental sync cursor
const bumpEpoch=u=>C('users').updateOne({_id:u},{$inc:{epoch:1}}); // tells clients to do a full resync
const PRI=['critical','high','normal','low'],STA=['open','in-progress','done'],FIELDS=['title','body','category','priority','status'];
const clean=f=>{const o={};if('title'in f)o.title=String(f.title).trim().slice(0,200)||'Untitled';if('body'in f)o.body=String(f.body).slice(0,5000);if('category'in f)o.category=String(f.category).trim().slice(0,40)||'general';if(PRI.includes(f.priority))o.priority=f.priority;if(STA.includes(f.status))o.status=f.status;return o};
const userOut=u=>({id:u._id||u.id,email:u.email,name:u.name,role:rbac.roleOf(u),phone:u.phone||'',org:u.org||''});
const issue=(uid,sid)=>sign({sub:uid,sid,exp:Date.now()+ACCESS_TTL});
async function newSession(u,req){const sid=nid(),rt=crypto.randomBytes(32).toString('base64url'),now=Date.now(),d=dev(req);
  await C('sessions').insertOne({_id:sid,user_id:u._id,rt:sha(rt),device:d,created:now,last:now,expires:now+REFRESH_TTL,revoked:0});await ev(u._id,'login',{device:d});
  return{token:issue(u._id,sid),refresh:sid+'.'+rt,user:userOut(u)}}
const pick=r=>Object.fromEntries(FIELDS.map(k=>[k,r[k]]));
const snap=async(u,id)=>{const r=await C('records').findOne({_id:id});await C('versions').insertOne({_id:nid(),record_id:id,user_id:u,version:r.version,snapshot:pick(r),ts:Date.now()});
  const old=await C('versions').find({record_id:id,user_id:u}).sort({version:-1}).skip(KEEPV).project({_id:1}).toArray(); // retention: newest N versions per record
  if(old.length)await C('versions').deleteMany({_id:{$in:old.map(x=>x._id)}})};
const sum=async(u,kind,f)=>{const a=await C('events').aggregate([{$match:{user_id:u,kind}},{$group:{_id:null,s:{$sum:'$detail.'+f}}}]).toArray();return a[0]?a[0].s:0};
const pool=async(items,n,fn)=>{let i=0,out=[];await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const k=i++;out[k]=await fn(items[k])}}));return out}; // controlled parallelism

/* ---------- blob storage: chunked, outside the 16 MB document limit (swap these functions for S3 in production) ---------- */
const putChunk=(col,u,blob,n,buf,state)=>col.updateOne({_id:blob+':'+n},{$set:{user_id:u,blob,n,len:buf.length,data:buf.toString('base64'),state,ts:Date.now()}},{upsert:true});
const chunks=(col,u,blob)=>col.find({user_id:u,blob}).sort({n:1}).toArray();
async function readBlob(col,u,blob){return Buffer.concat((await chunks(col,u,blob)).map(c=>Buffer.from(c.data,'base64')))}
async function writeBlob(col,u,blob,buf,state='ok'){let n=0;for(let i=0;i<buf.length||n===0;i+=CHUNK,n++)await putChunk(col,u,blob,n,buf.subarray(i,i+CHUNK),state);return n}
async function copyBlob(src,dst,u,sb,db){for(const c of await chunks(src,u,sb))await dst.updateOne({_id:db+':'+c.n},{$set:{user_id:u,blob:db,n:c.n,len:c.len,data:c.data,state:'ok',ts:Date.now()}},{upsert:true})}
const hasBlob=async(col,u,blob)=>!!await col.findOne({_id:blob+':0',user_id:u});
const delBlob=(col,u,blob)=>col.deleteMany({user_id:u,blob});
const blobSha=async(col,u,blob)=>{const h=crypto.createHash('sha256');for(const c of await chunks(col,u,blob))h.update(Buffer.from(c.data,'base64'));return h.digest('hex')};
async function blobCheck(col,u,blob,n,chash){const cs=await chunks(col,u,blob); // null = fine, otherwise the reason
  if(!cs.length)return'blob is missing';if(cs.some((c,i)=>c.n!==i))return'chunks are missing';if(n&&cs.length!==n)return`expected ${n} chunks, found ${cs.length}`;
  if(chash){const h=crypto.createHash('sha256');for(const c of cs)h.update(Buffer.from(c.data,'base64'));if(h.digest('hex')!==chash)return'checksum mismatch'}return null}
const usage=async u=>{const a=async c=>{const r=await c.aggregate([{$match:{user_id:u}},{$group:{_id:null,s:{$sum:'$len'}}}]).toArray();return r[0]?r[0].s:0};return(await a(C('blobs')))+(await a(B('bk_blobs')))};

/* ---------- sync: server-authoritative field-level 3-way merge (no device clocks) ---------- */
async function applyChange(u,c,depth=0){
  if(!c||!c.id)return 0;const id=String(c.id).slice(0,40),f=clean(c.fields||{}),now=Date.now();
  const r=await C('records').findOne({_id:id});if(r&&r.user_id!==u)return 0;
  if(!r){if(c.deleted)return 0;const x={title:'Untitled',body:'',category:'general',priority:'normal',status:'open',...f};
    try{await C('records').insertOne({_id:id,user_id:u,...x,version:1,updated:now,seq:await nextSeq(u),deleted:0})}catch(e){if(e.code===11000&&depth<3)return applyChange(u,c,depth+1);throw e}
    await snap(u,id);await touch(u,'rec');return 0}
  const cb=Math.min(Math.max(+c.base||0,0),r.version);let base=pick(r);
  if(cb<r.version){const v=await C('versions').findOne({record_id:id,user_id:u,version:cb});base=v?v.snapshot:null}
  const upd={},conf=[];
  for(const k of Object.keys(f)){if(f[k]===r[k])continue;if(base&&f[k]===base[k])continue;
    const serverChanged=cb<r.version&&(!base||base[k]!==r[k]);
    if(serverChanged)conf.push({field:k,base:base?base[k]:null,server:r[k],client:f[k]});else upd[k]=f[k]}
  for(const x of conf)await C('conflicts').insertOne({_id:nid(),user_id:u,record_id:id,title:r.title,...x,status:'open',ts:now});
  if(conf.length)await ev(u,'conflict',{record:id,title:r.title,fields:Object.fromEntries(conf.map(x=>[x.field,x]))});
  const del=c.deleted&&!r.deleted,keys=Object.keys(upd);if(!keys.length&&!del)return conf.length;
  const res=await C('records').updateOne({_id:id,user_id:u,version:r.version},{$set:{...upd,version:r.version+1,updated:now,seq:await nextSeq(u),deleted:del?1:r.deleted,...(del?{deleted_at:now}:{})}});
  if(!res.matchedCount){if(depth<3)return conf.length+await applyChange(u,c,depth+1);throw bad(409,'Concurrent update, please sync again')}
  await snap(u,id);await touch(u,'rec');if(del)await ev(u,'delete',{title:r.title});return conf.length;
}
const recOut=r=>({id:r._id,...pick(r),version:r.version,updated:r.updated,deleted:r.deleted,seq:r.seq});
async function recPage(u,since,cats,limit=200){const a=await C('records').find({user_id:u,seq:{$gt:since},...(cats.length?{category:{$in:cats}}:{})}).sort({seq:1}).limit(limit+1).toArray(),more=a.length>limit,page=a.slice(0,limit);
  return{records:page.map(recOut),more,cursor:page.length?page[page.length-1].seq:since}}
const recAll=async u=>(await C('records').find({user_id:u}).sort({seq:1}).toArray()).map(recOut);
const openConf=async u=>(await C('conflicts').find({user_id:u,status:'open'}).sort({ts:-1}).toArray()).map(x=>({id:x._id,record:x.record_id,title:x.title,field:x.field,base:x.base,server:x.server,client:x.client,ts:x.ts}));

/* ---------- backups: metadata in a collection, data in chunked blobs, optionally on a separate cluster ---------- */
async function makeBackup(u,kind,label){
  const ud=await C('users').findOne({_id:u}),recs=await C('records').find({user_id:u,deleted:0}).toArray(),vf=(await C('vault').find({user_id:u,deleted:0}).toArray()).map(({_id,name,folder,tags,version,phash,chash,size,stored,ts,blob,chunks})=>({_id,name,folder,tags,version,phash,chash,size,stored,ts,blob,chunks}));
  for(const v of vf)if(!await hasBlob(B('bk_blobs'),u,v.blob))await copyBlob(C('blobs'),B('bk_blobs'),u,v.blob,v.blob); // vault files are copied into the backup store once and shared between snapshots
  const gz=zlib.gzipSync(JSON.stringify({recs,vf})),id=nid(),pb='bk'+nid(),pc=await writeBlob(B('bk_blobs'),u,pb,gz);
  await B('backups').insertOne({_id:id,user_id:u,label,kind,ts:Date.now(),count:recs.length+vf.length,size:gz.length,checksum:sha(gz),payload_blob:pb,pchunks:pc,vref:vf.map(v=>v.blob),covers:ud.data_mod||0,covers_rec:ud.rec_mod||0,covers_vault:ud.vault_mod||0});
  await prune(u);await ev(u,'backup',{type:kind,items:recs.length+vf.length,bytes:gz.length});return id}
async function readBackup(b){const gz=await readBlob(B('bk_blobs'),b.user_id,b.payload_blob);if(sha(gz)!==b.checksum)return null;try{return JSON.parse(zlib.gunzipSync(gz))}catch{return null}}
async function prune(u){ // retention: all backups for 24 h, then 1/day for 7 days, then 1/week up to 5 weeks; last 10 manual; pre-restore copies 14 days
  const all=await B('backups').find({user_id:u}).project({payload_blob:0,vref:0}).sort({ts:-1}).toArray(),now=Date.now(),keep=new Set(),sd=new Set(),sw=new Set();let man=0;
  for(const b of all){const age=now-b.ts;
    if(b.kind==='pre-restore'){if(age<14*864e5)keep.add(b._id);continue}if(b.kind==='manual'){if(man++<10)keep.add(b._id);continue}
    if(age<864e5)keep.add(b._id);else if(age<7*864e5){const k=Math.floor(b.ts/864e5);if(!sd.has(k)){sd.add(k);keep.add(b._id)}}else if(age<35*864e5){const k=Math.floor(b.ts/6048e5);if(!sw.has(k)){sw.add(k);keep.add(b._id)}}}
  if(all[0])keep.add(all[0]._id);const del=all.filter(b=>!keep.has(b._id));
  if(del.length){await B('backups').deleteMany({_id:{$in:del.map(x=>x._id)}});await gcBackupBlobs(u)}}
async function gcBackupBlobs(u){const refs=new Set();for(const b of await B('backups').find({user_id:u}).project({payload_blob:1,vref:1}).toArray()){refs.add(b.payload_blob);(b.vref||[]).forEach(x=>refs.add(x))}
  for(const c of await B('bk_blobs').find({user_id:u,n:0}).project({blob:1}).toArray())if(!refs.has(c.blob))await delBlob(B('bk_blobs'),u,c.blob)}
const lastBackup=async u=>(await B('backups').find({user_id:u}).project({vref:0}).sort({ts:-1}).limit(1).toArray())[0];
async function backupStatus(ud){const l=await lastBackup(ud._id);return{last:l?l.ts:0,records:!!l&&(ud.rec_mod||0)<=l.covers_rec,vault:!!l&&(ud.vault_mod||0)<=l.covers_vault,protected:!!l&&(ud.data_mod||0)<=l.covers}}
const recovery=(u,o)=>C('recoveries').insertOne({_id:nid(),user_id:u,ts:Date.now(),...o});
async function drill(u,b,type='drill'){const t0=Date.now(),d=await readBackup(b);let ok=!!d&&d.recs.every(r=>r._id&&typeof r.title==='string');
  if(d)for(const v of d.vf)if(await blobCheck(B('bk_blobs'),u,v.blob,v.chunks,v.chash)){ok=false;break}
  const ud=await C('users').findOne({_id:u}),r={ok,ms:Date.now()-t0,items:d?d.recs.length+d.vf.length:0,bytes:b.size,rpoMs:Math.max(0,(ud.data_mod||0)-b.ts)};
  await recovery(u,{type,ms:r.ms,rpoMs:r.rpoMs,items:r.items,ok,label:b.label});await ev(u,'verify',{what:(type==='drill'?'Recovery drill':'Scheduled drill')+' on "'+b.label+'"',ok});if(!ok)await alert(u,'Recovery drill FAILED for backup "'+b.label+'"');return r}
async function auditBackups(u){const seen=new Map(),bad=[];let nb=0; // every retained backup: payload present, chunk counts, checksum, and every referenced vault blob
  for(const b of await B('backups').find({user_id:u}).toArray()){nb++;
    const pr=await blobCheck(B('bk_blobs'),u,b.payload_blob,b.pchunks,null);if(pr){bad.push(`backup "${b.label}" data: ${pr}`);continue}
    const d=await readBackup(b);if(!d){bad.push(`backup "${b.label}": checksum mismatch`);continue}
    for(const v of d.vf){let r=seen.get(v.blob);if(r===undefined){r=await blobCheck(B('bk_blobs'),u,v.blob,v.chunks,v.chash);seen.set(v.blob,r)}if(r)bad.push(`backup "${b.label}", file "${v.name}": ${r}`)}}
  return{backups:nb,blobs:seen.size,bad}}
async function integrity(u){const bad=[];let checked=0;
  for(const v of await C('vault').find({user_id:u,deleted:0}).toArray()){checked++;const r=await blobCheck(C('blobs'),u,v.blob,v.chunks,v.chash);if(r)bad.push(`vault file "${v.name}": ${r}`)}
  const a=await auditBackups(u);checked+=a.backups+a.blobs;bad.push(...a.bad);const ok=!bad.length;
  await C('users').updateOne({_id:u},{$set:{integrity:{ts:Date.now(),ok,checked,backups:a.backups,blobs:a.blobs,bad:bad.slice(0,20)}}});await ev(u,'verify',{what:`Integrity and backup reference audit (${a.backups} backups, ${a.blobs} referenced files)`,ok});if(!ok)await alert(u,'Integrity audit failed: '+bad.slice(0,3).join('; '));}
let ticking=false;
async function tick(){if(ticking)return 0;ticking=true;let n=0;try{const now=Date.now(); // scheduled work: backups, integrity audits, drills. Called every minute by the timer, or by /api/cron/tick on serverless hosts
  await C('blobs').deleteMany({state:'pending',ts:{$lt:now-864e5}});await C('uploads').deleteMany({state:'open',ts:{$lt:now-864e5}}); // abandoned uploads (kept 24 h so they can be resumed)
  for(const x of await C('users').find({}).toArray()){n++;try{
    const l=await lastBackup(x._id),last=l?l.ts:0,dirty=(x.data_mod||0)>(l?l.covers:-1);
    if(x.autobackup>0&&dirty&&now-last>x.autobackup*60000){try{await makeBackup(x._id,'auto','Scheduled backup')}catch(e){await alert(x._id,'Scheduled backup failed: '+e.message)}}
    else if(x.autobackup>0&&dirty&&now-last>3*x.autobackup*60000&&now-(x.overdue||0)>36e5){await C('users').updateOne({_id:x._id},{$set:{overdue:now}});await alert(x._id,'Backups are overdue: changes have been unprotected for '+Math.round((now-last)/60000)+' minutes')}
    if(now-((x.integrity||{}).ts||0)>INTEGRITY_H*36e5)await integrity(x._id);
    if(x.drill>0&&l&&now-(x.last_drill||0)>x.drill*36e5){await C('users').updateOne({_id:x._id},{$set:{last_drill:now}});await drill(x._id,l,'scheduled-drill')}
  }catch(e){console.error('scheduler',x._id,e.message)}}}catch(e){console.error('scheduler:',e.message)}finally{ticking=false}return n}
if(!SERVERLESS)setInterval(tick,60000);

/* ---------- metrics ---------- */
const M={start:Date.now(),n:0,err:0,lat:[],by:{}};
const rec=(st,ms)=>{M.n++;if(st>=500)M.err++;M.by[st]=(M.by[st]||0)+1;M.lat.push(ms);if(M.lat.length>500)M.lat.shift()};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- routes ---------- */
const routes=[];const R=(m,p,fn,auth=true)=>routes.push({m,auth,fn,re:new RegExp('^'+p.replace(/:(\w+)/g,'(?<$1>[^/]+)')+'$')});
const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const newUser=(email,name,pw,role)=>({_id:nid(),email,name,role:role||rbac.DEFAULT_ROLE,pw:hashPw(pw),autobackup:5,drill:0,created:Date.now(),data_mod:0,rec_mod:0,vault_mod:0,seq:0,epoch:0,verified:0,lock_restore:0,lock_quota:0});
/* ---------- sign-up: role chosen by the person, protected by a per-role access password ---------- */
const ROLE_CODE={admin:()=>E.ADMIN_CODE||'',editor:()=>E.EDITOR_CODE||''}; // set in .env / hosting dashboard; viewer needs none
const codeOk=(given,real)=>{if(!real)return false;const h=v=>crypto.createHash('sha256').update(String(v||'')).digest();return crypto.timingSafeEqual(h(given),h(real))};
const phoneRe=/^\+?[0-9][0-9 \-]{6,14}$/;
const approvedAdmins=async()=>(await C('users').find({role:'admin'}).toArray()).filter(x=>!x.pending); // administrators who may sign in
const PENDING_MSG='Your administrator account is waiting for approval by another administrator. You can sign in after it is approved.';
function profile(b){const email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim().replace(/\s+/g,' ').slice(0,60),phone=String(b.phone||'').trim(),org=String(b.org||'').trim().replace(/\s+/g,' ').slice(0,80);
  if(name.length<2)throw bad(400,'Enter your full name');if(!emailRe.test(email))throw bad(400,'Enter a valid email address');if(!phoneRe.test(phone))throw bad(400,'Enter a valid mobile number (7-15 digits)');
  if(org.length<2)throw bad(400,'Enter your organisation, health centre or village');return{email,name,phone,org}}
R('GET','/api/signup-options',async()=>({admin:!!E.ADMIN_CODE,editor:!!E.EDITOR_CODE,viewer:true}),false); // which roles can be chosen on the sign-up form
R('POST','/api/signup',async({b,ip,req})=>{await limit('su:'+ip,10);const p=profile(b),role=String(b.role||''),pw=String(b.password||'');
  if(!rbac.ROLES.includes(role))throw bad(400,'Choose a role');
  if(!pwOk(pw))throw bad(400,'Password needs 10+ characters with letters and numbers');if(pw!==String(b.confirm||''))throw bad(400,'The two passwords do not match');
  if(role!=='viewer'){await limit('sc:'+ip,6); // brute-force guard on the access passwords
    const real=ROLE_CODE[role]();if(!real)throw bad(403,`${role==='admin'?'Administrator':'Editor'} sign-up is not enabled on this server`);
    if(!codeOk(b.code,real))throw bad(403,`Wrong ${role} access password`)}
  const u=newUser(p.email,p.name,pw,role);u.phone=p.phone;u.org=p.org;
  if(role==='admin'&&(await approvedAdmins()).length)u.pending=1; // the very first administrator is approved automatically; every later one needs another administrator's approval
  try{await C('users').insertOne(u)}catch(e){if(e.code===11000)throw bad(409,'Email already registered');throw e}
  const mailP=mkToken(u._id,'verify',864e5).then(t=>sendMail(p.email,'Verify your NestVault email',`Open this link to verify your email:\n${APP_URL}/#verify=${t}`)).catch(mailLog);if(SERVERLESS)await Promise.race([mailP,sleep(8000)]);
  if(u.pending){for(const a of await approvedAdmins())await alert(a._id,`${u.name} (${u.email}) registered as an administrator and is waiting for approval. Open Administration to approve or reject.`);return{pending:true,message:PENDING_MSG}}
  return newSession(u,req)},false);
R('POST','/api/login',async({b,ip,req})=>{const email=String(b.email||'').trim().toLowerCase();await limit('ip:'+ip,40);await limit('em:'+email,8);
  const u=await C('users').findOne({email});if(!u||!checkPw(String(b.password||''),u.pw))throw bad(401,'Invalid email or password');
  if(u.disabled)throw bad(403,'This account has been disabled by an administrator');if(u.pending)throw bad(403,PENDING_MSG);
  return newSession(u,req)},false);
R('POST','/api/refresh',async({b})=>{const[sid,rt]=String(b.refresh||'').split('.'),s=sid&&await C('sessions').findOne({_id:sid});
  if(!s||s.revoked||s.expires<Date.now()||sha(rt||'')!==s.rt)throw bad(401,'Session expired - please sign in again');const u=await C('users').findOne({_id:s.user_id});if(!u||u.disabled||u.pending)throw bad(401,'Session expired');
  const nrt=crypto.randomBytes(32).toString('base64url');await C('sessions').updateOne({_id:sid},{$set:{rt:sha(nrt),last:Date.now()}});
  return{token:issue(u._id,sid),refresh:sid+'.'+nrt,user:userOut(u)}},false);
//async function sendMail(to,subject,text){if(E.MAIL_WEBHOOK_URL){try{await fetch(E.MAIL_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json',...(E.MAIL_WEBHOOK_AUTH?{Authorization:E.MAIL_WEBHOOK_AUTH}:{})},body:JSON.stringify({to,subject,text})})}catch(e){console.error('mail webhook failed:',e.message)}}else console.log(`[mail] to=${to} subject="${subject}"\n${text}`)} // no webhook configured: the message is printed in the server console
const mailer=require('./mailer'),MAIL=mailer.config(E);
const sendMail=(to,subject,text)=>mailer.send(MAIL,to,subject,text);
const mailLog=e=>console.error('[mail] sending failed:',e.message);
R('GET','/api/config',()=>({mail:MAIL.mode!=='console'}),false);

async function mkToken(u,kind,ttl){const t=crypto.randomBytes(24).toString('base64url');await C('tokens').insertOne({_id:sha(t),user_id:u,kind,exp:Date.now()+ttl,expAt:new Date(Date.now()+ttl),used:0});return t}
async function useToken(t,kind){const d=await C('tokens').findOne({_id:sha(String(t||''))}),msg='This link is invalid or has expired';if(!d||d.kind!==kind||d.used||d.exp<Date.now())throw bad(400,msg);
  const r=await C('tokens').updateOne({_id:d._id,used:0},{$set:{used:1}});if(!r.matchedCount)throw bad(400,msg);return d.user_id} // single use
R('POST','/api/password/forgot',async({b,ip})=>{await limit('fp:'+ip,8);const email=String(b.email||'').trim().toLowerCase();await limit('fpe:'+email,3);
  const u=emailRe.test(email)&&await C('users').findOne({email});if(u){const t=await mkToken(u._id,'reset',36e5);await sendMail(u.email,'Reset your NestVault password',`Open this link within one hour to choose a new password:\n${APP_URL}/#reset=${t}\nIf you did not ask for this, ignore this message.`)}
  return{ok:true}},false); // same answer whether or not the email exists
R('POST','/api/password/reset',async({b})=>{const pw=String(b.password||'');if(!pwOk(pw))throw bad(400,'Password needs 10+ characters with letters and numbers');const uid=await useToken(b.token,'reset');
  await C('users').updateOne({_id:uid},{$set:{pw:hashPw(pw)}});await C('sessions').updateMany({user_id:uid,revoked:0},{$set:{revoked:1}});await ev(uid,'session',{msg:'Password reset by email link; all devices signed out'});return{ok:true}},false);
R('POST','/api/email/send-verification',async({u})=>{await limit('ev:'+u.id,4);if(u.verified)return{ok:true,already:true};const t=await mkToken(u.id,'verify',864e5);try{await sendMail(u.email,'Verify your NestVault email',`Open this link to verify your email:\n${APP_URL}/#verify=${t}`)}catch(e){mailLog(e);throw bad(502,'The email could not be sent: '+e.message)}return{ok:true,mail:MAIL.mode!=='console'}});

R('POST','/api/email/verify',async({b})=>{const uid=await useToken(b.token,'verify');await C('users').updateOne({_id:uid},{$set:{verified:1}});await ev(uid,'session',{msg:'Email address verified'});return{ok:true}},false);
R('POST','/api/logout',async({u})=>{await C('sessions').updateOne({_id:u.sid},{$set:{revoked:1}});await ev(u.id,'logout',{});return{ok:true}});
R('GET','/api/me',({u})=>({verified:!!u.verified,role:u.role,user:userOut(u),autobackup:u.autobackup,drill:u.drill||0,integrity:u.integrity||null}));
R('POST','/api/settings',async({u,b})=>{const set={};if('autobackup'in b)set.autobackup=[0,1,5,15,60,1440,10080,43200].includes(+b.autobackup)?+b.autobackup:5;if('drill'in b)set.drill=[0,24,168].includes(+b.drill)?+b.drill:0;
  await C('users').updateOne({_id:u.id},{$set:set});return set});

R('GET','/api/account',async({u})=>({user:userOut(u),autobackup:u.autobackup,quota:{used:await usage(u.id),limit:QUOTA,maxFile:MAXFILE}}));
R('GET','/api/sessions',async({u})=>(await C('sessions').find({user_id:u.id,revoked:0}).sort({last:-1}).toArray()).filter(s=>s.expires>Date.now()).map(s=>({id:s._id,device:s.device,created:s.created,last:s.last,current:s._id===u.sid})));
R('DELETE','/api/sessions/:id',async({u,p})=>{await C('sessions').updateOne({_id:p.id,user_id:u.id},{$set:{revoked:1}});await ev(u.id,'session',{msg:'Device signed out'});return{ok:true}});
R('POST','/api/sessions/revoke-others',async({u})=>{await C('sessions').updateMany({user_id:u.id,revoked:0,_id:{$ne:u.sid}},{$set:{revoked:1}});await ev(u.id,'session',{msg:'Signed out of all other devices'});return{ok:true}});
R('POST','/api/password',async({u,b})=>{await limit('pw:'+u.id,8);if(!checkPw(String(b.current||''),u.pw))throw bad(401,'Current password is wrong');if(!pwOk(String(b.password||'')))throw bad(400,'New password needs 10+ characters with letters and numbers');
  await C('users').updateOne({_id:u.id},{$set:{pw:hashPw(b.password)}});await C('sessions').updateMany({user_id:u.id,revoked:0,_id:{$ne:u.sid}},{$set:{revoked:1}});await ev(u.id,'session',{msg:'Password changed; other devices signed out'});return{ok:true}});
R('GET','/api/audit',async({u})=>(await C('events').find({user_id:u.id}).sort({ts:-1}).limit(100).toArray()).map(e=>({...e.detail,ts:e.ts,kind:e.kind})));
const vOut=f=>({id:f._id,name:f.name,folder:f.folder||'',tags:f.tags||'',version:f.version,phash:f.phash,chash:f.chash,size:f.size,ts:f.ts});
R('GET','/api/export',async({u})=>{await ev(u.id,'export',{});return{exported:new Date().toISOString(),records:(await recAll(u.id)).filter(r=>!r.deleted),vault:(await C('vault').find({user_id:u.id,deleted:0}).toArray()).map(vOut)}});


/* ---------- AI: summarise one NestVault record ---------- */
R('POST','/api/ai/summarise',async({u,b})=>{
  if(!E.GEMINI_API_KEY)
    throw bad(503,'AI is not configured on this server');

  // Maximum 10 requests per 5 minutes per user
  await limit('ai:'+u.id,10);

  // Only access the signed-in user's own active record
  const r=await C('records').findOne({
    _id:String(b.id||''),
    //user_id:u.id,
    deleted:0
  });

  if(!r)
    throw bad(404,'Record not found (sync it first)');

  if(!r.version)
    throw bad(409,'Record is not synced yet');

  // Send only the record's text and relevant fields
  const text=`Title: ${r.title}
Category: ${r.category}
Priority: ${r.priority}
Status: ${r.status}
Details: ${r.body}`.slice(0,6000);

  
const model=E.AI_MODEL||'gemini-3.8-flash';

const res=await fetch(
  'https://generativelanguage.googleapis.com/v1beta/interactions',
  {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-goog-api-key':E.GEMINI_API_KEY
    },
    body:JSON.stringify({
      model,
      store:false,
      input:`Summarise this record in 2 to 3 simple sentences. Use only the facts provided. Do not invent details.

${text}`
    })
  }
);

if(!res.ok){
  const errorText=await res.text();
  console.error('[Gemini API Error]',res.status,errorText);
  throw bad(502,'Gemini request failed. Check server logs.');
}

const j=await res.json();

const summary=(j.steps||[])
  .filter(s=>s.type==='model_output')
  .flatMap(s=>s.content||[])
  .filter(c=>c.type==='text')
  .map(c=>c.text||'')
  .join('')
  .trim();

if(!summary)
  throw bad(502,'Gemini returned no summary');

await ev(u.id,'ai',{what:r.title});

return {summary};
});




/* sync: incremental (cursor), paginated, controlled parallelism */
R('POST','/api/sync',async({u,b,sent,rawLen,req})=>{if(u.role==='viewer'&&Array.isArray(b.changes)&&b.changes.length)throw bad(403,'Your account has the Viewer role and is read-only');await guard(u.id);
  const changes=Array.isArray(b.changes)?b.changes.slice(0,500):[],cats=Array.isArray(b.cats)?b.cats.map(String).slice(0,50):[],ud=await C('users').findOne({_id:u.id}),epoch=ud.epoch||0;
  const conflicts=(await pool(changes,5,c=>applyChange(u.id,c))).reduce((a,x)=>a+x,0);
  const naive=Math.max(+req.headers['x-naive']||0,rawLen),saved=Math.max(0,naive-sent);
  if(changes.length)await ev(u.id,'sync',{changes:changes.length,edits:+req.headers['x-edits']||changes.length,naive,sent,saved,conflicts});
  const reset=b.epoch!==epoch||!(+b.since>0),pg=await recPage(u.id,reset?0:+b.since,cats);
  const alerts=(await C('events').find({user_id:u.id,kind:'alert',ts:{$gt:+b.alertSince||0}}).sort({ts:1}).limit(10).toArray()).map(e=>({ts:e.ts,msg:e.detail.msg}));
  return{...pg,full:reset,epoch,acks:changes.map(c=>({id:c.id,rev:c.rev})),conflicts,openConflicts:await openConf(u.id),alerts,sent,saved}});
R('POST','/api/conflicts/:id/resolve',async({u,p,b})=>{await guard(u.id);const cf=await C('conflicts').findOne({_id:p.id,user_id:u.id,status:'open'});if(!cf)throw bad(404,'Conflict not found');
  const choice=b.choice==='mine'?'mine':'server';
  if(choice==='mine'){const r=await C('records').findOne({_id:cf.record_id,user_id:u.id});if(r&&FIELDS.includes(cf.field))await mutate(u.id,r,{[cf.field]:cf.client})}
  await C('conflicts').updateOne({_id:p.id,user_id:u.id},{$set:{status:'resolved',choice,resolved:Date.now()}});await ev(u.id,'resolve',{title:cf.title,field:cf.field,choice});return{openConflicts:await openConf(u.id)}});

/* history, recycle bin */
R('GET','/api/records/:id/versions',async({u,p})=>{if(!await C('records').findOne({_id:p.id,user_id:u.id}))throw bad(404,'Not found');
  return(await C('versions').find({record_id:p.id,user_id:u.id}).sort({version:-1}).toArray()).map(v=>({version:v.version,ts:v.ts,...v.snapshot}))});
R('POST','/api/records/:id/restore',async({u,p,b})=>{await guard(u.id);const r=await C('records').findOne({_id:p.id,user_id:u.id}),v=await C('versions').findOne({record_id:p.id,user_id:u.id,version:+b.version});if(!r||!v)throw bad(404,'Version not found');
  await mutate(u.id,r,{...v.snapshot,deleted:0});await ev(u.id,'restore',{what:'record version of "'+v.snapshot.title+'"'});return{ok:true}});
R('GET','/api/trash',async({u})=>({records:(await C('records').find({user_id:u.id,deleted:1}).sort({deleted_at:-1}).toArray()).map(r=>({id:r._id,title:r.title,category:r.category,at:r.deleted_at||r.updated})),vault:(await C('vault').find({user_id:u.id,deleted:1}).toArray()).map(vOut)}));
R('POST','/api/records/:id/undelete',async({u,p})=>{await guard(u.id);const r=await C('records').findOne({_id:p.id,user_id:u.id,deleted:1});if(!r)throw bad(404,'Not found');
  await mutate(u.id,r,{deleted:0});await ev(u.id,'restore',{what:'deleted record "'+r.title+'"'});return{ok:true}});
R('DELETE','/api/records/:id/purge',async({u,p})=>{await guard(u.id);const r=await C('records').findOne({_id:p.id,user_id:u.id,deleted:1});if(!r)throw bad(404,'Not found');
  await C('records').deleteOne({_id:p.id,user_id:u.id});await C('versions').deleteMany({record_id:p.id,user_id:u.id});await C('shares').deleteMany({record_id:p.id,owner:u.id});await touch(u.id,'rec');await ev(u.id,'purge',{what:r.title});return{ok:true}});

/* sharing (online only): view or edit access to single records */
R('POST','/api/records/:id/share',async({u,p,b})=>{const r=await C('records').findOne({_id:p.id,user_id:u.id,deleted:0});if(!r)throw bad(404,'Record not found (sync it first)');
  const o=await C('users').findOne({email:String(b.email||'').trim().toLowerCase()});if(!o)throw bad(404,'No NestVault user with that email');if(o._id===u.id)throw bad(400,'That is you');
  const perm=b.perm==='edit'?'edit':'view',ex=await C('shares').findOne({record_id:p.id,with:o._id});
  if(ex)await C('shares').updateOne({_id:ex._id},{$set:{perm}});else await C('shares').insertOne({_id:nid(),record_id:p.id,owner:u.id,with:o._id,email:o.email,perm,ts:Date.now()});
  await ev(u.id,'share',{what:r.title,with:o.email,perm});return{ok:true}});
R('GET','/api/records/:id/shares',async({u,p})=>(await C('shares').find({record_id:p.id,owner:u.id}).toArray()).map(s=>({id:s._id,email:s.email,perm:s.perm})));
R('DELETE','/api/shares/:id',async({u,p})=>{const s=await C('shares').findOne({_id:p.id});if(s&&(s.owner===u.id||s.with===u.id))await C('shares').deleteOne({_id:p.id});return{ok:true}});
R('GET','/api/shared',async({u})=>{const out=[];for(const s of await C('shares').find({with:u.id}).toArray()){const r=await C('records').findOne({_id:s.record_id,deleted:0});if(!r)continue;const o=await C('users').findOne({_id:s.owner});out.push({shareId:s._id,perm:s.perm,owner:o?o.name:'',...recOut(r)})}return out});
R('POST','/api/shared/:id/edit',async({u,p,b})=>{const s=await C('shares').findOne({_id:p.id,with:u.id});if(!s||s.perm!=='edit')throw bad(403,'You only have view access');await guard(s.owner);
  const r=await C('records').findOne({_id:s.record_id,user_id:s.owner,deleted:0});if(!r)throw bad(404,'Record no longer exists');const f=clean(b.fields||{}),set={};for(const k of Object.keys(f))if(f[k]!==r[k])set[k]=f[k];if(!Object.keys(set).length)return{ok:true};
  await mutate(s.owner,r,set);await ev(r.user_id,'share-edit',{what:r.title,by:u.name});return{ok:true}});
/* shared read-only records: visible to all signed-in users */
R('GET','/api/shared-records',async({u})=>{
  const records=await C('records')
    .find({deleted:0})
    .sort({updated:-1})
    .limit(1000)
    .toArray();

  return records.map(r=>({
    ...recOut(r),
    ownerId:r.user_id
  }));
});
/* vault: chunked upload with a server-side upload session (check -> start -> chunks -> complete) */
R('POST','/api/vault/check',async({u,b})=>{const phash=String(b.phash||''),size=+b.size||0;if(!/^[0-9a-f]{64}$/.test(phash)||size<0)throw bad(400,'Invalid upload');
  if(size>MAXFILE)throw bad(413,'File too large (max '+Math.round(MAXFILE/1048576)+' MB)');
  const dup=await C('vault').findOne({user_id:u.id,phash,deleted:0});if(dup){await ev(u.id,'dedup',{name:String(b.name||dup.name),same:dup.name,saved:size});return{dedup:true,of:dup.name,saved:size}}
  return{dedup:false,chunk:CHUNK,overhead:OVERHEAD}});
const openReserved=async u=>{const r=await C('uploads').aggregate([{$match:{user_id:u,state:'open'}},{$group:{_id:null,s:{$sum:'$total'}}}]).toArray();return r[0]?r[0].s:0};
R('POST','/api/vault/upload/start',async({u,b})=>{await guard(u.id);const phash=String(b.phash||''),size=+b.size,total=+b.total,chunks=+b.chunks;
  if(!/^[0-9a-f]{64}$/.test(phash)||!Number.isInteger(size)||size<0||size>MAXFILE)throw bad(400,'Invalid upload');
  if(!Number.isInteger(total)||total!==size+OVERHEAD||!Number.isInteger(chunks)||chunks!==Math.ceil(total/CHUNK))throw bad(400,'Declared sizes do not match');
  return withLock(u.id,'quota',10000,async()=>{ // quota check + reservation happen under one lock, so parallel uploads cannot slip past the limit
    if(await usage(u.id)+await openReserved(u.id)+total>QUOTA)throw bad(413,'Storage quota exceeded - delete files or old backups');
    const id=nid();await C('uploads').insertOne({_id:id,user_id:u.id,phash,size,total,chunks,state:'open',ts:Date.now()});return{uploadId:id,chunk:CHUNK}},4000)});
const getUp=async(u,id)=>{const s=/^[0-9a-f]{16}$/.test(id)&&await C('uploads').findOne({_id:id,user_id:u.id});if(!s)throw bad(404,'Unknown upload session');return s};
R('GET','/api/vault/upload/:id',async({u,p})=>{const s=await getUp(u,p.id);return{state:s.state,chunks:s.chunks,total:s.total,received:(await C('blobs').find({user_id:u.id,blob:'v'+p.id}).project({n:1}).toArray()).map(c=>c.n)}});
R('PUT','/api/vault/upload/:id/:n',async({u,p,b})=>{const s=await getUp(u,p.id),n=+p.n;if(s.state!=='open')throw bad(409,'This upload is already completed');
  if(!Number.isInteger(n)||n<0||n>=s.chunks)throw bad(400,'Bad chunk number');const want=n<s.chunks-1?CHUNK:s.total-(s.chunks-1)*CHUNK; // every chunk must have its exact expected size
  if(!Buffer.isBuffer(b)||b.length!==want)throw bad(400,`Chunk ${n} must be exactly ${want} bytes`);await putChunk(C('blobs'),u.id,'v'+p.id,n,b,'pending');return{ok:true}});
R('POST','/api/vault/upload/:id/complete',async({u,p,b})=>{await guard(u.id);const s=await getUp(u,p.id);if(s.state!=='open')throw bad(409,'This upload was already completed');
  const blob='v'+p.id,cs=await chunks(C('blobs'),u.id,blob),name=String(b.name||'').trim().slice(0,120),folder=String(b.folder||'').trim().replace(/[^\w .-]/g,'').slice(0,60),tags=String(b.tags||'').split(',').map(x=>x.trim().replace(/[^\w .-]/g,'')).filter(Boolean).slice(0,10).join(',');
  if(!name)throw bad(400,'A file name is required');
  const shapeOk=cs.length===s.chunks&&cs.every((c,i)=>c.n===i&&c.len===(i<s.chunks-1?CHUNK:s.total-(s.chunks-1)*CHUNK));if(!shapeOk)throw bad(400,'Upload incomplete or malformed. Resume or retry.');
  const h=crypto.createHash('sha256');let total=0;for(const c of cs){h.update(Buffer.from(c.data,'base64'));total+=c.len}if(total!==s.total)throw bad(400,'Uploaded size does not match the declared size');
  const claim=await C('uploads').updateOne({_id:p.id,user_id:u.id,state:'open'},{$set:{state:'done',done:Date.now()}}); // atomic: a second complete cannot pass
  if(!claim.matchedCount)throw bad(409,'This upload was already completed');
  try{const dup=await C('vault').findOne({user_id:u.id,phash:s.phash,deleted:0});if(dup){await delBlob(C('blobs'),u.id,blob);return{dedup:true,of:dup.name,saved:s.size}}
    await C('blobs').updateMany({user_id:u.id,blob},{$set:{state:'ok'}});
    const lv=await C('vault').find({user_id:u.id,name,folder}).sort({version:-1}).limit(1).project({version:1}).toArray(),version=(lv[0]?lv[0].version:0)+1;
    await C('vault').insertOne({_id:nid(),user_id:u.id,name,folder,tags,version,phash:s.phash,chash:h.digest('hex'),size:s.size,stored:total,chunks:cs.length,blob,ts:Date.now(),deleted:0});await touch(u.id,'vault');await ev(u.id,'vault',{name,version,size:s.size});return{dedup:false,version}}
  catch(e){await delBlob(C('blobs'),u.id,blob);throw e}});
R('GET','/api/vault',async({u})=>(await C('vault').find({user_id:u.id,deleted:0}).sort({name:1,version:-1}).toArray()).map(vOut));
const getV=async(u,id)=>{const f=await C('vault').findOne({_id:id,user_id:u.id});if(!f)throw bad(404,'Not found');return f};
R('GET','/api/vault/:id/file',async({u,p})=>readBlob(C('blobs'),u.id,(await getV(u,p.id)).blob));
R('POST','/api/vault/:id/verify',async({u,p})=>{const f=await getV(u,p.id),ok=!await blobCheck(C('blobs'),u.id,f.blob,f.chunks,f.chash);await ev(u.id,'verify',{what:f.name,ok});return{ok}});
R('DELETE','/api/vault/:id',async({u,p})=>{await C('vault').updateOne({_id:p.id,user_id:u.id},{$set:{deleted:1,deleted_at:Date.now()}});await touch(u.id,'vault');await ev(u.id,'delete',{title:'vault file'});return{ok:true}});
R('POST','/api/vault/:id/undelete',async({u,p})=>{await C('vault').updateOne({_id:p.id,user_id:u.id},{$set:{deleted:0}});await touch(u.id,'vault');return{ok:true}});
R('DELETE','/api/vault/:id/purge',async({u,p})=>{const f=await C('vault').findOne({_id:p.id,user_id:u.id,deleted:1});if(f){await C('vault').deleteOne({_id:p.id});await delBlob(C('blobs'),u.id,f.blob);await touch(u.id,'vault');await ev(u.id,'purge',{what:f.name})}return{ok:true}});

/* backups */
R('GET','/api/backups',async({u})=>(await B('backups').find({user_id:u.id}).project({vref:0}).sort({ts:-1}).toArray()).map(b=>({id:b._id,label:b.label,kind:b.kind,ts:b.ts,count:b.count,size:b.size,checksum:b.checksum})));
R('GET','/api/backup-status',async({u})=>({...await backupStatus(await C('users').findOne({_id:u.id})),integrity:(await C('users').findOne({_id:u.id})).integrity||null}));
R('POST','/api/backups',async({u,b})=>{await makeBackup(u.id,'manual',String(b.label||'Manual backup').slice(0,60));return{ok:true}});
const getBk=async(u,id)=>{const b=await B('backups').findOne({_id:id,user_id:u.id});if(!b)throw bad(404,'Not found');return b};
R('POST','/api/backups/:id/verify',async({u,p})=>{const b=await getBk(u,p.id),ok=!!await readBackup(b);await ev(u.id,'verify',{what:b.label,ok});return{ok}});
R('GET','/api/backups/:id/preview',async({u,p})=>{const b=await getBk(u,p.id),d=await readBackup(b);if(!d)throw bad(409,'Backup failed integrity check');
  const cur=await C('records').find({user_id:u.id,deleted:0}).toArray(),cm=new Map(cur.map(r=>[r._id,r])),bm=new Map(d.recs.map(r=>[r._id,r]));
  const add=d.recs.filter(r=>!cm.has(r._id)),lose=cur.filter(r=>!bm.has(r._id)),chg=d.recs.filter(r=>cm.has(r._id)&&FIELDS.some(k=>cm.get(r._id)[k]!==r[k]));
  const vcur=await C('vault').find({user_id:u.id,deleted:0}).toArray(),vk=new Set(vcur.map(v=>v.phash)),bk=new Set(d.vf.map(v=>v.phash));
  return{ts:b.ts,label:b.label,add:add.length,change:chg.length,lose:lose.length,newer:cur.filter(r=>r.updated>b.ts).length,vaultAdd:d.vf.filter(v=>!vk.has(v.phash)).length,vaultLose:vcur.filter(v=>!bk.has(v.phash)).length,sample:{add:add.slice(0,8).map(r=>r.title),change:chg.slice(0,8).map(r=>r.title),lose:lose.slice(0,8).map(r=>r.title)}}});
R('POST','/api/backups/:id/restore',async({u,p,b:body})=>withLock(u.id,'restore',180000,async()=>{const t0=Date.now(),b=await getBk(u,p.id),d=await readBackup(b);if(!d)throw bad(409,'Backup failed integrity check - restore refused');
  const ud=await C('users').findOne({_id:u.id}),now=Date.now(),mode=body.mode==='copy'?'copy':'replace';let items=0;
  const seqs=async n=>n?await nextSeq(u.id,n):0;
  if(mode==='copy'){const recs=d.recs.map(r=>({...r,_id:nid(),user_id:u.id,title:(r.title+' (restored copy)').slice(0,200),version:1,updated:now,deleted:0}));let s=await seqs(recs.length);recs.forEach(r=>r.seq=s++);
    if(recs.length){await C('records').insertMany(recs);await C('versions').insertMany(recs.map(r=>({_id:nid(),record_id:r._id,user_id:u.id,version:1,snapshot:pick(r),ts:now})))}
    const have=new Set((await C('vault').find({user_id:u.id,deleted:0}).toArray()).map(v=>v.phash));let nv=0;
    for(const v of d.vf){if(have.has(v.phash))continue;const nb='v'+nid(),lv=await C('vault').find({user_id:u.id,name:v.name,folder:v.folder||''}).sort({version:-1}).limit(1).project({version:1}).toArray();
      await copyBlob(B('bk_blobs'),C('blobs'),u.id,v.blob,nb);await C('vault').insertOne({...v,_id:nid(),user_id:u.id,blob:nb,version:(lv[0]?lv[0].version:0)+1,ts:now,deleted:0});nv++}
    items=recs.length+nv}
  else{if(body.confirm!==true)throw bad(400,'Confirmation required to replace current data');
    await makeBackup(u.id,'pre-restore','Safety copy before restore');
    const keep=new Set(d.vf.map(v=>v.blob));for(const v of await C('vault').find({user_id:u.id}).toArray())if(!keep.has(v.blob))await delBlob(C('blobs'),u.id,v.blob);
    await C('records').deleteMany({user_id:u.id});await C('vault').deleteMany({user_id:u.id});
    const recs=d.recs.map(r=>({...r,user_id:u.id,version:r.version+1,updated:now,deleted:0}));let s=await seqs(recs.length);recs.forEach(r=>r.seq=s++);
    if(recs.length){await C('records').insertMany(recs);await C('versions').insertMany(recs.map(r=>({_id:nid(),record_id:r._id,user_id:u.id,version:r.version,snapshot:pick(r),ts:now})))}
    for(const v of d.vf){if(!await hasBlob(C('blobs'),u.id,v.blob))await copyBlob(B('bk_blobs'),C('blobs'),u.id,v.blob,v.blob);await C('vault').insertOne({...v,user_id:u.id,deleted:0})}
    await bumpEpoch(u.id);items=recs.length+d.vf.length}
  await touch(u.id,'rec');await touch(u.id,'vault');const ms=Date.now()-t0,rpoMs=Math.max(0,(mode==='replace'?(ud.data_mod||0):0)-b.ts);
  await recovery(u.id,{type:'restore',ms,rpoMs,items,ok:true,label:b.label+' ('+mode+')'});await ev(u.id,'restore',{what:'backup "'+b.label+'" ('+mode+')',items,ms});
  return{restored:items,mode,ms,rpoMs}}));
R('POST','/api/backups/:id/drill',async({u,p})=>drill(u.id,await getBk(u,p.id)));
R('DELETE','/api/backups/:id',async({u,p})=>{await B('backups').deleteOne({_id:p.id,user_id:u.id});await gcBackupBlobs(u.id);return{ok:true}});
R('POST','/api/integrity',async({u})=>{await integrity(u.id);return(await C('users').findOne({_id:u.id})).integrity});
R('GET','/api/recoveries',async({u})=>(await C('recoveries').find({user_id:u.id}).sort({ts:-1}).limit(20).toArray()).map(({_id,user_id,...r})=>r));

/* infrastructure, failover probe, metrics */
const probe={running:false};
async function runProbe(seconds){Object.assign(probe,{running:true,startedAt:Date.now(),seconds,ok:0,failed:0,outages:[],primaries:[],err:'',done:0});let cur=null,lh=0;
  while(Date.now()-probe.startedAt<seconds*1000){const t=Date.now();
    try{await C('heartbeat').updateOne({_id:'probe'},{$set:{t}},{upsert:true});const d=await C('heartbeat').findOne({_id:'probe'});if(!d||d.t!==t)throw Error('read did not match write');probe.ok++;if(cur){cur.to=Date.now();probe.outages.push(cur);cur=null}}
    catch(e){probe.failed++;probe.err=e.message;if(!cur)cur={from:t,to:t};else cur.to=Date.now()}
    if(Date.now()-lh>2000){lh=Date.now();try{const h=await D.command({hello:1});if(h.primary&&probe.primaries[probe.primaries.length-1]!==h.primary)probe.primaries.push(h.primary)}catch{}}
    await sleep(400)}
  if(cur)probe.outages.push(cur);probe.running=false;probe.done=Date.now()}
R('POST','/api/infra/probe',({b})=>{if(probe.running)throw bad(409,'A probe is already running');const s=Math.min(Math.max(+b.seconds||60,10),180);runProbe(s).catch(e=>{probe.running=false;probe.err=e.message});return{started:true,seconds:s}});
R('GET','/api/infra/probe',()=>({...probe,maxOutageMs:Math.max(0,...(probe.outages||[]).map(o=>o.to-o.from))}));
R('GET','/api/infra',async({u})=>{const t0=Date.now(),h=await D.command({hello:1}),ping=Date.now()-t0,n=c=>C(c).estimatedDocumentCount(),ud=await C('users').findOne({_id:u.id}),bs=await backupStatus(ud);
  const lr=(await C('recoveries').find({user_id:u.id}).sort({ts:-1}).limit(1).toArray())[0];
  return{db:D.databaseName,separateBackupStore:!!client2,ping,cluster:{set:h.setName||'standalone',me:h.me||'',primary:h.primary||'',hosts:h.hosts||[],passives:h.passives||[],writable:!!h.isWritablePrimary},
    counts:{users:await n('users'),records:await n('records'),versions:await n('versions'),vault:await n('vault'),blobs:await n('blobs'),events:await n('events')},
    targets:{rtoMin:RTO_T,rpoMin:RPO_T,backupEveryMin:15},measured:{lastRtoMs:lr?lr.ms:null,lastRecoveryAt:lr?lr.ts:null,rpoExposureMs:bs.protected?0:(bs.last?Date.now()-bs.last:null),backupEveryMin:ud.autobackup}}});
R('GET','/api/metrics',async()=>{const l=[...M.lat].sort((a,b)=>a-b),t0=Date.now();let db=null;try{await D.command({ping:1});db=Date.now()-t0}catch{}
  return{uptimeS:Math.round((Date.now()-M.start)/1000),requests:M.n,errors5xx:M.err,avgMs:l.length?Math.round(l.reduce((a,x)=>a+x,0)/l.length):0,p95Ms:l.length?l[Math.floor(l.length*.95)]:0,byStatus:M.by,memMB:Math.round(process.memoryUsage().rss/1048576),dbPingMs:db,node:process.version}});
R('POST','/api/disaster',async({u})=>withLock(u.id,'restore',60000,async()=>{for(const v of await C('vault').find({user_id:u.id}).toArray())await delBlob(C('blobs'),u.id,v.blob);await C('records').deleteMany({user_id:u.id});await C('vault').deleteMany({user_id:u.id});await bumpEpoch(u.id);await touch(u.id,'rec');await touch(u.id,'vault');await ev(u.id,'disaster',{msg:'Ransomware simulation: all records and vault files wiped'});return{ok:true}}));
R('GET','/api/stats',async({u})=>{const id=u.id,cnt=(c,f)=>C(c).countDocuments(f),ud=await C('users').findOne({_id:id});
  const vf=await C('vault').aggregate([{$match:{user_id:id,deleted:0}},{$group:{_id:null,c:{$sum:1},s:{$sum:'$size'}}}]).toArray(),evs=await C('events').find({user_id:id}).sort({ts:-1}).limit(10).toArray();
  return{records:await cnt('records',{user_id:id,deleted:0}),saved:await sum(id,'sync','saved'),conflicts:await cnt('conflicts',{user_id:id}),openConflicts:await cnt('conflicts',{user_id:id,status:'open'}),
    backups:await B('backups').countDocuments({user_id:id}),vault:vf[0]?vf[0].c:0,vaultBytes:vf[0]?vf[0].s:0,dedup:await sum(id,'dedup','saved'),protection:await backupStatus(ud),trash:await cnt('records',{user_id:id,deleted:1}),verified:!!ud.verified,events:evs.map(e=>({...e.detail,ts:e.ts,kind:e.kind}))}});

/* ---------- extensions: admin API, live updates (SSE), status, cron, paginated records ---------- */
const ext=require('./extensions')({R,C,B,bad,ev,nid,E,bus,M,newUser,pwOk,emailRe,profile,approvedAdmins,alert,recOut,tick,SERVERLESS,client2,get hdrs(){return hdrs},get D(){return D},get BD(){return BD}});

/* ---------- HTTP ---------- */
const hdrs=(x={})=>({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(),microphone=(),geolocation=()',
  'Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src blob:; object-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",...(PROD?{'Strict-Transport-Security':'max-age=31536000; includeSubDomains'}:{}),...x});
const send=(res,code,o)=>{if(Buffer.isBuffer(o)){res.writeHead(code,hdrs({'Content-Type':'application/octet-stream','Content-Length':o.length,'Cache-Control':'no-store'}));return res.end(o)}res.writeHead(code,hdrs({'Content-Type':'application/json','Cache-Control':'no-store'}));res.end(JSON.stringify(o))};
const readBody=(req,max)=>new Promise((ok,no)=>{const a=[];let n=0;req.on('data',c=>{n+=c.length;if(n>max){no(bad(413,'Payload too large'));req.destroy()}else a.push(c)});req.on('end',()=>ok(Buffer.concat(a)));req.on('error',no)});
const MIME={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml'};
const handler=async(req,res)=>{const t0=Date.now();let uid='';
  res.on('finish',()=>{const ms=Date.now()-t0;if((req.url.startsWith('/api/')&&!req.url.startsWith('/api/stream'))||req.url==='/health'||req.url==='/api/health'){rec(res.statusCode,ms);if(E.LOG!=='off')console.log(JSON.stringify({t:new Date().toISOString(),m:req.method,p:req.url.split('?')[0],s:res.statusCode,ms,u:uid}))}});
  try{if(PROD&&req.headers['x-forwarded-proto']&&req.headers['x-forwarded-proto']!=='https'){res.writeHead(301,{Location:'https://'+req.headers.host+req.url});return res.end()}
    const url=new URL(req.url,'http://x');
    if(url.pathname==='/health'||url.pathname==='/api/health'){try{const t=Date.now();await D.command({ping:1});ext.sample(true,Date.now()-t).catch(()=>{});return send(res,200,{ok:true,dbMs:Date.now()-t,uptimeS:Math.round((Date.now()-M.start)/1000)})}catch(e){ext.sample(false).catch(()=>{});return send(res,503,{ok:false})}}
    if(url.pathname.startsWith('/api/')){
      const rt=routes.find(r=>r.m===req.method&&r.re.test(url.pathname));if(!rt)throw bad(404,'Not found');
      let u=null;if(rt.auth){const t=verify((req.headers.authorization||'').replace('Bearer ',''));const ss=t&&await C('sessions').findOne({_id:t.sid});
        if(!ss||ss.revoked||ss.expires<Date.now())throw bad(401,'Session expired - please sign in again');const d=await C('users').findOne({_id:t.sub});if(!d)throw bad(401,'Session expired - please sign in again');if(d.disabled)throw bad(403,'This account has been disabled by an administrator');if(d.pending)throw bad(403,PENDING_MSG);
        if(Date.now()-ss.last>60000)await C('sessions').updateOne({_id:ss._id},{$set:{last:Date.now()}});u={...d,id:d._id,sid:t.sid,role:rbac.roleOf(d)};uid=u.id;const why=rbac.denyReason(u.role,req.method,url.pathname);if(why)throw bad(403,why)} // role-based access control, checked on every authenticated request
      const bin=(req.headers['content-type']||'').startsWith('application/octet-stream'),raw=await readBody(req,bin?CHUNK+4096:12e6);let buf=raw,b={};
      if(bin)b=raw;else if(raw.length){if(req.headers['x-encoding']==='gzip')buf=zlib.gunzipSync(raw);try{b=JSON.parse(buf)}catch{throw bad(400,'Invalid JSON')}}
      const ip=(SERVERLESS||E.TRUST_PROXY==='1')?String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress:req.socket.remoteAddress; // behind a proxy (Vercel/Render) the real client IP is in X-Forwarded-For
      const out=await rt.fn({u,b,p:url.pathname.match(rt.re).groups||{},req,res,sent:raw.length,rawLen:buf.length,ip});if(out&&out.__handled)return;return send(res,200,out)}
    let f=path.normalize(path.join(PUB,url.pathname==='/'?'index.html':url.pathname));
    if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(PUB,'index.html');
    res.writeHead(200,hdrs({'Content-Type':MIME[path.extname(f)]||'application/octet-stream'}));fs.createReadStream(f).pipe(res);
  }catch(e){if(!e.status)console.error(e);if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Server error'})}
};
const server=http.createServer(handler);
const handle=async(req,res)=>{try{await ready()}catch(e){console.error('db:',e.message);return send(res,503,{error:'Database unavailable, please retry'})}return handler(req,res)}; // entry point for serverless hosts (api/index.js)
if(!SERVERLESS)ready().then(()=>server.listen(PORT,()=>console.log(`NestVault running at http://localhost:${PORT}  (database: ${D.databaseName}${client2?', backups on a separate cluster':''})\nMail: ${mailer.describe(MAIL)}`)))
  .catch(e=>{console.error('\nCould not connect to MongoDB Atlas:',e.message,'\nCheck: 1) connection string & password in .env  2) Atlas > Network Access allows your IP\n');process.exit(1)});
module.exports={server,handle,tick,get C(){return C},get B(){return B}};
