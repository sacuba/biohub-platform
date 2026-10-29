import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.DATA_DIR=path.resolve('test-results','mail-'+crypto.randomUUID());
process.env.MAIL_TRANSPORT='smtp';
const {saveMail,mailConfig,createUser,issueToken,verifyCode,resetPassword}=await import('../src/auth');
const {db}=await import('../src/db');
const messages:string[]=[];
test('SMTP sends registration and reset mail; encrypted settings never disclose password',async()=>{
 const server=net.createServer(socket=>{
  socket.setEncoding('utf8');socket.write('220 localhost ESMTP\r\n');let buffered='',data=false,body='';
  socket.on('data',chunk=>{buffered+=chunk;let index;while((index=buffered.indexOf('\r\n'))>=0){const line=buffered.slice(0,index);buffered=buffered.slice(index+2);
   if(data){if(line==='.') {messages.push(body);body='';data=false;socket.write('250 accepted\r\n');}else body+=line+'\r\n';continue;}
   if(line.startsWith('EHLO'))socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
   else if(line.startsWith('AUTH PLAIN'))socket.write('235 authenticated\r\n');
   else if(line.startsWith('MAIL FROM')||line.startsWith('RCPT TO'))socket.write('250 OK\r\n');
   else if(line==='DATA'){data=true;socket.write('354 End with dot\r\n');}
   else if(line==='QUIT')socket.end('221 bye\r\n');else socket.write('250 OK\r\n');
  }});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=(server.address() as net.AddressInfo).port;saveMail({host:'127.0.0.1',port,secure:false,user:'sender@test.local',from:'sender@test.local',password:'smtp-secret-test'});
  const saved=(db.prepare("SELECT value FROM settings WHERE key='mail'").get() as any).value;
  assert.ok(!saved.includes('smtp-secret-test'));assert.equal(mailConfig().password,undefined);assert.equal(mailConfig().has_password,true);assert.equal(mailConfig().capture,false);
  saveMail({host:'127.0.0.1',port,secure:false,user:'sender@test.local',from:'sender@test.local',password:''});
  const user=await createUser({email:'mail-recipient@test.local',password:'registration-password-123'});await issueToken(user,'register');assert.equal(messages.length,1);
  const raw=messages[0];const headersAndBody=raw.split('\r\n\r\n');const body=raw.includes('Content-Transfer-Encoding: base64')?Buffer.from(headersAndBody.slice(1).join('\r\n\r\n').replace(/\s/g,''),'base64').toString():headersAndBody.slice(1).join('\r\n\r\n').replace(/=\r\n/g,'').replace(/=([0-9A-F]{2})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
  const code=body.match(/\b\d{6}\b/)?.[0];assert.ok(code);verifyCode({email:user.email,code});assert.throws(()=>verifyCode({email:user.email,code}));
  await issueToken(user,'reset');assert.equal(messages.length,2);const resetMail=messages[1];const content=resetMail.split('\r\n\r\n').slice(1).join('\r\n\r\n');const decoded=resetMail.includes('Content-Transfer-Encoding: base64')?Buffer.from(content.replace(/\s/g,''),'base64').toString():content.replace(/=\r\n/g,'').replace(/=([0-9A-F]{2})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
  const token=decoded.match(/reset=([A-Za-z0-9_-]+)/)?.[1];assert.ok(token);await resetPassword({token,password:'reset-password-456',confirm_password:'reset-password-456'});await assert.rejects(resetPassword({token,password:'reset-password-456',confirm_password:'reset-password-456'}));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
});
