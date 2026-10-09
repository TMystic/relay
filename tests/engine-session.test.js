import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {startServer} from '../legacy/server/index.js';
const require=createRequire(import.meta.url);
const {Session,publish,parseInvite}=require('../legacy/cloud-session.cjs');
const {collect,safeTarget,sharedPath,writeSharedFile}=require('../extension/files.cjs');
test('native client publishes a real folder, converges concurrent edits, and merges cached offline edits',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-engine-client-'));
 const records=new Map(),storage={loadAll:async()=>[...records.values()],save:async room=>records.set(room.id,structuredClone(room))};
 const peers=[];let server;
 try{
  server=await startServer({port:0,dataDir:directory,hosted:true,storage});
  const origin=`http://127.0.0.1:${server.port}`;
  const config=await publish(origin,'Real project',{'src/a b.js':'export const value = 1;\n','README.md':'# Native project\n'});
  const a=new Session({...config,name:'Alice'}),b=new Session({...config,name:'Bob'});peers.push(a,b);
  a.connect();b.connect();await until(()=>a.ready&&b.ready);
  assert.equal(a.files().size,2);
  const baseline=a.files().get('src/a b.js');
  a.edit('src/a b.js',baseline+'// Alice\n');b.edit('src/a b.js',baseline+'// Bob\n');
  await until(()=>a.files().get('src/a b.js')===b.files().get('src/a b.js')&&a.files().get('src/a b.js').includes('Alice')&&a.files().get('src/a b.js').includes('Bob'));
  await until(()=>a.ack>=a.seq&&b.ack>=b.seq);
  let cached;
  const offline=new Session({...config,name:'Offline'},{cached:Buffer.from(require('yjs').encodeStateAsUpdate(a.doc)),checkpoint:bytes=>cached=bytes});peers.push(offline);
  offline.edit('README.md','# Native project\nOffline change\n');
  a.edit('README.md',a.files().get('README.md')+'Online change\n');await until(()=>a.ack>=a.seq);
  const resumed=new Session({...config,name:'Resumed'},{cached});peers.push(resumed);resumed.connect();
  await until(()=>resumed.ready&&resumed.files().get('README.md').includes('Offline change')&&resumed.files().get('README.md').includes('Online change'));
  await until(()=>a.files().get('README.md')===resumed.files().get('README.md'));
  assert.equal(parseInvite(resumed.invite()).room,config.room);
 }finally{peers.forEach(p=>p.close());if(server)await server.close();fs.rmSync(directory,{recursive:true,force:true});}
});
test('project collection excludes secrets, generated files and symlinks; remote paths cannot escape the folder',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-engine-files-'));
 try{
  fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/main.js'),'export const ok = true;\n');
  fs.writeFileSync(path.join(root,'.env'),'PRIVATE=not-shared');fs.mkdirSync(path.join(root,'node_modules'));fs.writeFileSync(path.join(root,'node_modules/generated.js'),'not-shared');
  fs.writeFileSync(path.join(root,'binary.dat'),Buffer.from([0,1,2]));
  const result=await collect(root);assert.deepEqual(Object.keys(result.files),['src/main.js']);
  assert.throws(()=>safeTarget(root,'../escape.js'));assert.throws(()=>safeTarget(root,'.git/hooks/post-checkout'));
  assert.equal(sharedPath('new folder/a b.js'),true);
  assert.equal(sharedPath('.env.local'),false);
  assert.throws(()=>parseInvite('https://example.com/#room=short&token=short'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
async function until(condition){for(let n=0;n<250;n++){if(condition())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Native client timed out');}


test('selective collection preserves binary bytes and excludes nested globs and private paths',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-selective-'));
 try{
  fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'private'));fs.mkdirSync(path.join(root,'assets'));
  fs.writeFileSync(path.join(root,'src/kept.ts'),'export const kept = true;\n');
  fs.writeFileSync(path.join(root,'src/generated.log'),'excluded log');
  fs.writeFileSync(path.join(root,'private/notes.txt'),'synthetic private');
  const bytes=Buffer.from([0,255,1,128]);fs.writeFileSync(path.join(root,'assets/raw.bin'),bytes);
  const filtered=await collect(root,{large:true,binary:true,exclude:['private/**','**/*.log']});
  assert.deepEqual(Object.keys(filtered.files).sort(),['assets/raw.bin','src/kept.ts']);
  assert.deepEqual(filtered.files['assets/raw.bin'],{binary:bytes.toString('base64')});
  const textOnly=await collect(root,{large:true,binary:false,exclude:['private/**','**/*.log']});
  assert.deepEqual(Object.keys(textOnly.files),['src/kept.ts']);
  const link=path.join(root,'src/linked');fs.symlinkSync(path.join(root,'private'),link);
  assert.throws(()=>safeTarget(root,'src/linked/notes.txt'),/symbolic/);
  assert.equal((await collect(root,{large:true,binary:true,exclude:['private/**','**/*.log']})).files['src/linked/notes.txt'],undefined);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function isolatedMirror(documents=[]) {
 const vm=require('node:vm');
 const extensionRequire=createRequire(path.join(process.cwd(),'extension/extension.cjs'));
 const vscode={workspace:{textDocuments:documents,fs:{delete:async()=>{}}},window:{showErrorMessage:()=>{}},Uri:{file:filename=>({fsPath:filename,toString:()=>filename})}};
 const module={exports:{}};
 const source=fs.readFileSync(path.join(process.cwd(),'extension/extension.cjs'),'utf8');
 vm.runInNewContext(source+'\nmodule.exports.testMirror={mirror,readDiskChange,rememberDiskState,setActive:value=>{active=value;}};',{
   require:name=>name==='vscode'?vscode:extensionRequire(name),module,Buffer,TextDecoder,TextEncoder,process,setTimeout,clearTimeout,console
 },{filename:'relay-isolated-mirror.cjs'});
 return module.exports.testMirror;
}
async function materializeFixture(root,name,value) {
 const fixture=isolatedMirror();
 const session={config:{sharing:{}},mirrorAll:true,baseline:{},files:()=>new Map([[name,value]]),
   file:()=>value,hasFile:()=>true,persist:()=>{},closed:false};
 fixture.setActive(session);await fixture.mirror(root,session);
}
test('incoming binary writes cannot follow a pre-existing temporary-file symlink',async()=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'relay-binary-write-security-'));
 const root=path.join(fixture,'workspace'),outside=path.join(fixture,'outside.txt');fs.mkdirSync(root);
 try {
   fs.writeFileSync(outside,'synthetic outside content');
   fs.symlinkSync(outside,path.join(root,'asset.bin.relay-tmp'));
   const bytes=Buffer.from([0,255,128,1]);
   await materializeFixture(root,'asset.bin',{binary:bytes.toString('base64')});
   assert.equal(fs.readFileSync(outside,'utf8'),'synthetic outside content','incoming binary data must not modify the symlink destination');
   assert.deepEqual(fs.readFileSync(path.join(root,'asset.bin')),bytes);
 } finally {fs.rmSync(fixture,{recursive:true,force:true});}
});
test('incoming text replaces a hard-linked shared file without modifying its outside alias',async()=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'relay-text-write-security-'));
 const root=path.join(fixture,'workspace'),outside=path.join(fixture,'outside.txt');fs.mkdirSync(root);
 try {
   fs.writeFileSync(outside,'synthetic outside content');
   fs.linkSync(outside,path.join(root,'shared.txt'));
   await materializeFixture(root,'shared.txt','teammate update\n');
   assert.equal(fs.readFileSync(outside,'utf8'),'synthetic outside content','incoming text must not overwrite a hard-linked outside alias');
   assert.equal(fs.readFileSync(path.join(root,'shared.txt'),'utf8'),'teammate update\n');
 } finally {fs.rmSync(fixture,{recursive:true,force:true});}
});

