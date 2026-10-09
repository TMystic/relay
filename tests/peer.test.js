import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const Hyperswarm=require('hyperswarm');
const DHT=require('hyperdht');
const Y=require('yjs');
const {PeerSession,createWorkspace,parseInvite,openSnapshot,validateDoc}=require('../extension/peer-session.cjs');
const {sharedPath}=require('../extension/files.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn) { for(let i=0;i<7500;i++){if(fn())return;await delay(20);}throw new Error('Peer test timed out'); }
async function network() {
 const createTestnet=require('hyperdht/testnet');
 const net=await createTestnet(3);
 return {bootstrap:{destroy:()=>net.destroy()}, factory:()=>new Hyperswarm({dht:net.createNode({firewalled:false}),maxPeers:8}),net};
}

test('real encrypted peers: simultaneous edits, late join, local restart and offline merge', {timeout:60000},async()=>{
 const net=await network(),peers=[],errors=[];
 const config=createWorkspace('Project',{'main.js':'start\n'});
 let cacheA,cacheB;
 function peer(name,options={}) {
  const p=new PeerSession({...config,name},{swarmFactory:net.factory,...options});
  p.on('problem',e=>errors.push(e));peers.push(p);p.connect();return p;
 }
 try {
  const a=peer('Alice',{initialFiles:{'main.js':'start\n'},checkpoint:b=>cacheA=b});
  await a.swarm.flush();
  const b=peer('Bob',{checkpoint:b=>cacheB=b});
  await until(()=>b.ready&&a.members.length===1);
  assert.equal(b.files().get('main.js'),'start\n');
  a.edit('main.js','start\nAlice\n'); b.edit('main.js','start\nBob\n');
  await until(()=>a.files().get('main.js')===b.files().get('main.js') && b.files().get('main.js').includes('Alice')&&b.files().get('main.js').includes('Bob'));
  await b.swarm.flush();
  await a.close();
  const c=peer('Late joiner');
  await until(()=>c.ready&&c.files().get('main.js')===b.files().get('main.js'));
  assert.match(c.files().get('main.js'),/Alice/);
  await b.close();await c.close();
  const offline=new PeerSession({...config,name:'Alice offline'},{cached:cacheA,checkpoint:b=>cacheA=b});peers.push(offline);
  offline.edit('main.js',offline.files().get('main.js')+'offline Alice\n');
  const resumedB=peer('Bob resumed',{cached:cacheB,checkpoint:b=>cacheB=b});
  resumedB.edit('main.js',resumedB.files().get('main.js')+'offline Bob\n');
  await resumedB.swarm.flush();
  const resumedA=peer('Alice resumed',{cached:cacheA});
  await until(()=>resumedA.files().get('main.js')===resumedB.files().get('main.js') && resumedB.files().get('main.js').includes('offline Alice')&&resumedA.files().get('main.js').includes('offline Bob'));
  assert.equal(parseInvite(resumedA.invite()).room,config.room);
  assert.ok(cacheA.subarray(0,4).equals(Buffer.from('RLY1')));
  assert.equal(cacheA.includes(Buffer.from('offline Alice')),false);
  assert.throws(()=>openSnapshot('00'.repeat(32),cacheA));
  assert.deepEqual(errors,[]);
 } finally {await Promise.all(peers.map(p=>p.close()));await net.bootstrap.destroy();}
});
test('all-offline availability is honest; unauthorized peer gets no code', {timeout:30000},async()=>{
 const net=await network(),config=createWorkspace('Secret',{'secret.js':'PRIVATE_SOURCE'});
 let host,attacker,joiner;const rejections=[];
 try {
  host=new PeerSession({...config,name:'Host'},{initialFiles:{'secret.js':'PRIVATE_SOURCE'},swarmFactory:net.factory});
  host.on('problem',e=>rejections.push(e));host.connect();
  attacker=new PeerSession({...config,token:'11'.repeat(32),name:'Attacker'});
  attacker.on('problem',()=>{});
  // Force discovery of the victim while using a different capability.
  attacker.swarmFactory=net.factory;
  attacker.connect();
  await host.swarm.flush();
  attacker.swarm.joinPeer(host.swarm.keyPair.publicKey);
  await until(()=>rejections.some(e=>e.includes('authentication failed')));
  assert.equal(attacker.ready,false);assert.equal(attacker.files().size,0);
  await host.close();
  joiner=new PeerSession({...config,name:'Waiting'},{swarmFactory:net.factory});
  joiner.on('problem',()=>{});joiner.connect();
  await delay(1000);assert.equal(joiner.ready,false);
  assert.throws(()=>joiner.edit('a.js','premature'));
 }finally{await Promise.all([host,attacker,joiner].filter(Boolean).map(p=>p.close()));await net.bootstrap.destroy();}
});
test('reject unsafe paths, Windows collisions, malformed documents, and oversized text',()=>{
 for(const name of ['../escape','.git/hooks/x','.ENV.local','.ssh/id_rsa','.aws/credentials','.backups/source.tar','private.pem','CON.txt','src/LPT1','.npmrc'])assert.equal(sharedPath(name),false,name);
 const config=createWorkspace('Test',{'a.js':'ok'});
 const p=new PeerSession(config,{initialFiles:{'a.js':'ok'}});
 assert.throws(()=>p.edit('A.js','case collision'));
 assert.throws(()=>p.edit('b.js','x'.repeat(512*1024+1)));
 assert.throws(()=>p.edit('../bad','x'));
 assert.equal(p.files().get('a.js'),'ok');
 const doc=new Y.Doc();doc.getMap('files').set('x.js','not a Y.Text');
 assert.throws(()=>validateDoc(doc));doc.destroy();p.close();
 assert.throws(()=>parseInvite('https://relay-bf93.onrender.com/#room=old&token=old'));
});

test('failed storage never acknowledges or applies a remote change; empty cached join stays waiting',async()=>{
 const config=createWorkspace('Test',{'a.js':'before'});
 let cached;
 const waiting=new PeerSession(config,{checkpoint:b=>cached=b});
 const restarted=new PeerSession(config,{cached});
 assert.equal(restarted.ready,false);
 const host=new PeerSession(config,{initialFiles:{'a.js':'before'}});
 const change=new Y.Doc();change.getMap('files').set('a.js',new Y.Text('after'));
 let writes=0;
 const peer={authenticated:true,socket:{destroyed:false,write:()=>writes++}};
 host.checkpoint=()=>{throw new Error('disk full');};
 assert.throws(()=>host.receive(peer,{type:'state',seq:1,update:Buffer.from(Y.encodeStateAsUpdate(change)).toString('base64')}),/disk full/);
 assert.equal(writes,0);assert.equal(host.files().get('a.js'),'before');
 host.checkpoint=undefined;
 change.getMap('files').set('../escape',new Y.Text('hostile'));
 assert.throws(()=>host.receive(peer,{type:'state',seq:1,update:Buffer.from(Y.encodeStateAsUpdate(change)).toString('base64')}),/unsafe/);
 assert.equal(writes,0);assert.equal(host.files().size,1);
 change.destroy();await Promise.all([waiting,restarted,host].map(p=>p.close()));
});

test('dangling symlinks cannot escape; empty reconciliation does not invent files',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {safeTarget,collect}=require('../extension/files.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-path-'));
 try{
  assert.equal(Object.keys((await collect(root,{allowEmpty:true})).files).length,0);
  const outside=path.join(os.tmpdir(),'relay-nonexistent-'+Date.now());
  fs.symlinkSync(outside,path.join(root,'linked.js'));
  assert.throws(()=>safeTarget(root,'linked.js'),/symbolic/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a valid empty peer workspace stays initialized after a restart',async()=>{
 const config=createWorkspace('Empty test',{'a.js':'delete me'});
 let cached;
 const receiver=new PeerSession(config,{checkpoint:b=>cached=b});
 const empty=new Y.Doc();
 const peer={authenticated:true,socket:{destroyed:false,write:()=>true}};
 receiver.receive(peer,{type:'state',seq:0,update:Buffer.from(Y.encodeStateAsUpdate(empty)).toString('base64')});
 assert.equal(receiver.ready,true);
 const resumed=new PeerSession(config,{cached});
 assert.equal(resumed.ready,true);assert.equal(resumed.files().size,0);
 empty.destroy();await Promise.all([receiver,resumed].map(p=>p.close()));
});

test('protocol 2 independent files, safe restores, binary assets and restart', {timeout:60000},async()=>{
 const net=await network(),peers=[];
 const source={'main.js':'function hello() {\n  return 1;\n}\n\n// end\n','image.png':{binary:Buffer.from([0,255,23]).toString('base64')}};
 const config=createWorkspace('Files',source,{protocol:2});
 const blocks=new Map(),chunks=new Map();let cache;
 try {
  const a=new PeerSession({...config,name:'Alice'},{initialFiles:source,swarmFactory:net.factory,
   checkpoint:b=>cache=b,storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r)});peers.push(a);
  const b=new PeerSession({...config,name:'Bob'},{swarmFactory:net.factory,
   storeChunk:(r,o,b)=>chunks.set(r+':'+o,b),loadChunk:(r,o)=>chunks.get(r+':'+o)});peers.push(b);
  a.on('problem',e=>{throw new Error(e);});b.on('problem',e=>{throw new Error(e);});
  a.connect();await a.swarm.flush();b.connect();await until(()=>b.ready);
  assert.deepEqual(b.files().get('image.png'),source['image.png']);
  const bytes=a.metrics.sentBytes;
  a.edit('main.js',source['main.js'].replace('return 1','return 2'));
  await until(()=>b.files().get('main.js').includes('return 2'));
  assert.ok(a.metrics.sentBytes-bytes<2000,'small edit must not resend the project');
  const entry=a.timeline[0];
  assert.deepEqual(a.changeStats(entry),{status:'text',added:1,removed:1});
  assert.deepEqual(b.changeStats(b.timeline[0]),{status:'text',added:1,removed:1});
  a.edit('main.js',a.files().get('main.js')+'\n// newer unrelated change\n');
  const proposal=a.proposal(entry);assert.match(proposal.value,/return 1/);assert.match(proposal.value,/newer unrelated/);
  a.applyProposal(proposal);
  assert.match(a.files().get('main.js'),/return 1/);
  assert.throws(()=>a.applyProposal(proposal),/changed during review/);
  a.edit('main.js',a.files().get('main.js').replace('return 1','return 3'));
  assert.throws(()=>a.proposal(entry),/overlap/);
  a.checkpointProject('Before refactor',{branch:'main',commit:'example'});
  const resumed=new PeerSession(config,{cached:cache,loadBlock:r=>blocks.get(r),storeBlock:(r,b)=>blocks.set(r,b)});peers.push(resumed);
  assert.equal(resumed.checkpoints[0].label,'Before refactor');
  assert.equal(resumed.files().get('main.js'),a.files().get('main.js'));
  assert.equal(parseInvite(a.invite()).protocol,2);
  a.edit('image.png',{binary:Buffer.from([0,255,23,24]).toString('base64')});
  await until(()=>b.files().get('image.png')?.binary===a.files().get('image.png').binary);
  assert.deepEqual(b.changeStats(b.timeline[0]),{status:'binary',beforeBytes:3,afterBytes:4});
  a.edit('main.js',null);
  await until(()=>!b.files().has('main.js'));
  const deleted=b.timeline.find(e=>e.file==='main.js'&&e.deleted);
  assert.ok(deleted);assert.ok(b.changeStats(deleted).removed>0);

 }finally{await Promise.all(peers.map(p=>p.close()));await net.bootstrap.destroy();}
});
test('protocol 2 validates larger sources and receives no acknowledgement on failed storage',async()=>{
 const source={};for(let i=0;i<1200;i++)source['src/file'+i+'.ts']='export const value'+i+' = "'+'x'.repeat(1024)+'";\n';
 const config=createWorkspace('Large',source,{protocol:2});
 const p=new PeerSession(config,{initialFiles:source});
 assert.equal(p.files().size,1200);assert.ok([...p.files().values()].reduce((n,v)=>n+Buffer.byteLength(v),0)>1024*1024);
 assert.throws(()=>p.edit('SRC/File0.ts','collision'),/collide/);
 const id=p.manifest.getMap('files').get('src/file0.ts').id,doc=new Y.Doc();
 Y.applyUpdate(doc,Y.encodeStateAsUpdate(p.documents.get(id)));doc.getText('content').insert(0,'remote');
 let writes=0;p.checkpoint=()=>{throw new Error('disk full');};
 const peer={authenticated:true,name:'Peer',socket:{destroyed:false,write:()=>writes++}};
 assert.throws(()=>p.receive(peer,{type:'file-update',id,seq:1,update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')}),/disk full/);
 assert.equal(writes,0);assert.equal(p.files().get('src/file0.ts'),source['src/file0.ts']);
 doc.destroy();await p.close();
});

test('protocol 2 resumes verified chunks after a disconnected receiver restarts', {timeout:60000},async()=>{
 const crypto=require('node:crypto'),source={'large.bin':{binary:crypto.randomBytes(1024*1024).toString('base64')}};
 const config=createWorkspace('Resume',source,{protocol:2}),net=await network(),peers=[],chunks=new Map();let first,stopped=false;
 try {
  const host=new PeerSession(config,{initialFiles:source,swarmFactory:net.factory});peers.push(host);host.connect();await host.swarm.flush();
  first=new PeerSession(config,{swarmFactory:net.factory,storeChunk:(r,o,b)=>{
   chunks.set(r+':'+o,b);if(!stopped){stopped=true;for(const peer of first.peers)peer.socket.destroy();}
  }});peers.push(first);first.on('problem',()=>{});first.connect();
  await until(()=>stopped);await first.close();
  const resumed=new PeerSession(config,{swarmFactory:net.factory,storeChunk:(r,o,b)=>chunks.set(r+':'+o,b),loadChunk:(r,o)=>chunks.get(r+':'+o)});peers.push(resumed);
  const errors=[];resumed.on('problem',e=>errors.push(e));resumed.connect();await until(()=>resumed.ready);
  assert.ok(resumed.metrics.chunksReused>0);assert.deepEqual(resumed.files().get('large.bin'),source['large.bin']);assert.deepEqual(errors,[]);
 }finally{await Promise.all(peers.map(p=>p.close()));await net.bootstrap.destroy();}
});

test('protocol 2 measures a 2,000-file project and one-file update without rate failures', {timeout:180000},async()=>{
 const {performance}=require('node:perf_hooks'),source={};
 for(let i=0;i<2000;i++)source['src/file'+i+'.ts']='export const file'+i+' = "'+'x'.repeat(2048)+'";\n';
 const net=await network(),peers=[],errors=[],start=performance.now();
 const config=createWorkspace('Performance',source,{protocol:2});
 try {
  const host=new PeerSession(config,{initialFiles:source,swarmFactory:net.factory}),joiner=new PeerSession(config,{swarmFactory:net.factory});
  peers.push(host,joiner);for(const p of peers)p.on('problem',e=>errors.push(e));
  const initialized=performance.now();host.connect();await host.swarm.flush();joiner.connect();await until(()=>joiner.ready);
  const synced=performance.now(),bytes=host.metrics.sentBytes;
  host.edit('src/file100.ts',source['src/file100.ts']+'// change\n');await until(()=>joiner.files().get('src/file100.ts').endsWith('// change\n'));
  const incremental=host.metrics.sentBytes-bytes;
  assert.ok(incremental<2000);assert.equal(joiner.files().size,2000);assert.deepEqual(errors,[]);
  console.log('PERFORMANCE '+JSON.stringify({files:2000,sourceBytes:Object.values(source).reduce((n,v)=>n+Buffer.byteLength(v),0),initializeMs:Math.round(initialized-start),syncMs:Math.round(synced-initialized),editMs:Math.round(performance.now()-synced),incrementalBytes:incremental}));
 }finally{await Promise.all(peers.map(p=>p.close()));await net.bootstrap.destroy();}
});

test('protocol 2 deletion is durable across restart and unsafe manifests never initialize',async()=>{
 const blocks=new Map(),config=createWorkspace('Delete',{'a.js':'one\n','b.js':'two\n'},{protocol:2});let cached;
 const options={storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r),checkpoint:b=>cached=b};
 const host=new PeerSession(config,{...options,initialFiles:{'a.js':'one\n','b.js':'two\n'}});
 host.edit('a.js',null);const restored=new PeerSession(config,{...options,cached});
 assert.equal(restored.files().has('a.js'),false);assert.equal(restored.files().get('b.js'),'two\n');
 const waiting=new PeerSession(config),peer={authenticated:true,name:'Peer',socket:{destroyed:false,write:()=>true}};
 assert.throws(()=>waiting.receive(peer,{type:'manifest',seq:0,offers:[],update:Buffer.from(Y.encodeStateAsUpdate(host.manifest)).toString('base64')}),/Incomplete/);
 assert.equal(waiting.ready,false);
 await Promise.all([host,restored,waiting].map(p=>p.close()));
});

test('Live Changes counts text edits, creations, deletions, binary updates and older cached history',async()=>{
 const {changeStats,changeDescription}=require('../extension/files.cjs');
 const config=createWorkspace('Counts',{'main.js':'one\nsame\n'},{protocol:2});
 const blocks=new Map();let cache;
 const host=new PeerSession(config,{initialFiles:{'main.js':'one\nsame\n'},checkpoint:b=>cache=b,
   storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r)});
 const assertStats=(entry,added,removed)=>assert.deepEqual(host.changeStats(entry),{status:'text',added,removed});
 let resumed;
 try {
  host.edit('main.js','two\nsame\nextra\n');
  const edited=host.timeline[0];assertStats(edited,2,1);
  assert.equal(changeDescription(edited,host.changeStats(edited)),'+2 \u22121');
  host.edit('main.js','two\nsame\n');assertStats(host.timeline[0],0,1);
  host.edit('new.js','new\nfile\n');assertStats(host.timeline[0],2,0);
  assert.match(changeDescription(host.timeline[0],host.changeStats(host.timeline[0])),/Created/);
  host.edit('new.js',null);assertStats(host.timeline[0],0,2);
  host.edit('empty.js','');assertStats(host.timeline[0],0,0);
  assert.match(changeDescription(host.timeline[0],host.changeStats(host.timeline[0])),/Created/);
  host.edit('image.bin',{binary:Buffer.from([0,1,2]).toString('base64')});
  assert.deepEqual(host.changeStats(host.timeline[0]),{status:'binary',beforeBytes:0,afterBytes:3});
  host.edit('image.bin',{binary:Buffer.from([0,1,2,3,4]).toString('base64')});
  assert.equal(changeDescription(host.timeline[0],host.changeStats(host.timeline[0])),'Binary \u00b7 3 \u2192 5 bytes');
  // Simulate a 0.4.0 cache: historical blocks exist but no entry has saved counts.
  for(const entry of host.timeline)delete entry.stats;
  host.persist();
  resumed=new PeerSession(config,{cached:cache,loadBlock:r=>blocks.get(r),storeBlock:(r,b)=>blocks.set(r,b)});
  const previous=resumed.timeline.find(e=>e.id===edited.id);
  assert.deepEqual(resumed.changeStats(previous),{status:'text',added:2,removed:1});
  assert.equal(changeDescription(previous,resumed.changeStats(previous)),'+2 \u22121');
  const unavailable={...previous,beforeRef:'f'.repeat(64)};
  assert.equal(changeDescription(unavailable,resumed.changeStats(unavailable)),'Saved version unavailable');
  assert.deepEqual(changeStats('last line','last line changed'),{status:'text',added:1,removed:1});
  assert.deepEqual(changeStats('a\r\n','a\r\nb\r\n'),{status:'text',added:1,removed:0});
  assert.deepEqual(changeStats('a\n','a\n'),{status:'text',added:0,removed:0});
  const before=Array.from({length:5000},(_,i)=>'old'+i).join('\n');
  const after=Array.from({length:5000},(_,i)=>'new'+i).join('\n');
  assert.equal(changeStats(before,after).status,'complex');
  assert.equal(changeDescription({fileId:'x',stats:{status:'complex'}}),'Large rewrite \u00b7 review diff');
  assert.equal(changeDescription({added:3,removed:2}),'+3 \u22122');
  const durable=host.localDurable;
  assert.throws(()=>host.edit('MAIN.js','collision'),/collide/);
  assert.equal(host.localDurable,durable,'rejected validation does not claim a disk failure');
 }finally{await host.close();await resumed?.close();}
});

test('editor projections preserve fast typing and concurrent peer inserts in both protocols',async()=>{
 const {TextBinding}=require('../extension/peer-session.cjs');
 for(const protocol of [1,2]) {
  const config=createWorkspace('Rapid',{'Main.java':'class Main {\r\n  \r\n}\r\n'},{protocol});
  let writes=0;
  const host=new PeerSession(config,{initialFiles:{'Main.java':'class Main {\r\n  \r\n}\r\n'},checkpoint:()=>writes++});
  const binding=new TextBinding(host.textSnapshot('Main.java'));
  const initialManifest=protocol===2?Y.encodeStateAsUpdate(host.manifest).length:null;
  try {
   const source=binding.text,start=source.indexOf('  ')+2;
   let value=source,offset=start;
   // Native keystrokes update the editor projection without per-keystroke disk writes.
   const prior=writes;
   for(const character of 'System.out.println("hello \uD83D\uDE00");') {
    const change={rangeOffset:offset,rangeLength:0,text:character};
    value=value.slice(0,offset)+character+value.slice(offset);offset+=character.length;
    binding.edit([change],value);
   }
   assert.equal(writes,prior);
   // A teammate changed the live CRDT before the native mirror has run.
   host.edit('Main.java','// teammate marker\r\n'+host.files().get('Main.java'));
   host.applyTextUpdate('Main.java',binding.update(host.textSnapshot('Main.java')),binding.identity);
   assert.equal(host.files().get('Main.java'),'// teammate marker\r\n'+value);
   assert.equal(writes,prior+2,'one teammate edit plus one coalesced local batch');
   if(protocol===2)assert.equal(Y.encodeStateAsUpdate(host.manifest).length,initialManifest,'typing must not grow the file manifest');
   // A mirror can now adopt the merged version, then apply a multi-cursor edit.
   const merged=new TextBinding(host.textSnapshot('Main.java'));
   const before=merged.text;
   const changes=[{rangeOffset:before.length,rangeLength:0,text:'// end\r\n'},
     {rangeOffset:0,rangeLength:0,text:'// first\r\n'}];
   const after='// first\r\n'+before+'// end\r\n';
   merged.edit(changes,after);
   host.applyTextUpdate('Main.java',merged.update(host.textSnapshot('Main.java')),merged.identity);
   assert.equal(host.files().get('Main.java'),after);
   assert.throws(()=>merged.edit([{rangeOffset:99999,rangeLength:0,text:'bad'}],'bad'),/version/);
   host.edit('Main.java',null);host.edit('Main.java','replacement');
   assert.throws(()=>host.applyTextUpdate('Main.java',merged.update(host.textSnapshot('Main.java')),merged.identity),/deleted or replaced/);
   merged.destroy();
  }finally{binding.destroy();await host.close();}
 }
});


test('seeded randomized native projections converge under duplicate and reordered deliveries',async()=>{
 const {TextBinding,sealSnapshot}=require('../extension/peer-session.cjs');
 let seed=0x5eed1234;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
 for(const protocol of [1,2]) {
  const config=createWorkspace('Fuzz',{'main.js':'alpha\r\nbeta\nunicode 😀\r\n'},{protocol});
  const blocks=new Map(),options={storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r)};
  const genesis=new PeerSession(config,{...options,initialFiles:{'main.js':'alpha\r\nbeta\nunicode 😀\r\n'}});
  const cached=sealSnapshot(config.token,genesis.snapshot()),clients=[],bindings=[],updates=[];
  try {
   for(let client=0;client<4;client++) {
    const p=new PeerSession(config,{...options,cached});clients.push(p);
    const binding=new TextBinding(p.textSnapshot('main.js'),client%2?'\r\n':'\n');bindings.push(binding);
    for(let step=0;step<750;step++) {
     const before=binding.text,points=[0];let offset=0;
     for(const point of before.match(/\r\n|[\s\S]/gu)||[]){offset+=point.length;points.push(offset);}
     const startIndex=Math.floor(random()*points.length),endIndex=Math.min(points.length-1,startIndex+Math.floor(random()*4));
     const start=points[startIndex],end=points[endIndex];
     const tokens=['x','😀','é','\t',binding.eol,'','const '],text=tokens[Math.floor(random()*tokens.length)];
     const after=before.slice(0,start)+text+before.slice(end);
     binding.edit([{rangeOffset:start,rangeLength:end-start,text}],after);
     assert.equal(binding.text,after,'projection matches independent string model');
    }
    const beforeInvalid=binding.text;
    assert.throws(()=>binding.edit([{rangeOffset:-1,rangeLength:0,text:'bad'}],'bad'));
    assert.throws(()=>binding.edit([{rangeOffset:0,rangeLength:-1,text:'bad'}],'bad'+beforeInvalid.slice(-1)));
    assert.equal(binding.text,beforeInvalid,'invalid edits are atomic');
    updates.push(binding.update(p.textSnapshot('main.js')));
   }
   const oracle=new Y.Doc();Y.applyUpdate(oracle,genesis.textSnapshot('main.js').update);
   for(const update of updates)Y.applyUpdate(oracle,update);
   const expected=protocol===2?oracle.getText('content').toString():oracle.getMap('files').get('main.js').toString();
   for(const p of clients) {
    const order=[0,1,2,3].sort(()=>random()-.5);
    for(const index of [...order,...order.reverse()])p.applyTextUpdate('main.js',updates[index],p.textIdentity('main.js'));
    assert.equal(p.file('main.js'),expected,'duplicates and delivery order converge');
   }
   oracle.destroy();
  }finally{for(const binding of bindings)binding.destroy();await Promise.all([genesis,...clients].map(p=>p.close()));}
 }
 console.log('FUZZ '+JSON.stringify({seed:'0x5eed1234',protocols:2,clients:4,editorOperations:6000,duplicateDeliveries:true}));
});

