import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService} from '../server.mjs';
import {solveChallenge} from 'altcha-lib';
import {deriveKey} from 'altcha-lib/algorithms/pbkdf2';
const origin = 'https://cliftondynamics.com';
const config = {CHALLENGE_SECRET:'synthetic-test-secret-with-at-least-32-characters',ALLOWED_ORIGINS:origin,PROTON_SMTP_USER:'sender@example.com',CONTACT_RECIPIENT:'inbox@example.com',PROTON_SMTP_TOKEN:'fake-test-token'};
const fields = {name:'Test Visitor',email:'visitor@example.com',organisation:'',message:'Synthetic test enquiry',source:'Test',website:''};
async function start(t, options={}) {
  const sent=[];
  const server=createService({config,databasePath:':memory:',challengeCounter:1,sendMail:async mail=>{sent.push(mail);},...options});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  let closing; const close=()=>closing ||= new Promise(resolve=>server.close(resolve));
  t.after(close);
  const request=(path, options={})=>fetch(base+path,{...options,headers:{Origin:origin,'Content-Type':'application/json',...options.headers}});
  const submit=(data)=>request('/enquiry',{method:'POST',body:JSON.stringify(data)});
  const token=async()=>{
    const response=await request('/challenge'); assert.equal(response.status,200);
    const challenge=await response.json();
    const solution=await solveChallenge({challenge,deriveKey});
    return Buffer.from(JSON.stringify({challenge,solution})).toString('base64');
  };
  return {server,request,submit,token,sent,close};
}
test('real proof is verified and email has fixed recipient and visitor reply-to',async t=>{
  const s=await start(t); const token=await s.token();
  const r=await s.submit({...fields,token,to:'attacker@example.com'});
  assert.equal(r.status,200); assert.deepEqual(await r.json(),{ok:true});
  assert.equal(s.sent.length,1);assert.equal(s.sent[0].to,'inbox@example.com');
  assert.equal(s.sent[0].replyTo.address,fields.email);
  assert.match(s.sent[0].text,/How did you hear about Clifton Dynamics\?/);
});
test('parallel replay sends only one email',async t=>{
  const s=await start(t); const token=await s.token();
  const r=await Promise.all([s.submit({...fields,token}),s.submit({...fields,token})]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,403]); assert.equal(s.sent.length,1);
});
test('used challenges remain rejected after service restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'contact-replay-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const databasePath=join(dir,'contact.sqlite');
  const a=await start(t,{databasePath});const token=await a.token();assert.equal((await a.submit({...fields,token})).status,200);await a.close();
  const b=await start(t,{databasePath});assert.equal((await b.submit({...fields,token})).status,403);assert.equal(b.sent.length,0);
});
test('expired proof is rejected',async t=>{
  let time=Date.now();const s=await start(t,{now:()=>time});const token=await s.token();time+=601000;
  assert.equal((await s.submit({...fields,token})).status,403);
});
test('tampered solution and unissued challenge are rejected',async t=>{
  const s=await start(t);const token=await s.token();const p=JSON.parse(Buffer.from(token,'base64'));
  p.solution.counter=999999;let bad=Buffer.from(JSON.stringify(p)).toString('base64');
  assert.equal((await s.submit({...fields,token:bad})).status,403);
  p.challenge.signature='unissued';bad=Buffer.from(JSON.stringify(p)).toString('base64');
  assert.equal((await s.submit({...fields,token:bad})).status,403);assert.equal(s.sent.length,0);
});
for(const change of [{website:'spam'}, {name:''},{email:'a@example.com\r\nBcc: b@example.com'},{message:'x'.repeat(5001)},{token:''}])test(`invalid fields are blocked: ${Object.keys(change)[0]}`,async t=>{
 const s=await start(t);assert.equal((await s.submit({...fields,token:'fake',...change})).status,400);assert.equal(s.sent.length,0);
});
test('wrong origin and unsupported types are rejected',async t=>{
 const s=await start(t);assert.equal((await s.request('/challenge',{headers:{Origin:'https://attacker.example'}})).status,403);
 assert.equal((await s.request('/enquiry',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
});
test('missing mail configuration fails closed but health reports installation status',async t=>{
 const s=await start(t,{config:{...config,PROTON_SMTP_TOKEN:''}});
 assert.equal((await s.submit({...fields,token:'fake'})).status,503);
 assert.deepEqual(await (await s.request('/health')).json(),{status:'awaiting_mail_configuration'});
});
test('mail failure returns error without exposing SMTP details',async t=>{
 const s=await start(t,{sendMail:async()=>{throw new Error('Private SMTP diagnostics');}}); const token=await s.token();
 const r=await s.submit({...fields,token});assert.equal(r.status,503);assert.deepEqual(await r.json(),{ok:false,code:'unavailable'});
});
test('rate limit blocks repeated submissions',async t=>{
 const s=await start(t);for(let i=0;i<5;i++)await s.submit({...fields,token:'fake'});
 assert.equal((await s.submit({...fields,token:'fake'})).status,429);assert.equal(s.sent.length,0);
});
test('oversized body is rejected',async t=>{
 const s=await start(t);assert.equal((await s.submit({...fields,message:'x'.repeat(40000),token:'fake'})).status,413);
});
