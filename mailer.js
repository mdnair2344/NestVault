'use strict';
// Sends email. Three modes, chosen from environment variables:
//   SMTP_HOST set          -> real email through any SMTP account (Gmail, Brevo, Outlook, SendGrid, ...)
//   MAIL_WEBHOOK_URL set   -> JSON POST {to, subject, text} to a mail API
//   neither                -> the message is printed in the server console (development only)
const net=require('net'),tls=require('tls'),os=require('os'),crypto=require('crypto');
const LOCAL=new Set(['localhost','127.0.0.1','::1']);
function config(E){
  if(E.SMTP_HOST){const port=+E.SMTP_PORT||587,from=E.SMTP_FROM||E.SMTP_USER||'';
    return{mode:'smtp',host:E.SMTP_HOST,port,secure:E.SMTP_SECURE==='true'||port===465,user:E.SMTP_USER||'',pass:E.SMTP_PASS||'',from,starttls:E.SMTP_STARTTLS!=='false',selfSigned:E.SMTP_ALLOW_SELF_SIGNED==='true',insecure:E.SMTP_ALLOW_INSECURE==='true'}}
  if(E.MAIL_WEBHOOK_URL)return{mode:'webhook',url:E.MAIL_WEBHOOK_URL,auth:E.MAIL_WEBHOOK_AUTH||''};
  return{mode:'console'}}
const describe=c=>c.mode==='smtp'?`SMTP ${c.host}:${c.port} (${c.secure?'TLS':c.starttls?'STARTTLS':'no encryption'}), from ${c.from||'(not set)'}`:c.mode==='webhook'?'webhook':'not configured (links are printed in the server console)';
const clean=s=>String(s).replace(/[\r\n]+/g,' ').trim();
const encHeader=s=>/^[\x20-\x7e]*$/.test(s)?s:'=?UTF-8?B?'+Buffer.from(s).toString('base64')+'?=';
const address=s=>{const m=String(s).match(/<([^>]+)>/);return(m?m[1]:String(s)).trim()};

function smtpSend(c,to,subject,text){
  return new Promise((resolve,reject)=>{
    let sock,buf='',done=false;const replies=[],waiters=[];
    const fail=e=>{if(done)return;done=true;clearTimeout(timer);try{sock&&sock.destroy()}catch{}reject(e instanceof Error?e:Error(String(e)))};
    const timer=setTimeout(()=>fail(Error('The mail server did not answer in time (check SMTP_HOST and SMTP_PORT)')),25000);
    let cur=[];const pump=()=>{let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).replace(/\r$/,'');buf=buf.slice(i+1);cur.push(line);
      if(/^\d{3}( |$)/.test(line)){const r={code:+line.slice(0,3),lines:cur};cur=[];const w=waiters.shift();w?w(r):replies.push(r)}}};
    const attach=s=>{sock=s;s.setEncoding('utf8');s.on('data',d=>{buf+=d;pump()});s.on('error',fail);s.on('close',()=>fail(Error('The mail server closed the connection unexpectedly')))};
    const read=()=>new Promise(r=>replies.length?r(replies.shift()):waiters.push(r));
    const cmd=async(line,ok,label)=>{sock.write(line+'\r\n');const r=await read();if(!ok.includes(r.code))throw Error(`${label||line.split(' ')[0]} was refused by the mail server: ${r.code} ${r.lines.map(l=>l.slice(4)).join(' ')}`);return r};
    const has=(r,w)=>r.lines.some(l=>new RegExp('^250[- ]AUTH.*\\b'+w+'\\b','i').test(l));
    (async()=>{
      attach(c.secure?tls.connect({host:c.host,port:c.port,servername:c.host,rejectUnauthorized:!c.selfSigned}):net.connect({host:c.host,port:c.port}));
      const g=await read();if(g.code!==220)throw Error('Unexpected greeting from the mail server: '+g.lines.join(' '));
      const me=os.hostname()||'localhost';let eh=await cmd('EHLO '+me,[250],'EHLO');
      const secured=c.secure;
      if(!secured&&c.starttls&&eh.lines.some(l=>/STARTTLS/i.test(l))){
        await cmd('STARTTLS',[220],'STARTTLS');const old=sock;old.removeAllListeners('data');old.removeAllListeners('error');old.removeAllListeners('close');
        const t=tls.connect({socket:old,servername:c.host,rejectUnauthorized:!c.selfSigned});await new Promise((ok,no)=>{t.once('secureConnect',ok);t.once('error',no)});attach(t);eh=await cmd('EHLO '+me,[250],'EHLO')}
      else if(!secured&&c.user&&!LOCAL.has(c.host)&&!c.insecure)throw Error('The mail server does not offer encryption (STARTTLS), so the password would be sent in clear text. Refusing. Use port 587 or 465.');
      if(c.user){if(has(eh,'PLAIN')||!has(eh,'LOGIN'))await cmd('AUTH PLAIN '+Buffer.from('\0'+c.user+'\0'+c.pass).toString('base64'),[235],'Login');
        else{await cmd('AUTH LOGIN',[334],'Login');await cmd(Buffer.from(c.user).toString('base64'),[334],'Login');await cmd(Buffer.from(c.pass).toString('base64'),[235],'Login')}}
      const from=c.from&&c.from.includes('<')?c.from:`NestVault <${c.from||c.user}>`,fa=address(from),dom=(fa.split('@')[1]||'localhost');
      await cmd(`MAIL FROM:<${fa}>`,[250],'Sender address');await cmd(`RCPT TO:<${address(to)}>`,[250,251],'Recipient address');await cmd('DATA',[354],'DATA');
      const body=Buffer.from(text,'utf8').toString('base64').replace(/(.{76})/g,'$1\r\n'); // base64 body: no dot-stuffing or line-length problems
      const msg=[`From: ${clean(from)}`,`To: ${clean(to)}`,`Subject: ${encHeader(clean(subject))}`,`Date: ${new Date().toUTCString()}`,`Message-ID: <${crypto.randomBytes(12).toString('hex')}@${dom}>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',body].join('\r\n');
      await cmd(msg+'\r\n.',[250],'Message');try{sock.write('QUIT\r\n')}catch{}
      done=true;clearTimeout(timer);setTimeout(()=>{try{sock.destroy()}catch{}},200);resolve({mode:'smtp'})
    })().catch(fail)})}

async function send(c,to,subject,text){
  if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(address(to)))throw Error('Invalid recipient address');
  if(c.mode==='smtp')return smtpSend(c,to,subject,text);
  if(c.mode==='webhook'){const r=await fetch(c.url,{method:'POST',headers:{'Content-Type':'application/json',...(c.auth?{Authorization:c.auth}:{})},body:JSON.stringify({to,subject,text})});if(!r.ok)throw Error('Mail webhook answered '+r.status);return{mode:'webhook'}}
  console.log(`[mail - not sent, no mail service configured] to=${to} subject="${subject}"\n${text}`);return{mode:'console'}}
module.exports={config,describe,send,smtpSend};