test('six encrypted peers survive a burst, departed authors and a late joiner',{timeout:120000},async()=>{
 const {TextBinding}=require('../extension/peer-session.cjs');
 const net=await network(),config=createWorkspace('Mesh',{'main.js':'// mesh genesis\n'},{protocol:2}),peers=[],errors=[],latencies=[];
 const started=performance.now(),rssBefore=process.memoryUsage().rss;
 try {
  for(let i=0;i<6;i++){
   const p=new PeerSession({...config,name:'Peer '+i},{swarmFactory:net.factory,...(i===0?{initialFiles:{'main.js':'// mesh genesis\n'}}:{})});
   p.on('problem',error=>errors.push(error));peers.push(p);p.connect();await p.swarm.flush();await until(()=>p.ready);
  }
  await until(()=>peers.every(p=>[...p.peers].filter(p=>p.authenticated).length>=5));
  for(let step=0;step<40;step++)for(let client=0;client<6;client++){
   const p=peers[client],binding=new TextBinding(p.textSnapshot('main.js')),marker='// peer-'+client+'-edit-'+step+'\n';
   binding.edit([{rangeOffset:binding.text.length,rangeLength:0,text:marker}],binding.text+marker);
   p.applyTextUpdate('main.js',binding.update(p.textSnapshot('main.js')),binding.identity);binding.destroy();
  }
  await until(()=>peers.every(p=>p.file('main.js')===peers[0].file('main.js'))&&peers[0].file('main.js').split('\n').length===242);
  for(let client=0;client<6;client++)for(let step=0;step<40;step++)assert.equal(peers[0].file('main.js').split('// peer-'+client+'-edit-'+step+'\n').length-1,1);
  for(let step=0;step<20;step++){
   const start=performance.now(),value=peers[0].file('main.js')+'// latency-'+step+'\n';
   peers[0].edit('main.js',value);await until(()=>peers.every(p=>p.file('main.js')===value));latencies.push(performance.now()-start);
  }
  const latest=peers[0].file('main.js');await peers[0].close();await peers[1].close();
  const late=new PeerSession({...config,name:'Late client'},{swarmFactory:net.factory});late.on('problem',error=>errors.push(error));peers.push(late);late.connect();
  await until(()=>late.ready&&late.file('main.js')===latest);
  assert.deepEqual(errors,[]);
  const sorted=latencies.sort((a,b)=>a-b);
  console.log('MESH '+JSON.stringify({clients:6,burstEdits:240,latencySamples:20,p50Ms:Math.round(sorted[9]),p95Ms:Math.round(sorted[18]),elapsedMs:Math.round(performance.now()-started),rssDeltaMiB:Math.round((process.memoryUsage().rss-rssBefore)/1048576)}));
 }finally{await Promise.all(peers.map(p=>p.close()));await net.bootstrap.destroy();}
});

