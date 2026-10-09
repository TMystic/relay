import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {handler} from '../supabase/functions/relay-recovery/handler.mjs';
const require=createRequire(import.meta.url);
const Y=require('yjs');
const {PeerSession,createWorkspace,parseInvite}=require('../extension/peer-session.cjs');
const {Recovery,seal,open,capability,endpoint}=require('../extension/recovery.cjs');
const url='https://testproject.supabase.co/functions/v1/relay-recovery';
const config=()=>({...createWorkspace('Test',{'a.js':'base\n'}),recovery:{url,policy:'failure-only'}});
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function mockServer(c) {
 const rows=new Map();const auth=crypto.createHash('sha256').update(capability(c)).digest('hex');
 const seen=[];
 const serve=handler({url:'https://internal.invalid',key:'SERVER_ONLY',fetchImpl:async(_url,options)=>{
  const req=JSON.parse(options.body);seen.push(req);
  if(req.p_auth!==auth)return Response.json({message:'Unauthorized'},{status:400});
  if(req.p_op==='list')return Response.json({copies:[...rows.values()].map(({device,version})=>({device,version}))});
  if(req.p_op==='get')return Response.json(rows.get(req.p_device));
  if(req.p_op==='put') {
   if((rows.get(req.p_device)?.version||null)!==req.p_previous)return Response.json({message:'Conflict'},{status:400});
   rows.set(req.p_device,{device:req.p_device,version:req.p_version,cipher:req.p_cipher});
   return Response.json({ok:true});
  }
  return Response.json({ok:true});
 }});
 return {rows,seen,fetchImpl:(_url,options)=>serve(new Request(url,options))};
}
test('cloud copies are encrypted with a separate key; invites carry no setup/server secret',()=>{
 const c=config(),p=new PeerSession(c,{initialFiles:{'a.js':'PRIVATE_SOURCE'}});
 const bytes=seal(c,p.snapshot());
 assert.equal(bytes.includes(Buffer.from('PRIVATE_SOURCE')),false);
 assert.equal(open(c,bytes).state,p.snapshot().state);
 assert.throws(()=>open({...c,token:capability(c)},bytes));
 assert.throws(()=>open({...c,room:'11'.repeat(16)},bytes));
 const altered=Buffer.from(bytes);altered[20]^=1;assert.throws(()=>open(c,altered));
 assert.deepEqual(parseInvite(p.invite()).recovery,c.recovery);
 assert.throws(()=>endpoint('https://attacker.invalid/functions/v1/relay-recovery'));
 assert.throws(()=>endpoint(url+'?key=secret'));
 p.close();
});
test('healthy durable peers upload no source; initial recovery check and missing-peer fallback',async()=>{
 const c=config();let reads=0,saves=0;
 const p=new PeerSession(c,{initialFiles:{'a.js':'base\n'},checkpoint:()=>{},
  recovery:{read:async()=>{reads++;return [];},save:async()=>{saves++;},close:()=>{}}});
 try {
  const peer={authenticated:true,ack:0,socket:{destroy:()=>{},destroyed:false,write:()=>true}};
  p.peers.add(peer);await p.recoverNow();assert.equal(reads,1);assert.equal(saves,0);
  p.edit('a.js','base\nchange\n');peer.ack=p.seq;
  await p.recoverNow();assert.equal(reads,1);assert.equal(saves,0);
  p.peers.delete(peer);await p.recoverNow();assert.equal(reads,2);assert.equal(saves,1);
 }finally{await p.close();}
});
test('disk-full edits stay in memory; status confirms cloud only after successful persistence',async()=>{
 const c=config(),gate=deferred();let stored;
 const p=new PeerSession(c,{initialFiles:{'a.js':'base\n'},checkpoint:()=>{},
  recovery:{save:async snapshot=>{await gate.promise;stored=snapshot;},read:async()=>[],close:()=>{}}});
 const statuses=[];p.on('status',s=>statuses.push(s));
 try {
  p.checkpoint=()=>{throw new Error('disk full');};
  p.edit('a.js','new edit\n');
  assert.equal(p.files().get('a.js'),'new edit\n');
  assert.match(statuses.at(-1),/Not safely saved/);
  gate.resolve();await p.saveFlight;
  assert.equal(stored.state,p.snapshot().state);
  assert.match(statuses.at(-1),/Saved to encrypted recovery/);
 }finally{await p.close();}
});
test('remote ACK waits for cloud durability, including local edits made during upload',async()=>{
 const c=config(),waits=[];
 const p=new PeerSession(c,{initialFiles:{'a.js':'base\n'},checkpoint:()=>{},
  recovery:{save:()=>{const gate=deferred();waits.push(gate);return gate.promise;},read:async()=>[],close:()=>{}}});
 const doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(p.doc));doc.getMap('files').get('a.js').insert(5,'REMOTE\n');
 let writes=0;const peer={authenticated:true,socket:{destroyed:false,write:()=>{writes++;return true;}}};
 try {
  p.checkpoint=()=>{throw new Error('disk full');};
  const received=p.receive(peer,{type:'state',seq:1,update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});
  assert.equal(writes,0);assert.equal(p.files().get('a.js'),'base\n');
  p.edit('a.js','LOCAL\nbase\n');
  waits[0].resolve();await tick();
  assert.equal(writes,0);assert.equal(waits.length,3);
  waits[1].resolve();waits[2].resolve();await received;await tick();
  assert.equal(writes,1);
  assert.match(p.files().get('a.js'),/LOCAL/);assert.match(p.files().get('a.js'),/REMOTE/);
 }finally{doc.destroy();await p.close();}
});
test('failure of both stores never acknowledges or applies incoming edits',async()=>{
 const c=config();
 const p=new PeerSession(c,{initialFiles:{'a.js':'base\n'},checkpoint:()=>{},
  recovery:{save:async()=>{throw new Error('network down');},read:async()=>[],close:()=>{}}});
 const doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(p.doc));doc.getMap('files').get('a.js').insert(0,'remote\n');
 let writes=0;const peer={authenticated:true,socket:{destroyed:false,write:()=>{writes++;}}};
 try {
  p.checkpoint=()=>{throw new Error('disk full');};
  await assert.rejects(p.receive(peer,{type:'state',seq:1,update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')}),/network down/);
  assert.equal(writes,0);assert.equal(p.files().get('a.js'),'base\n');
 }finally{doc.destroy();await p.close();}
});
test('recover all device copies, merge offline edits, and preserve a previous slot on stale restart',async()=>{
 const c=config(),server=mockServer(c),base=new PeerSession(c,{initialFiles:{'a.js':'base\n'}});
 const cached=require('../extension/peer-session.cjs').sealSnapshot(c.token,base.snapshot());
 const a=new PeerSession(c,{cached}),b=new PeerSession(c,{cached});
 const ca=new Recovery({...c,recoveryDevice:'aa'.repeat(16)},{fetchImpl:server.fetchImpl});
 const cb=new Recovery({...c,recoveryDevice:'bb'.repeat(16)},{fetchImpl:server.fetchImpl});
 let restored;
 try {
  a.edit('a.js','Alice\nbase\n');b.edit('a.js','base\nBob\n');
  await ca.save(a.snapshot());await cb.save(b.snapshot());
  assert.equal(server.rows.size,2);
  for(const row of server.rows.values())assert.equal(Buffer.from(row.cipher,'base64').includes(Buffer.from('Alice')),false);
  // Restart Alice from an older cache. Updating the same cloud slot must retain Alice's cloud-only edit.
  const stale=new PeerSession(c,{cached});
  stale.edit('a.js','base\nRestart\n');
  const restarted=new Recovery({...c,recoveryDevice:'aa'.repeat(16)},{fetchImpl:server.fetchImpl});
  await restarted.save(stale.snapshot());await stale.close();restarted.close();
  restored=new PeerSession(c,{recovery:ca,checkpoint:()=>{}});
  await restored.recoverNow();
  assert.equal(restored.ready,true);
  const text=restored.files().get('a.js');
  for(const part of ['Alice','Bob','Restart'])assert.match(text,new RegExp(part));
  assert.equal(server.seen.some(x=>JSON.stringify(x).includes('SERVER_ONLY')),false);
 }finally{await Promise.all([base,a,b,restored].filter(Boolean).map(p=>p.close()));ca.close();cb.close();}
});
test('custom-auth function rejects unauthenticated calls before database access',async()=>{
 let calls=0;const serve=handler({url:'https://internal.invalid',key:'SERVER_ONLY',fetchImpl:async()=>{calls++;return Response.json({});}});
 const response=await serve(new Request(url,{method:'POST',body:'{}'}));
 assert.equal(response.status,401);assert.equal(calls,0);
 const malformed=await serve(new Request(url,{method:'POST',headers:{Authorization:'Bearer '+'11'.repeat(32)},body:JSON.stringify({op:'put',room:'22'.repeat(16),device:'33'.repeat(16),version:'44'.repeat(32),previous:null,cipher:'invalid'})}));
 assert.equal(malformed.status,400);assert.equal(calls,0);
});
test('malicious recovery documents are rejected without changing local files',async()=>{
 const c=config(),doc=new Y.Doc();doc.getMap('files').set('../escape.js',new Y.Text('hostile'));
 const p=new PeerSession(c,{initialFiles:{'a.js':'safe'},checkpoint:()=>{},
  recovery:{read:async()=>[{initialized:true,state:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')}],save:async()=>{},close:()=>{}}});
 const errors=[];p.on('problem',e=>errors.push(e));
 try{await p.recoverNow();assert.equal(p.files().get('a.js'),'safe');assert.equal(p.files().size,1);assert.match(errors[0],/unsafe/);}
 finally{doc.destroy();await p.close();}
});

test('pure deletions during a cloud write also require a newly durable merged checkpoint',async()=>{
 const c=config(),waits=[];
 const p=new PeerSession(c,{initialFiles:{'a.js':'base\\n'},checkpoint:()=>{},
  recovery:{save:()=>{const gate=deferred();waits.push(gate);return gate.promise;},read:async()=>[],close:()=>{}}});
 const doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(p.doc));doc.getMap('files').get('a.js').insert(0,'REMOTE\\n');
 let writes=0;const peer={authenticated:true,socket:{destroyed:false,write:()=>{writes++;return true;}}};
 try {
  p.checkpoint=()=>{throw new Error('disk full');};
  const received=p.receive(peer,{type:'state',seq:1,update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});
  p.edit('a.js',null);
  waits[0].resolve();await tick();
  assert.equal(writes,0);assert.equal(waits.length,3);
  waits[1].resolve();waits[2].resolve();await received;await tick();
  assert.equal(writes,1);assert.equal(p.files().has('a.js'),false);
 }finally{doc.destroy();await p.close();}
});

test('protocol 2 multipart recovery merges offline edits and preserves the previous bank on interrupted upload',async()=>{
 const c={...createWorkspace('Files',{'a.js':'base\n'},{protocol:2}),recovery:{url,policy:'failure-only'},recoveryDevice:crypto.randomBytes(16).toString('hex')};
 const server=mockServer(c),client=new Recovery(c,{fetchImpl:server.fetchImpl});
 const blocks=new Map();let cached;
 const host=new PeerSession(c,{initialFiles:{'a.js':'base\n'},storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r),checkpoint:b=>cached=b,recovery:client});
 const stale=cached;
 try {
  await host.recoverNow();assert.equal(server.rows.size,2);
  host.edit('a.js','base\nAlice\n');await host.saveLatest();
  const old=new PeerSession({...c,recovery:undefined},{cached:stale,loadBlock:r=>blocks.get(r),storeBlock:(r,b)=>blocks.set(r,b)});
  try{old.edit('a.js','Bob\nbase\n');await client.save(old.archive());}finally{await old.close();}
  const archive=(await client.read())[0];
  const fresh=new PeerSession({...c,recovery:undefined});
  try {
   const merged=require('../extension/peer-session.cjs').mergeArchives(c,fresh.archive(),archive);
   for(const [r,b] of Object.entries(merged.blocks))fresh.blocks.set(r,Buffer.from(b,'base64'));
   Y.applyUpdate(fresh.manifest,Buffer.from(merged.manifest,'base64'));
   for(const [id,ref] of Object.entries(merged.heads))fresh.install(id,fresh.getBlock(ref));
   assert.match(fresh.files().get('a.js'),/Alice/);assert.match(fresh.files().get('a.js'),/Bob/);
  }finally{await fresh.close();}
  const original=client.request.bind(client);let interrupted=true;
  client.request=async(op,extra)=>{if(interrupted&&op==='put'&&extra.device===client.device){interrupted=false;throw new Error('Disconnected before index publish');}return original(op,extra);};
  host.edit('a.js','base\nunpublished\n');
  await assert.rejects(client.save(host.archive()),/Disconnected/);
  const retained=(await client.read())[0];
  assert.equal(retained.initialized,true);
  assert.ok(server.rows.size<=3,'two banks and one published index stay bounded');
 }finally{await host.close();client.close();}
});
test('protocol 2 acknowledgement waits for cloud storage and detects intervening local changes',async()=>{
 const c={...createWorkspace('Files',{'a.js':'base\n'},{protocol:2}),recovery:{url,policy:'failure-only'}};
 const gates=[],p=new PeerSession(c,{initialFiles:{'a.js':'base\n'},checkpoint:()=>{},recovery:{save:()=>{const gate=deferred();gates.push(gate);return gate.promise;},read:async()=>[],close:()=>{}}});
 const id=p.manifest.getMap('files').get('a.js').id,doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(p.documents.get(id)));doc.getText('content').insert(0,'REMOTE\n');
 let writes=0;const peer={authenticated:true,name:'Peer',socket:{destroyed:false,write:()=>{writes++;return true;}}};
 try {
  p.checkpoint=()=>{throw new Error('disk full');};
  const flight=p.receive(peer,{type:'file-update',id,seq:1,update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});
  assert.equal(writes,0);p.edit('a.js','LOCAL\nbase\n');gates[0].resolve();await tick();
  assert.equal(writes,0);assert.ok(gates.length>=3);for(const gate of gates)gate.resolve();await flight;
  assert.equal(writes,1);assert.match(p.files().get('a.js'),/REMOTE/);assert.match(p.files().get('a.js'),/LOCAL/);
 }finally{doc.destroy();for(const gate of gates)gate.resolve();await p.close();}
});

test('protocol 2 recovery does not mistake a downloaded copy for uploading locally merged edits',async()=>{
 const c={...createWorkspace('Files',{'a.js':'base\n'},{protocol:2}),recovery:{url,policy:'failure-only'}};
 const server=mockServer(c),blocks=new Map();let cached;
 const storage={storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r)};
 const first=new PeerSession(c,{...storage,initialFiles:{'a.js':'base\n'},checkpoint:b=>cached=b,recovery:new Recovery(c,{fetchImpl:server.fetchImpl})});
 const second=new PeerSession(c,{...storage,cached,checkpoint:()=>{},recovery:new Recovery(c,{fetchImpl:server.fetchImpl})});
 try {
  first.edit('a.js','Alice\nbase\n');await first.recoverNow();
  second.edit('a.js','base\nBob\n');await second.recoverNow();
  const late=new PeerSession(c,{recovery:new Recovery(c,{fetchImpl:server.fetchImpl})});
  try {await late.recoverNow();assert.match(late.files().get('a.js'),/Alice/);assert.match(late.files().get('a.js'),/Bob/);}
  finally{await late.close();}
 }finally{await first.close();await second.close();}
});

test('protocol 2 startup with both storage paths unavailable keeps source in memory',async()=>{
 const c={...createWorkspace('Failure',{'a.js':'unsaved source\n'},{protocol:2}),recovery:{url,policy:'failure-only'}};
 const p=new PeerSession(c,{initialFiles:{'a.js':'unsaved source\n'},checkpoint:()=>{throw new Error('disk full');},
  recovery:{save:async()=>{throw new Error('service offline');},read:async()=>[],close:()=>{}}});
 p.on('problem',()=>{});await tick();
 assert.equal(p.localDurable,false);assert.equal(p.files().get('a.js'),'unsaved source\n');await p.close();
});


test('recovery API rejects malformed and oversized bodies and never exposes private database errors',async()=>{
 const c=config(),bytes=seal(c,{initialized:true,state:'AA==',history:[]}),cipher=bytes.toString('base64');
 const valid={op:'put',room:c.room,device:'ab'.repeat(16),version:crypto.createHash('sha256').update(bytes).digest('hex'),previous:null,cipher};
 const headers={Authorization:'Bearer '+'11'.repeat(32),'Content-Type':'application/json'};
 let calls=0;const serve=handler({url:'https://internal.invalid',key:'SERVER_ONLY',fetchImpl:async()=>{calls++;return Response.json({ok:true});}});
 for(const body of ['null','[1,2]','{broken',JSON.stringify({...valid,op:'delete'}),JSON.stringify({...valid,device:'../bad'}),JSON.stringify({...valid,version:'00'.repeat(32)}),JSON.stringify({...valid,cipher:'bad%%'})]){
  assert.equal((await serve(new Request(url,{method:'POST',headers,body}))).status,400);assert.equal(calls,0);
 }
 assert.equal((await serve(new Request(url,{method:'GET'}))).status,405);
 let cancelled=false,sent=0;
 const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));if(++sent===20)controller.close();},cancel(){cancelled=true;}});
 assert.equal((await serve(new Request(url,{method:'POST',headers,body:stream,duplex:'half'}))).status,400);
 assert.equal(calls,0);assert.equal(cancelled,true);
 for(const [message,status] of [['Unauthorized',401],['Conflict',409],['Capacity exceeded',507],['PRIVATE_SQL_AND_SERVER_SECRET',503]]){
  const failure=handler({url:'https://internal.invalid',key:'SERVER_ONLY',fetchImpl:async()=>Response.json({message},{status:400})});
  const response=await failure(new Request(url,{method:'POST',headers,body:JSON.stringify(valid)}));
  assert.equal(response.status,status);const text=await response.text();
  assert.equal(text.includes('PRIVATE_SQL'),false);assert.equal(text.includes('SERVER_ONLY'),false);
 }
 const success=await serve(new Request(url,{method:'POST',headers,body:JSON.stringify(valid)}));
 assert.equal(success.status,200);assert.equal(success.headers.get('Cache-Control'),'no-store');
});
