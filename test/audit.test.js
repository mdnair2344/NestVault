// In-process test: the backup reference audit must notice damaged or missing backup data.
process.env.NESTVAULT_FAKE_DB='1';process.env.MONGODB_URI='fake';process.env.LOG='off';process.env.ADMIN_CODE='admin-code-1';process.env.EDITOR_CODE='editor-code-1';process.env.PORT=String(4100+Math.floor(Math.random()*90));
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),srv=require('../server.js'),B='http://localhost:'+process.env.PORT;
const call=async(p,o={})=>{const r=await fetch(B+p,{method:o.m||'GET',headers:{...(o.tok?{Authorization:'Bearer '+o.tok}:{}),'Content-Type':o.b&&o.bin?'application/octet-stream':'application/json'},body:o.b?(o.bin?o.b:JSON.stringify(o.b)):undefined});return r.json()};
test('audit detects a missing chunk, a corrupted chunk and a deleted backup payload',async()=>{
  for(let i=0;i<100&&!srv.server.listening;i++)await new Promise(r=>setTimeout(r,50));
  const tok=(await call('/api/signup',{m:'POST',b:{email:'audit@test.io',name:'Audit',role:'editor',code:'editor-code-1',phone:'9876543210',org:'Test Clinic',password:'longenough123',confirm:'longenough123'}})).token;
  const data=crypto.randomBytes(1200000),phash=crypto.createHash('sha256').update(data).digest('hex'),c=await call('/api/vault/check',{m:'POST',tok,b:{phash,size:data.length-51}}),n=Math.ceil(data.length/c.chunk);
  const s=await call('/api/vault/upload/start',{m:'POST',tok,b:{phash,size:data.length-51,total:data.length,chunks:n}});for(let i=0;i<n;i++)await fetch(`${B}/api/vault/upload/${s.uploadId}/${i}`,{method:'PUT',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/octet-stream'},body:data.subarray(i*c.chunk,(i+1)*c.chunk)});
  await call(`/api/vault/upload/${s.uploadId}/complete`,{m:'POST',tok,b:{name:'f.bin'}});await call('/api/backups',{m:'POST',tok,b:{label:'one'}});
  assert.equal((await call('/api/integrity',{m:'POST',tok})).ok,true);
  const bk=srv.B('bk_blobs'),all=await bk.find({}).toArray(),vchunk=all.find(x=>x.n===1&&!x.blob.startsWith('bk'));
  await bk.deleteOne({_id:vchunk._id});let r=await call('/api/integrity',{m:'POST',tok});assert.equal(r.ok,false);assert.match(r.bad.join(' '),/chunks are missing|expected \d+ chunks/);
  await bk.updateOne({_id:vchunk._id},{$set:{...vchunk,data:Buffer.from('tampered').toString('base64'),len:vchunk.len}},{upsert:true});r=await call('/api/integrity',{m:'POST',tok});assert.equal(r.ok,false);assert.match(r.bad.join(' '),/checksum mismatch/);
  const bks=await srv.B('backups').find({}).toArray();await bk.deleteMany({blob:bks[0].payload_blob});r=await call('/api/integrity',{m:'POST',tok});assert.equal(r.ok,false);assert.match(r.bad.join(' '),/data: blob is missing/);
  srv.server.close();setTimeout(()=>process.exit(0),100)});