test('encrypted caches and blocks reject tampering, truncation, missing data and inflation bombs',async()=>{
 const {sealSnapshot,blockSeal,blockOpen}=require('../extension/peer-session.cjs');
 const config=createWorkspace('Corruption',{'a.js':'sensitive synthetic text'},{protocol:2}),blocks=new Map();
 const p=new PeerSession(config,{initialFiles:{'a.js':'sensitive synthetic text'},storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r)});
 try {
  const cache=sealSnapshot(config.token,p.snapshot()),block=[...blocks.values()][0];
  for(const bytes of [cache,block]) {
   const open=bytes===cache?value=>openSnapshot(config.token,value):value=>blockOpen(config,value);
   for(let offset=0;offset<bytes.length;offset+=Math.max(1,Math.floor(bytes.length/32))){
    const bad=Buffer.from(bytes);bad[offset]^=1;assert.throws(()=>open(bad));
   }
   for(const length of [0,1,4,16,31,bytes.length-1])assert.throws(()=>open(bytes.subarray(0,length)));
  }
  assert.throws(()=>blockOpen({...config,token:'ff'.repeat(32)},block));
  assert.throws(()=>blockOpen({...config,room:'ff'.repeat(16)},block));
  assert.throws(()=>blockOpen(config,blockSeal(config,Buffer.alloc(8*1024*1024+1))),/larger|size|length/i);
  let duplicateWrites=0;p.checkpoint=()=>duplicateWrites++;
  const fileId=p.manifest.getMap('files').get('a.js').id;
  const duplicatePeer={authenticated:true,ack:-1,socket:{destroyed:false,write:()=>true}};
  p.receive(duplicatePeer,{type:'file-update',id:fileId,seq:0,update:Buffer.from(Y.encodeStateAsUpdate(p.documents.get(fileId))).toString('base64')});
  assert.equal(duplicateWrites,0,'already durable duplicate updates do not write another encrypted block');
  assert.equal(p.metrics.duplicateUpdates,1);
  const ref=p.heads[p.manifest.getMap('files').get('a.js').id];
  const original=blocks.get(ref);blocks.set(ref,Buffer.from('corrupt'));
  assert.throws(()=>new PeerSession(config,{cached:cache,loadBlock:r=>blocks.get(r)}),/checksum/);
  blocks.delete(ref);assert.throws(()=>new PeerSession(config,{cached:cache,loadBlock:r=>blocks.get(r)}),/missing/);
  blocks.set(ref,original);const restarted=new PeerSession(config,{cached:cache,loadBlock:r=>blocks.get(r)});
  assert.equal(restarted.file('a.js'),'sensitive synthetic text');await restarted.close();
 }finally{await p.close();}
});