test('failed durable file writes retain the prior contents and clean temporary files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-write-failure-'));
 const target=path.join(root,'kept.txt');fs.writeFileSync(target,'previous complete content');
 const sync=fs.fsyncSync;
 try {
   fs.fsyncSync=()=>{const error=new Error('Synthetic disk full');error.code='ENOSPC';throw error;};
   assert.throws(()=>writeSharedFile(root,'kept.txt',Buffer.from('incomplete replacement')),/Synthetic disk full/);
   assert.equal(fs.readFileSync(target,'utf8'),'previous complete content');
   assert.deepEqual(fs.readdirSync(root),['kept.txt']);
 } finally {fs.fsyncSync=sync;fs.rmSync(root,{recursive:true,force:true});}
});
test('atomic shared writes preserve executable permissions and exclude internal temporary names',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-write-modes-'));
 try {
   const target=path.join(root,'tool.sh');fs.writeFileSync(target,'old');fs.chmodSync(target,0o755);
   writeSharedFile(root,'tool.sh',Buffer.from('#!/bin/sh\necho updated\n'));
   if(process.platform!=='win32')assert.equal(fs.statSync(target).mode & 0o777,0o755);
   const temp='.relay-write-12345678-1234-1234-1234-123456789abc.tmp';fs.writeFileSync(path.join(root,temp),'not shared');
   assert.equal(sharedPath(temp),false);
   assert.deepEqual(Object.keys((await collect(root)).files),['tool.sh']);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('an occupied atomic temporary path is rejected without modifying or removing the existing link',()=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'relay-write-collision-'));
 const root=path.join(fixture,'workspace'),outside=path.join(fixture,'outside.txt');fs.mkdirSync(root);
 const crypto=require('node:crypto'),uuid=crypto.randomUUID;
 try {
   fs.writeFileSync(outside,'synthetic outside content');fs.writeFileSync(path.join(root,'kept.txt'),'kept');
   crypto.randomUUID=()=> '12345678-1234-1234-1234-123456789abc';
   const temp=path.join(root,'.relay-write-'+crypto.randomUUID()+'.tmp');fs.symlinkSync(outside,temp);
   assert.throws(()=>writeSharedFile(root,'kept.txt',Buffer.from('replacement')),error=>error.code==='EEXIST'||error.code==='ELOOP');
   assert.equal(fs.readFileSync(outside,'utf8'),'synthetic outside content');
   assert.equal(fs.readFileSync(path.join(root,'kept.txt'),'utf8'),'kept');
   assert.ok(fs.lstatSync(temp).isSymbolicLink());
 } finally {crypto.randomUUID=uuid;fs.rmSync(fixture,{recursive:true,force:true});}
});

