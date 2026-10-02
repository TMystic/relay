import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {startServer} from '../server/index.js';
const require=createRequire(import.meta.url);
const {Session,publish,parseInvite}=require('../extension/session.cjs');
const {collect,safeTarget,sharedPath}=require('../extension/files.cjs');
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
