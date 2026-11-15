// In-process test of the restore lock: while a restore holds the lock, other changes are refused with 423.
process.env.NESTVAULT_FAKE_DB='1';process.env.MONGODB_URI='fake';process.env.LOG='off';process.env.ADMIN_CODE='admin-code-1';process.env.EDITOR_CODE='editor-code-1';process.env.PORT=String(4200+Math.floor(Math.random()*90));
const {test}=require('node:test'),assert=require('node:assert/strict'),srv=require('../server.js'),B='http://localhost:'+process.env.PORT;
const call=async(p,o={})=>{const r=await fetch(B+p,{method:o.m||'GET',headers:{...(o.tok?{Authorization:'Bearer '+o.tok}:{}),'Content-Type':'application/json'},body:o.b?JSON.stringify(o.b):undefined});return{status:r.status,body:await r.json().catch(()=>({}))}};
test('restore lock blocks sync, record changes, uploads and a second restore; releases afterwards',async()=>{
  for(let i=0;i<100&&!srv.server.listening;i++)await new Promise(r=>setTimeout(r,50));
  const S=(await call('/api/signup',{m:'POST',b:{email:'lock@test.io',name:'Lock',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'longenough123',confirm:'longenough123'}})).body,tok=S.token,uid=S.user.id,P=(p,b)=>call(p,{m:'POST',tok,b});
  await P('/api/sync',{changes:[{id:'r1',base:0,rev:1,fields:{title:'One'}}]});await P('/api/backups',{label:'b'});const bk=(await call('/api/backups',{tok})).body[0];
  await srv.C('users').updateOne({_id:uid},{$set:{lock_restore:Date.now()+60000}}); // simulate a restore in progress
  assert.equal((await P('/api/sync',{changes:[]})).status,423);assert.equal((await P('/api/records/r1/undelete')).status,423);assert.equal((await P('/api/conflicts/x/resolve',{choice:'mine'})).status,423);
  assert.equal((await P('/api/vault/upload/start',{phash:'a'.repeat(64),size:10,total:61,chunks:1})).status,423);
  assert.equal((await P(`/api/backups/${bk.id}/restore`,{mode:'replace',confirm:true})).status,409,'a second restore cannot start');assert.equal((await P('/api/disaster')).status,409);
  await srv.C('users').updateOne({_id:uid},{$set:{lock_restore:0}});assert.equal((await P('/api/sync',{changes:[]})).status,200);
  assert.equal((await P(`/api/backups/${bk.id}/restore`,{mode:'replace',confirm:true})).status,200);assert.equal((await P('/api/sync',{changes:[]})).status,200,'lock is released after the restore');
  srv.server.close();setTimeout(()=>process.exit(0),100)});