test('framing rejects hostile lengths, malformed data, floods and excess aggregate buffers',async()=>{
 const {EventEmitter}=require('node:events'),crypto=require('node:crypto');
 class Socket extends EventEmitter {
  constructor(){super();this.handshakeHash=crypto.randomBytes(32);this.remotePublicKey=crypto.randomBytes(32);this.destroyed=false;}
  write(){return true;}destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close');}}
  pause(){}resume(){}
 }
 const p=new PeerSession(createWorkspace('Frame test',{'a.js':'safe'}),{initialFiles:{'a.js':'safe'}}),errors=[];
 p.on('problem',error=>errors.push(error));
 const attach=(authenticated=false)=>{const socket=new Socket();p.attach(socket);const peer=[...p.peers].find(peer=>peer.socket===socket);if(peer)peer.authenticated=authenticated;return socket;};
 const frame=value=>{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32BE(bytes.length);return Buffer.concat([head,bytes]);};
 try {
  for(const length of [0,2049,12*1024*1024+1,0xffffffff]){
   const socket=attach(),head=Buffer.alloc(4);head.writeUInt32BE(length);socket.emit('data',head);assert.equal(socket.destroyed,true);assert.equal(p.frameBytes,0);
  }
  for(const payload of ['{bad json','null','{"type":"unknown"}']){
   const socket=attach(true);socket.emit('data',frame(payload));assert.equal(socket.destroyed,true);assert.equal(p.frameBytes,0);
  }
  const fragmented=attach(true),presence=frame({type:'presence',file:'a.js'});
  for(const byte of presence)fragmented.emit('data',Buffer.from([byte]));
  assert.equal(fragmented.destroyed,false);assert.equal(p.frameBytes,0);fragmented.destroy();
  const flood=attach(true);flood.emit('data',Buffer.concat(Array.from({length:241},()=>frame({type:'ack',seq:0}))));
  assert.equal(flood.destroyed,true);assert.ok(errors.some(e=>e.includes('rate')));
  const holders=[];
  for(let i=0;i<5;i++){const socket=attach(true),head=Buffer.alloc(4);head.writeUInt32BE(12*1024*1024);socket.emit('data',head);holders.push(socket);}
  assert.equal(holders[4].destroyed,true);assert.equal(p.frameBytes,48*1024*1024);
  holders.forEach(s=>s.destroy());assert.equal(p.frameBytes,0);
  const sockets=Array.from({length:33},()=>attach());
  assert.equal(sockets[32].destroyed,true);assert.equal(p.peers.size,32);sockets.forEach(s=>s.destroy());
  assert.equal(p.file('a.js'),'safe');
 }finally{await p.close();}
});


