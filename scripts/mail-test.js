// Sends one test email using the settings in .env, so you can check your SMTP setup in seconds.
// Run:  npm run test:mail -- you@example.com
const fs=require('fs'),path=require('path'),mailer=require('../mailer');
try{for(const l of fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m&&!l.trim().startsWith('#')&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^["']|["']$/g,'')}}catch{}
const c=mailer.config(process.env),to=process.argv[2]||c.user||(c.from||'').replace(/.*<|>.*/g,'');
if(!to){console.error('Usage: npm run test:mail -- you@example.com   (sends one test message to that address)');process.exit(2)}
console.log('Mail settings:',mailer.describe(c));
if(c.mode==='console'){console.error('\nNo email service is configured. Run: npm run setup:mail');process.exit(1)}
mailer.send(c,to,'NestVault test email','If you can read this, NestVault can send email.\n\nSettings used: '+mailer.describe(c)).then(()=>{console.log(`\nSent. Check the inbox of ${to} (and the spam folder).`)}).catch(e=>{
  console.error('\nFAILED:',e.message);const m=e.message;
  if(/535|Login was refused|authentication/i.test(m))console.error('Hint: wrong username or password. For Gmail use an App Password, not your normal password.');
  else if(/ECONNREFUSED|ENOTFOUND|did not answer|ETIMEDOUT/i.test(m))console.error('Hint: check SMTP_HOST and SMTP_PORT (587 or 465), and that your network allows outgoing mail.');
  else if(/clear text/i.test(m))console.error('Hint: use port 587 (STARTTLS) or 465 (SMTP_SECURE=true).');
  else if(/self[- ]signed|certificate/i.test(m))console.error('Hint: the server certificate is not trusted. Only for a server you control, set SMTP_ALLOW_SELF_SIGNED=true.');
  else if(/Sender address|Recipient address/i.test(m))console.error('Hint: SMTP_FROM must be an address your provider lets you send from (for Gmail, your own address).');
  process.exit(1)});