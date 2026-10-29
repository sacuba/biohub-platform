import fs from 'node:fs';
import path from 'node:path';
import {db} from '../src/db';
import {saveMail} from '../src/auth';
import {decrypt} from '../src/config';
import nodemailer from 'nodemailer';
const file=path.resolve('../dev-runtime/mail-transfer.json');
try{
 if(fs.existsSync(file)){
  const resolved=fs.realpathSync(file);if(resolved.split(path.sep).some(p=>p.endsWith('-prod')))throw new Error('Production paths are not allowed');
  saveMail(JSON.parse(fs.readFileSync(resolved,'utf8')));fs.unlinkSync(resolved);
  console.log('Previous development SMTP settings restored with platform encryption. Transfer file removed.');
 }
 const row=db.prepare("SELECT value FROM settings WHERE key='mail'").get() as {value:string}|undefined;
 if(!row)throw new Error('Mail settings missing');const mail=JSON.parse(row.value);
 const transport=nodemailer.createTransport({host:mail.host,port:mail.port,secure:mail.secure,auth:mail.user?{user:mail.user,pass:mail.password?decrypt(mail.password):''}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
 try{
  await transport.verify();console.log('SMTP connection, TLS and authentication verified.');
  const recipient=process.argv.find(arg=>arg.startsWith('--send-to='))?.slice('--send-to='.length);
  if(recipient){
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)||/[\r\n]/.test(recipient))throw new Error('Invalid test recipient');
   const result=await transport.sendMail({from:mail.from,to:recipient,subject:'BioHub 邮件服务恢复测试',text:'BioHub 的邮件服务配置已恢复。这是一封经你确认发送的测试邮件，用于检查真实 SMTP 发信链路。此邮件不包含验证码、密码或重置链接，无需操作。'});
   if(!result.accepted?.length)throw new Error('Test email was not accepted');console.log('Test email accepted by SMTP server; inbox delivery needs recipient confirmation.');
  }else console.log('No test email sent.');
 }finally{transport.close();}
 const prefs=path.resolve('../dev-runtime/preferences.json');const previous=fs.existsSync(prefs)?JSON.parse(fs.readFileSync(prefs,'utf8')):{};
 fs.writeFileSync(prefs,JSON.stringify({...previous,mail_transport:'smtp'},null,2)+'\n',{mode:0o600});
 console.log('SMTP enabled for platform on next development restart.');
}catch{console.error('Mail restore/verification failed; inspect SMTP settings locally. Capture mode remains available.');process.exitCode=1;}
finally{db.close();}
