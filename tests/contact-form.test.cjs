const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
async function setup({configured=true,reply=async()=>({ok:true,status:200,json:async()=>({ok:true})})}={}) {
 const listeners={}, widgetEvents={}, requests=[];
 let cleared=false, resets=0;
 const send={disabled:true,textContent:'Send enquiry'};
 const retry={hidden:true,addEventListener:(event,fn)=>{listeners.retry=fn;}};
 const note={textContent:'Preview only. Email delivery is not connected yet.',dataset:{}};
 const fields={name:'Test Person',email:'visitor@example.com',organisation:'',message:'Synthetic test',source:'Testing',website:''};
 const controls=[{readOnly:false},{readOnly:false}];
 const widget={setAttribute(){},addEventListener:(event,fn)=>{widgetEvents[event]=fn;},reset(){resets++;},verify(){}};
 const form={querySelector:s=>s==='[type="submit"]'?send:retry,querySelectorAll:()=>controls,
  addEventListener:(event,fn)=>{listeners[event]=fn;},reportValidity:()=>true,setAttribute(){},removeAttribute(){},reset(){cleared=true;}};
 const verification={hidden:true,appendChild(){}};
 const context={document:{querySelector:()=>form,getElementById:id=>id==='form-note'?note:verification,createElement:()=>widget},customElements:{whenDefined:async()=>{}},
  FormData:class{[Symbol.iterator](){return Object.entries(fields)[Symbol.iterator]();}},URL,AbortController,setTimeout,clearTimeout,
  fetch:async(...args)=>{requests.push(args);return reply(...args);}};
 vm.runInNewContext(source.replace(/endpoint: '[^']*'/, configured ? "endpoint: 'https://contact.example.com/enquiry'" : "endpoint: ''"),context);
 await Promise.resolve();
 return {send,note,fields,requests,controls,get cleared(){return cleared;},get resets(){return resets;},verify:()=>widgetEvents.verified({detail:{payload:'test-proof'}}),expire:()=>widgetEvents.statechange({detail:{state:'expired'}}),submit:()=>listeners.submit({preventDefault(){}})};
}
test('unconfigured form cannot send or claim success',async()=>{
 const s=await setup({configured:false});await s.submit();assert.equal(s.send.disabled,true);assert.equal(s.requests.length,0);assert.match(s.note.textContent,/Preview only/);
});
test('verification is required and expiry disables sending',async()=>{
 const s=await setup();await s.submit();assert.equal(s.requests.length,0);s.verify();assert.equal(s.send.disabled,false);s.expire();assert.equal(s.send.disabled,true);
});
test('success sends the proof and source field, then clears the form',async()=>{
 const s=await setup();s.verify();await s.submit();const body=JSON.parse(s.requests[0][1].body);
 assert.equal(body.token,'test-proof');assert.equal(body.source,'Testing');assert.equal(s.cleared,true);assert.equal(s.note.dataset.state,'success');assert.equal(s.resets,1);
});
for(const status of [403,429,503])test(`HTTP ${status} retains input and requires fresh verification`,async()=>{
 const s=await setup({reply:async()=>({ok:false,status,json:async()=>({ok:false})})});s.verify();await s.submit();
 assert.equal(s.cleared,false);assert.equal(s.note.dataset.state,'error');assert.equal(s.send.disabled,true);
});
test('network failure preserves the enquiry without claiming delivery',async()=>{
 const s=await setup({reply:async()=>{throw Error('offline');}});s.verify();await s.submit();assert.equal(s.cleared,false);assert.match(s.note.textContent,/couldn’t confirm delivery/);
});
test('invalid acknowledgement never claims success',async()=>{
 const s=await setup({reply:async()=>({ok:true,status:200,json:async()=>{throw Error('invalid');}})});s.verify();await s.submit();assert.equal(s.cleared,false);assert.equal(s.note.dataset.state,'error');
});
test('pending submission prevents duplicates and edits until complete',async()=>{
 let resolve;const s=await setup({reply:()=>new Promise(r=>{resolve=r;})});s.verify();const first=s.submit();await s.submit();assert.equal(s.requests.length,1);assert.ok(s.controls.every(c=>c.readOnly));
 resolve({ok:true,status:200,json:async()=>({ok:true})});await first;assert.ok(s.controls.every(c=>!c.readOnly));
});