test('advertised versions remain transferable after newer edits and history pruning',async()=>{
 const {blockOpen}=require('../extension/peer-session.cjs'),config=createWorkspace('Pinned',{'a.js':'original'},{protocol:2});
 const p=new PeerSession(config,{initialFiles:{'a.js':'original'}}),messages=[];
 const peer={authenticated:true,ack:-1,name:'Slow reader',socket:{destroyed:false,write:bytes=>{messages.push(JSON.parse(bytes.subarray(4).toString()));return true;},destroy(){this.destroyed=true;}}};
 p.peers.add(peer);
 try{
  p.announce(peer);const offer=messages[0].offers[0];
  for(let i=0;i<210;i++)p.edit('a.js','new version '+i);
  p.persist();assert.ok(p.getBlock(offer.ref),'advertised block must survive timeline pruning');
  p.receive(peer,{type:'want',id:offer.id,ref:offer.ref,offset:0});
  const chunk=messages.find(m=>m.type==='chunk'),doc=new Y.Doc();
  Y.applyUpdate(doc,blockOpen(config,Buffer.from(chunk.data,'base64')));
  assert.equal(doc.getText('content').toString(),'original');doc.destroy();
  assert.throws(()=>p.receive(peer,{type:'want',id:'00'.repeat(16),ref:offer.ref,offset:0}),/Unknown/);
 }finally{await p.close();}
});