test('external tool rewrites of a dirty Java buffer reach shared state without restart',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-external-java-'));
 const name='test.java',target=path.join(root,name),initial='class test {\n}\n',generated='class test {\n  void generated() {}\n}\n';
 const {PeerSession,createWorkspace,hash}=require('../extension/peer-session.cjs');
 const config=createWorkspace('External writer fixture',{[name]:initial},{protocol:2});
 const session=new PeerSession(config,{initialFiles:{[name]:initial}});
 const document={uri:{fsPath:target,toString:()=>target},isDirty:true,getText:()=>initial};
 const fixture=isolatedMirror([document]);
 fs.writeFileSync(target,initial);session.baseline[name]=hash(initial);fixture.rememberDiskState(session,name,initial);
 try {
   fs.writeFileSync(target,generated);
   await fixture.readDiskChange(root,session,document.uri);
   assert.equal(session.file(name),generated,'an external tool rewrite must not be discarded because Relay left the native buffer dirty');
 } finally {await session.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('external tool edits merge with concurrent unsaved typing using the saved disk ancestry',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-external-concurrent-'));
 const name='test.java',target=path.join(root,name),initial='class test {\n}\n';
 const {PeerSession,createWorkspace,hash}=require('../extension/peer-session.cjs');
 const session=new PeerSession(createWorkspace('External concurrent',{[name]:initial},{protocol:2}),{initialFiles:{[name]:initial}});
 let native=initial;const document={uri:{fsPath:target,toString:()=>target},isDirty:true,getText:()=>native};
 const fixture=isolatedMirror([document]);fs.writeFileSync(target,initial);session.baseline[name]=hash(initial);fixture.rememberDiskState(session,name,initial);
 try {
   native='// concurrent local typing\n'+initial;session.edit(name,native);
   const external='class test {\n  void generated() {}\n}\n';fs.writeFileSync(target,external);
   assert.equal(await fixture.readDiskChange(root,session,document.uri),true);
   assert.match(session.file(name),/concurrent local typing/);
   assert.match(session.file(name),/void generated/);
   fs.writeFileSync(target,external.replace('generated','generatedAgain'));
   assert.equal(await fixture.readDiskChange(root,session,document.uri),true);
   assert.match(session.file(name),/concurrent local typing/);assert.match(session.file(name),/generatedAgain/);
 }finally{await session.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('an external overwrite without reliable ancestry preserves both copies and requires review',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-external-conflict-'));
 const name='test.java',target=path.join(root,name),initial='class test {}\n',local='// unsaved newer work\n'+initial,external='class generated {}\n';
 const {PeerSession,createWorkspace,hash}=require('../extension/peer-session.cjs');
 const session=new PeerSession(createWorkspace('External guarded',{[name]:initial},{protocol:2}),{initialFiles:{[name]:initial}});
 const fixture=isolatedMirror([{uri:{fsPath:target,toString:()=>target},isDirty:true,getText:()=>local}]);
 try {
   session.baseline[name]=hash(initial);session.edit(name,local);fs.writeFileSync(target,external);
   assert.equal(await fixture.readDiskChange(root,session,{fsPath:target,toString:()=>target}),false);
   assert.equal(session.file(name),local);assert.equal(fs.readFileSync(target,'utf8'),external);
   assert.ok(session.externalConflicts.has(name));
 }finally{await session.close();fs.rmSync(root,{recursive:true,force:true});}
});


function isolatedCodeChecks(symbols=true) {
 const vm=require('node:vm'),extensionRequire=createRequire(path.join(process.cwd(),'extension/extension.cjs'));
 const timers=new Map();let next=0,content='class Test {\n  run() { return 1; }\n}\n';
 class Range {
   constructor(a,b,c,d){this.start=typeof a==='number'?{line:a,character:b}:a;this.end=typeof a==='number'?{line:c,character:d}:b;}
   intersection(other){const before=(a,b)=>a.line<b.line||(a.line===b.line&&a.character<b.character);return before(this.end,other.start)||before(other.end,this.start)?undefined:this;}
 }
 const document={positionAt:offset=>{const lines=content.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};}};
 const vscode={Range,SymbolKind:{Function:1,Method:2,Constructor:3},
   Uri:{file:filename=>({fsPath:filename,toString:()=>filename})},
   workspace:{openTextDocument:async()=>document},window:{showErrorMessage:message=>{throw new Error(message);}},
   languages:{getDiagnostics:()=>{throw new Error('Code Checks must not read compiler diagnostics');}},
   commands:{executeCommand:async()=>symbols?[{name:'run',kind:2,range:new Range(1,2,1,24)}]:[]}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(process.cwd(),'extension/extension.cjs'),'utf8')+
   '\nmodule.exports.testChecks={scheduleCodeCheck,codeIssues,setActive:value=>{active=value;}};',
   {require:name=>name==='vscode'?vscode:extensionRequire(name),module,Buffer,TextDecoder,TextEncoder,process,console,
    setTimeout:callback=>{const id=++next;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id)});
 const api=module.exports.testChecks,root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-code-checks-'));
 const session={config:{sharing:{}},file:()=>content};api.setActive(session);
 return {api,root,session,send:(origin,after,actorKey=origin,actor=origin)=>{
   const before=content;content=after;api.scheduleCodeCheck(root,session,{file:'Test.java',before,after,origin,actorKey,actor});
 },flush:async()=>{const pending=[...timers.values()];timers.clear();for(const callback of pending)await callback();},
 cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('Code Checks ignores ordinary local errors and reports only teammate function activity',async()=>{
 const f=isolatedCodeChecks();
 try {
   f.send('local','class Test {\n  run() { return broken; }\n}\n');await f.flush();
   assert.equal(f.api.codeIssues.size,0);
   f.send('remote','class Test {\n  run() { return teammate; }\n}\n');await f.flush();
   const entries=f.api.codeIssues.get('Test.java');
   assert.ok(entries.some(issue=>issue.message.includes('remote changed run')));
   assert.ok(entries.some(issue=>issue.warning&&issue.message.includes('local and remote')));
   assert.ok(entries.every(issue=>!issue.message.includes('broken')&&!issue.message.includes('teammate;')));
   f.send('local','class Test {\n  run() { return anotherError; }\n}\n');await f.flush();
   assert.ok(f.api.codeIssues.get('Test.java').every(issue=>!issue.message.includes('anotherError')));
 }finally{f.cleanup();}
});
test('Code Checks retains actor identity across a fast mixed batch and excludes local-only overlap',async()=>{
 const f=isolatedCodeChecks();
 try {
   f.send('local','class Test {\n  run() { return 2; }\n}\n','local-a','Same name');
   f.send('local','class Test {\n  run() { return 3; }\n}\n','local-b','Same name');await f.flush();
   assert.equal(f.api.codeIssues.size,0);
   f.send('remote','class Test {\n  run() { return 4; }\n}\n','peer-key','Same name');
   f.send('local','class Test {\n  run() { return 5; }\n}\n','local-b','Same name');await f.flush();
   assert.ok(f.api.codeIssues.get('Test.java').some(issue=>issue.warning));
   assert.ok(f.api.codeIssues.get('Test.java').some(issue=>issue.message.includes('changed run')));
 }finally{f.cleanup();}
});
test('Code Checks falls back to teammate file activity without a language symbol provider and clears deleted files',async()=>{
 const f=isolatedCodeChecks(false);
 try {
   f.send('remote','class Test {\n  run() { return 7; }\n}\n');await f.flush();
   assert.equal(f.api.codeIssues.get('Test.java').length,1);
   assert.match(f.api.codeIssues.get('Test.java')[0].message,/remote changed this file/);
   f.send('remote',null);await f.flush();assert.equal(f.api.codeIssues.has('Test.java'),false);
 }finally{f.cleanup();}
});
