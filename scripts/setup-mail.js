// One-time setup of the SENDING mailbox (the app's own address). Recipients are always each user's own sign-in email.
// Run:  npm run setup:mail
const fs=require('fs'),path=require('path'),readline=require('readline'),mailer=require('../mailer');
const ENV=process.env.NV_ENV_FILE||path.join(__dirname,'..','.env');
const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:false});
const lines=[];let waiting=null;rl.on('line',l=>{waiting?waiting(l):lines.push(l)});rl.on('close',()=>waiting&&waiting(''));
const ask=q=>new Promise(r=>{process.stdout.write(q);if(lines.length)return r(lines.shift().trim());waiting=l=>{waiting=null;r(l.trim())}});
(async()=>{
  console.log('\nNestVault email setup\nThis sets the mailbox that SENDS the emails (verification and password reset).\nThe emails themselves go to the address each user signed up with.\n');
  console.log('  1) Gmail        (needs an App Password: myaccount.google.com/apppasswords)\n  2) Brevo        (free tier; use your Brevo login and SMTP key)\n  3) Other SMTP server');
  const p=await ask('\nChoose 1, 2 or 3: ');let host,port='587',secure='';
  if(p==='1')host='smtp.gmail.com';else if(p==='2')host='smtp-relay.brevo.com';else{host=await ask('SMTP host: ');port=(await ask('SMTP port [587]: '))||'587';if(port==='465')secure='true'}
  if(!host){console.error('No host given.');process.exit(1)}
  const user=await ask('Sender login (usually the email address): '),pass=await ask('Password or app password: '),from=(await ask(`"From" address [${user}]: `))||user;
  const set={SMTP_HOST:host,SMTP_PORT:port,SMTP_USER:user,SMTP_PASS:pass,SMTP_FROM:from};if(secure)set.SMTP_SECURE=secure;
  let txt='';try{txt=fs.readFileSync(ENV,'utf8')}catch{try{txt=fs.readFileSync(path.join(__dirname,'..','.env.example'),'utf8')}catch{}}
  for(const[k,v]of Object.entries(set)){const re=new RegExp('^'+k+'=.*$','m');txt=re.test(txt)?txt.replace(re,()=>k+'='+v):txt.replace(/\s*$/,'\n')+k+'='+v+'\n'}
  fs.writeFileSync(ENV,txt);console.log('\nSaved to '+ENV);
  console.log('Sending a test email to '+from+' ...');
  try{await mailer.send(mailer.config(set),from,'NestVault email is set up','This message was sent by NestVault. Verification and password-reset emails will now be delivered to each user\'s own sign-in address.');console.log('Done. Check the inbox of '+from+' (and spam). Restart the server with: npm start')}
  catch(e){console.error('\nThe settings were saved, but the test email FAILED: '+e.message);if(/535|Login was refused/.test(e.message))console.error('Hint: wrong login. For Gmail use an App Password, not your normal password.');process.exit(1)}
  rl.close()})();