// Checks the MongoDB driver behaviours NestVault depends on, against YOUR real Atlas cluster.
// Run:  npm install && npm run check:atlas     (uses MONGODB_URI from .env; creates and drops a temporary database)

require('node:dns').setServers(['8.8.8.8']);
const fs=require('fs'),path=require('path'),crypto=require('crypto');
try{for(const l of fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m&&!l.trim().startsWith('#')&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^["']|["']$/g,'')}}catch{}
if(!process.env.MONGODB_URI){console.error('Set MONGODB_URI in .env first');process.exit(2)}
const {MongoClient}=require('mongodb');let pass=0,fail=0;
const check=async(name,fn)=>{try{await fn();pass++;console.log('  PASS  '+name)}catch(e){fail++;console.log('  FAIL  '+name+'\n        '+e.message)}};
const eq=(a,b,m)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`${m||'values differ'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`)};
(async()=>{const cl=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:10000}),name='nv_check_'+crypto.randomBytes(4).toString('hex');
  try{await cl.connect()}catch(e){console.error('Cannot connect:',e.message);process.exit(2)}const db=cl.db(name),C=n=>db.collection(n);console.log('Connected. Temporary database:',name);
  await check('unique index rejects duplicates with error code 11000',async()=>{await C('u').createIndex({email:1},{unique:true});await C('u').insertOne({_id:'1',email:'a@x'});try{await C('u').insertOne({_id:'2',email:'a@x'});throw Error('duplicate accepted')}catch(e){eq(e.code,11000)}});
  await check('TTL index can be created',async()=>{await C('rl').createIndex({exp:1},{expireAfterSeconds:0})});
  await check('findOneAndUpdate with $inc returns the updated document (driver v6)',async()=>{await C('u').insertOne({_id:'s',email:'s@x',seq:0});const d=await C('u').findOneAndUpdate({_id:'s'},{$inc:{seq:3}},{returnDocument:'after'});eq(d&&d.seq,3,'seq')});
  await check('updateOne upsert creates the document',async()=>{await C('rl').updateOne({_id:'k'},{$set:{hits:[1],exp:new Date()}},{upsert:true});eq((await C('rl').findOne({_id:'k'})).hits,[1])});
  await check('lock acquisition works on documents with and without the field',async()=>{await C('u').insertOne({_id:'l',email:'l@x'});const f=n=>({_id:'l',$or:[{[n]:{$lt:Date.now()}},{[n]:{$exists:false}}]});
    eq((await C('u').updateOne(f('lock'),{$set:{lock:Date.now()+60000}})).matchedCount,1,'first acquire');eq((await C('u').updateOne(f('lock'),{$set:{lock:Date.now()+60000}})).matchedCount,0,'second acquire must fail')});
  await check('aggregate $group/$sum on a nested field',async()=>{await C('ev').insertMany([{_id:'a',u:'1',kind:'sync',detail:{saved:5}},{_id:'b',u:'1',kind:'sync',detail:{saved:7}}]);const r=await C('ev').aggregate([{$match:{u:'1',kind:'sync'}},{$group:{_id:null,s:{$sum:'$detail.saved'}}}]).toArray();eq(r[0].s,12)});
  await check('find with sort, skip, limit and exclusion projection',async()=>{await C('v').insertMany([1,2,3,4].map(n=>({_id:'v'+n,n,data:'x'})));const r=await C('v').find({}).sort({n:-1}).skip(1).limit(2).project({data:0}).toArray();eq(r.map(x=>x.n),[3,2]);eq('data' in r[0],false)});
  await check('updateMany with $ne and deleteMany with $in',async()=>{await C('v').updateMany({_id:{$ne:'v1'}},{$set:{t:1}});eq(await C('v').countDocuments({t:1}),3);await C('v').deleteMany({_id:{$in:['v1','v2']}});eq(await C('v').countDocuments({}),2)});
  await check('a 700 KB base64 chunk document round-trips (blob chunks)',async()=>{const b=crypto.randomBytes(524288).toString('base64');await C('bl').updateOne({_id:'b:0'},{$set:{data:b,len:524288}},{upsert:true});eq((await C('bl').findOne({_id:'b:0'})).data===b,true)});
  await check('hello command reports replica-set details',async()=>{const h=await db.command({hello:1});if(!h.isWritablePrimary)throw Error('not writable');console.log('        replica set:',h.setName||'(standalone)','| primary:',h.primary||'-','| members:',(h.hosts||[]).length)});
  await check('ping command',async()=>{await db.command({ping:1})});
  await db.dropDatabase();await cl.close();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)})();