test('frames arriving together await asynchronous durable receive in order',async()=>{
 const {EventEmitter}=require('node:events'),crypto=require('node:crypto');
 const socket=new EventEmitter();Object.assign(socket,{handshakeHash:crypto.randomBytes(32),remotePublicKey:crypto.randomBytes(32),destroyed:false,
  write:()=>true,pause:()=>{},resume:()=>{},destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close');}}});
 const p=new PeerSession(createWorkspace('Ordered',{'a.js':'safe'}),{initialFiles:{'a.js':'safe'}});
 const calls=[];let release;const gate=new Promise(resolve=>release=resolve);
 p.receive=(_peer,message)=>{calls.push(message.order);return message.order===1?gate:undefined;};
 const frame=order=>{const bytes=Buffer.from(JSON.stringify({type:'test',order})),head=Buffer.alloc(4);head.writeUInt32BE(bytes.length);return Buffer.concat([head,bytes]);};
 try{
  p.attach(socket);const peer=[...p.peers][0];peer.authenticated=true;
  socket.emit('data',Buffer.concat([frame(1),frame(2)]));socket.emit('data',frame(3));
  assert.deepEqual(calls,[1],'later frames must not start before the first durable write finishes');
  release();await delay(10);assert.deepEqual(calls,[1,2,3]);assert.equal(p.frameBytes,0);
 }finally{release();await p.close();}
});


test('exact file and project boundaries reject oversize inputs without changing valid state',async()=>{
 const config=createWorkspace('Limits',{'a.txt':'safe'},{protocol:2}),p=new PeerSession(config,{initialFiles:{'a.txt':'safe'}});
 try {
  p.edit('boundary.txt','x'.repeat(2*1024*1024));
  assert.throws(()=>p.edit('boundary.txt','x'.repeat(2*1024*1024+1)),/2 MB/);
  p.edit('binary.bin',{binary:Buffer.alloc(2*1024*1024).toString('base64')});
  assert.throws(()=>p.edit('binary.bin',{binary:Buffer.alloc(2*1024*1024+1).toString('base64')}),/binary|2 MB/i);
  p.edit('zero-byte.txt','valid');assert.throws(()=>p.edit('zero-byte.txt','invalid\0source'));
  p.edit('café.txt','NFC');assert.throws(()=>p.edit('cafe\u0301.txt','NFD'),/collide/);
  const manifest=new Y.Doc();
  for(let i=0;i<10000;i++)manifest.getMap('files').set('file'+i,{id:i.toString(16).padStart(32,'0'),kind:'text'});
  p.validateManifest(manifest);
  manifest.getMap('files').set('extra',{id:'f'.repeat(32),kind:'text'});
  assert.throws(()=>p.validateManifest(manifest),/10,000/);manifest.destroy();
  for(let i=0;i<5;i++)p.edit('large'+i+'.txt','x'.repeat(2*1024*1024));
  assert.throws(()=>p.edit('overflow.txt','x'.repeat(2*1024*1024)),/16 MB/);
  assert.equal(p.file('a.txt'),'safe');assert.equal(p.hasFile('overflow.txt'),false);
 }finally{await p.close();}
});


test('invisible CRDT rewrites propagate through a peer chain before subsequent replacements',async()=>{
 const {sealSnapshot}=require('../extension/peer-session.cjs'),config=createWorkspace('Chain',{'a.js':'same visible source'},{protocol:2});
 const blocks=new Map(),storage={storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r)};
 const a=new PeerSession(config,{...storage,initialFiles:{'a.js':'same visible source'}}),cached=sealSnapshot(config.token,a.snapshot());
 const b=new PeerSession(config,{...storage,cached}),c=new PeerSession(config,{...storage,cached}),sent=[];
 const incoming={authenticated:true,ack:-1,name:'Upstream',socket:{destroyed:false,write:()=>true}};
 const downstream={authenticated:true,ack:-1,name:'Downstream',socket:{destroyed:false,write:bytes=>{sent.push(JSON.parse(bytes.subarray(4).toString()));return true;},destroy(){this.destroyed=true;}}};
 b.peers.add(downstream);
 try{
  const snapshot=a.textSnapshot('a.js'),rewritten=new Y.Doc();Y.applyUpdate(rewritten,snapshot.update);
  rewritten.getText('content').delete(0,rewritten.getText('content').length);rewritten.getText('content').insert(0,'same visible source');
  a.applyTextUpdate('a.js',Y.encodeStateAsUpdate(rewritten),snapshot.identity);rewritten.destroy();
  const state=a.textSnapshot('a.js');
  b.receive(incoming,{type:'file-update',id:state.identity,seq:a.seq,update:Buffer.from(state.update).toString('base64')});
  const forwarded=sent.find(message=>message.type==='file-update');assert.ok(forwarded,'invisible structural updates must reach downstream peers');
  c.receive(incoming,forwarded);
  const binding=new (require('../extension/peer-session.cjs').TextBinding)(c.textSnapshot('a.js'));
  binding.edit([{rangeOffset:0,rangeLength:4,text:'new'}],'new visible source');
  const update=binding.update(c.textSnapshot('a.js'));c.applyTextUpdate('a.js',update,binding.identity);
  a.receive(incoming,{type:'file-update',id:state.identity,seq:c.seq,update:Buffer.from(update).toString('base64')});
  assert.equal(a.file('a.js'),'new visible source');assert.equal(c.file('a.js'),'new visible source');binding.destroy();
 }finally{await Promise.all([a,b,c].map(p=>p.close()));}
});


test('verified files remain editable during partial transfer and large updates wait for a complete offer',async()=>{
 const {sealSnapshot,CHUNK}=require('../extension/peer-session.cjs'),crypto=require('node:crypto');
 const config=createWorkspace('Background',{'a.js':'base\n'},{protocol:2}),blocks=new Map(),storage={storeBlock:(r,b)=>blocks.set(r,b),loadBlock:r=>blocks.get(r)};
 const host=new PeerSession(config,{...storage,initialFiles:{'a.js':'base\n'}});
 const receiver=new PeerSession(config,{...storage,cached:sealSnapshot(config.token,host.snapshot())});
 const toHost=[],toReceiver=[];
 const socket=messages=>({destroyed:false,write:bytes=>{messages.push(JSON.parse(bytes.subarray(4).toString()));return true;},destroy(){this.destroyed=true;}});
 const sourcePeer={authenticated:true,ack:-1,name:'Source',socket:socket(toHost)},targetPeer={authenticated:true,ack:-1,name:'Receiver',socket:socket(toReceiver)};
 receiver.peers.add(sourcePeer);host.peers.add(targetPeer);
 try{
  host.edit('asset.bin',{binary:crypto.randomBytes(512*1024).toString('base64')});host.edit('asset2.bin',{binary:crypto.randomBytes(256*1024).toString('base64')});host.announce(targetPeer);
  const offer=toReceiver.filter(message=>message.type==='manifest').at(-1);toReceiver.length=0;
  receiver.receive(sourcePeer,offer);assert.equal(receiver.ready,false);assert.equal(receiver.file('a.js'),'base\n');
  receiver.edit('a.js','base\nlocal typing\n');assert.equal(receiver.file('a.js'),'base\nlocal typing\n');
  receiver.edit('a.js','base\nlocal typing\n'+'x'.repeat(CHUNK+1));
  assert.equal(receiver.deferredAnnouncements,true);
  assert.equal(toHost.some(message=>message.type==='manifest'),false,'incomplete offers must never be sent');
  for(let step=0;step<100&&!receiver.ready;step++){
   const message=toHost.shift();assert.ok(message);
   if(message.type==='want'||message.type==='file-update')host.receive(targetPeer,message);
   while(toReceiver.length){
    const reply=toReceiver.shift();if(reply.type==='chunk'||reply.type==='file-update')receiver.receive(sourcePeer,reply);
    if(receiver.file('asset.bin')&&!receiver.file('asset2.bin'))assert.equal(receiver.ready,false,'one finished file cannot mark the whole project ready');
   }
  }
  assert.equal(receiver.ready,true);assert.equal(receiver.deferredAnnouncements,false);
  const complete=toHost.find(message=>message.type==='manifest');assert.ok(complete);
  const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(complete.update,'base64'));
  assert.equal(complete.offers.length,doc.getMap('files').size);doc.destroy();
  assert.ok(receiver.file('a.js').startsWith('base\nlocal typing\n'));assert.ok(receiver.file('asset.bin').binary);
 }finally{await Promise.all([host,receiver].map(p=>p.close()));}
});
