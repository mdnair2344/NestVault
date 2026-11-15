// Client logic test: loads public/app.js in a stubbed browser environment and checks rendering helpers and the vault crypto.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const stub=()=>new Proxy(function(){},{get:(t,k)=>k==='dataset'?{}:k==='classList'?{toggle(){}}:k==='value'?'':stub(),apply:()=>stub(),set:()=>true});
const ctx={console,location:{hash:'',pathname:'/'},history:{replaceState(){}},document:{querySelector:()=>stub(),querySelectorAll:()=>[],addEventListener(){},documentElement:{dataset:{}},createElement:()=>stub()},localStorage:{},matchMedia:()=>({matches:false}),navigator:{},addEventListener(){},setInterval(){},setTimeout(){},scrollTo(){},scrollY:0,
  fetch:async()=>({ok:true,status:200,json:async()=>({})}),crypto:require('node:crypto').webcrypto,TextEncoder,TextDecoder,Blob,Response,URL,btoa,atob,Uint8Array,DataView,Promise};
ctx.globalThis=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8')+';globalThis.__t={V,S,plan,recList,strength,enc,dec,hex,ext,ftype}',ctx);const T=ctx.__t,S=T.S;
S.user={name:'T',id:'u'};S.recs=[{id:'a',title:'<b>X</b>',body:'',category:'outbreak',priority:'critical',status:'open',version:2,updated:1},{id:'b',title:'Y',body:'',category:'farm',priority:'low',status:'done',version:1,updated:2}];
test('selective sync and budget planning',()=>{S.outbox=[{id:'a',base:2,fields:{body:'x'},ts:5,edits:4,rev:4},{id:'b',base:1,fields:{status:'open'},ts:9,edits:2,rev:2}];S.cats=['outbreak'];
  const p=T.plan();assert.equal(JSON.stringify(p.map(x=>[x.o.id,x.fit])),JSON.stringify([['a',true],['b',false]]));S.cats=[];S.budget=0});
test('record list escapes HTML',()=>{assert.ok(T.recList().includes('&lt;b&gt;'));assert.ok(!T.recList().includes('<b>X</b>'))});
test('passphrase strength',()=>{assert.equal(T.strength('abc')[0],'weak');assert.equal(T.strength('Abcdefgh1234!')[0],'strong')});
test('file types',()=>{assert.equal(T.ftype('a.PDF'),'pdf');assert.equal(T.ftype('a.png'),'image');assert.equal(T.ftype('a.zip'),'other')});
test('vault crypto round trip, wrong key fails',async()=>{const buf=new TextEncoder().encode('hello vault').buffer,e=await T.enc(buf,'correct horse battery');assert.ok(e instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(await T.dec(e,'correct horse battery')),'hello vault');await assert.rejects(()=>T.dec(e,'wrong passphrase!!'))});
