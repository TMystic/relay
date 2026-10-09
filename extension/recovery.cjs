'use strict';
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const MAX_CIPHER=12*1024*1024;
const MAX_BODY=18*1024*1024;
function endpoint(value) {
 const url=new URL(value);
 if(url.protocol!=='https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) ||
    url.pathname!=='/functions/v1/relay-recovery' || url.port || url.search || url.hash || url.username || url.password)
  throw new Error('Use the HTTPS relay-recovery function URL on your Supabase project.');
 return url.href;
}
const derive=(config,label)=>crypto.createHmac('sha256',Buffer.from(config.token,'hex')).update(label+':'+config.room).digest();
const capability=config=>derive(config,'relay-recovery-auth-v1').toString('hex');
function seal(config,snapshot) {
 const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',derive(config,'relay-recovery-encryption-v1'),nonce);
 cipher.setAAD(Buffer.from('relay-recovery-v1:'+config.room));
 const value=snapshot.protocol===2 ? snapshot : {state:snapshot.state,initialized:snapshot.initialized,history:snapshot.history};
 return Buffer.concat([Buffer.from('RLC1'),nonce,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]);
}
function open(config,bytes) {
 if(bytes.length<32 || bytes.length>MAX_CIPHER || bytes.subarray(0,4).toString()!=='RLC1')throw new Error('Invalid encrypted recovery copy.');
 const cipher=crypto.createDecipheriv('aes-256-gcm',derive(config,'relay-recovery-encryption-v1'),bytes.subarray(4,16));
 cipher.setAAD(Buffer.from('relay-recovery-v1:'+config.room));cipher.setAuthTag(bytes.subarray(-16));
 return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(16,-16)),cipher.final()]).toString());
}
async function boundedJSON(response) {
 const reader=response.body?.getReader();if(!reader)throw new Error('Empty recovery response.');
 const chunks=[];let length=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BODY)throw new Error('Recovery response is too large.');chunks.push(Buffer.from(value));}}
 finally {await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString());
}
class Recovery extends EventEmitter {
 constructor(config,{fetchImpl=globalThis.fetch}={}) {
  super();this.config=config;this.url=endpoint(config.recovery.url);this.fetch=fetchImpl;
  this.device=config.recoveryDevice || crypto.randomBytes(16).toString('hex');
  if(!/^[a-f0-9]{32}$/.test(this.device))throw new Error('Invalid recovery device identity.');
  this.versions=new Map();this.queue=Promise.resolve();this.closed=false;this.controllers=new Set();
 }
 async request(op,extra={}) {
  if(this.closed)throw new Error('Recovery is closed.');
  const abort=new AbortController();this.controllers.add(abort);
  const timer=setTimeout(()=>abort.abort(),15000);
  try {
   const response=await this.fetch(this.url,{method:'POST',redirect:'error',signal:abort.signal,
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+capability(this.config)},
    body:JSON.stringify({op,room:this.config.room,...extra})});
   if(!response.ok)throw new Error('Recovery service unavailable ('+response.status+').');
   return await boundedJSON(response);
  } finally {clearTimeout(timer);this.controllers.delete(abort);}
 }
 async provision(setup) {await this.request('provision',{setup});}
 async read() {
  const list=await this.request('list');
  if(!Array.isArray(list.copies)||list.copies.length>64)throw new Error('Invalid recovery index.');
  const result=[];
  for(const row of list.copies) {
   if(!/^[a-f0-9]{32}$/.test(row.device)||!/^[a-f0-9]{64}$/.test(row.version))throw new Error('Invalid recovery index.');
   this.versions.set(row.device,row.version);
   const body=await this.request('get',{device:row.device});
   if(body.version!==row.version)continue; // Changed during listing: retry on the next pass.
   if(typeof body.cipher!=='string'||body.cipher.length>Math.ceil(MAX_CIPHER/3)*4|| !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.cipher))
    throw new Error('Invalid recovery ciphertext.');
   const bytes=Buffer.from(body.cipher,'base64');
   if(crypto.createHash('sha256').update(bytes).digest('hex')!==row.version)throw new Error('Recovery checksum mismatch.');
   const value=open(this.config,bytes);
   if(value.protocol===2&&value.index)result.push(await this.readArchive(value));
   else if(value.protocol!==2||!value.part)result.push(value);
  }
  return result;
 }
 save(snapshot) {
  const action=async()=>{
   if(snapshot.protocol===2)return this.saveArchive(snapshot);
   if(this.lastSaved && Date.now()-this.lastSaved<1000)await new Promise(resolve=>setTimeout(resolve,1000-(Date.now()-this.lastSaved)));
   if(this.closed)throw new Error('Recovery is closed.');
   let copy=snapshot;
   if(!this.versions.has(this.device)) {
    const index=await this.request('list');
    const own=index.copies?.find(x=>x.device===this.device);
    this.versions.set(this.device,own?.version || null);
   }
   if(this.versions.get(this.device)) {
    const previous=await this.request('get',{device:this.device});
    if(previous.version!==this.versions.get(this.device))throw new Error('Recovery slot changed; retry after merging recovery copies.');
    if(typeof previous.cipher!=='string'||previous.cipher.length>Math.ceil(MAX_CIPHER/3)*4)throw new Error('Invalid recovery copy.');
    const prior=open(this.config,Buffer.from(previous.cipher,'base64'));
    const Y=require('yjs'),doc=new Y.Doc();
    try {
     for(const value of [prior.state,snapshot.state]) {
      if(typeof value!=='string'||value.length>Math.ceil(8*1024*1024/3)*4)throw new Error('Invalid recovery state.');
      Y.applyUpdate(doc,Buffer.from(value,'base64'));
     }
     require('./peer-session.cjs').validateDoc(doc);
     copy={state:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
      initialized:prior.initialized===true||snapshot.initialized===true,history:snapshot.history};
    }finally{doc.destroy();}
   }
   const bytes=seal(this.config,copy);
   if(bytes.length>MAX_CIPHER)throw new Error('Encrypted recovery copy is too large.');
   const version=crypto.createHash('sha256').update(bytes).digest('hex');
   // CAS prevents another process from being overwritten silently.
   await this.request('put',{device:this.device,previous:this.versions.get(this.device),version,cipher:bytes.toString('base64')});
   this.versions.set(this.device,version);this.lastSaved=Date.now();
  };
  const result=this.queue.then(action);
  this.queue=result.catch(()=>{this.versions.delete(this.device);});
  return result;
 }

 async getCopy(device,version) {
  const body=await this.request('get',{device});
  if(version&&body.version!==version)throw new Error('Recovery version changed during download; retry.');
  if(typeof body.cipher!=='string'||body.cipher.length>Math.ceil(MAX_CIPHER/3)*4)throw new Error('Invalid recovery copy.');
  const bytes=Buffer.from(body.cipher,'base64');
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==body.version)throw new Error('Recovery checksum mismatch.');
  return {value:open(this.config,bytes),version:body.version};
 }
 async putCopy(device,value) {
  const list=await this.request('list'),previous=list.copies?.find(row=>row.device===device)?.version||null;
  const bytes=seal(this.config,value);if(bytes.length>MAX_CIPHER)throw new Error('Encrypted recovery part exceeds its limit.');
  const version=crypto.createHash('sha256').update(bytes).digest('hex');
  await this.request('put',{device,previous,version,cipher:bytes.toString('base64')});
  return version;
 }
 async readArchive(value) {
  const index=value.index;
  if(!index||!Array.isArray(index.parts)||index.parts.length>8||!/^[a-f0-9]{64}$/.test(index.hash)||![0,1].includes(index.bank))
    throw new Error('Invalid multipart recovery index.');
  const buffers=[];
  for(const part of index.parts) {
   if(!/^[a-f0-9]{32}$/.test(part.device)||!/^[a-f0-9]{64}$/.test(part.version))throw new Error('Invalid recovery part reference.');
   const copy=(await this.getCopy(part.device,part.version)).value;
   if(copy.protocol!==2||copy.part!==true||typeof copy.data!=='string'||copy.data.length>8*1024*1024)throw new Error('Invalid recovery part.');
   buffers.push(Buffer.from(copy.data,'base64'));
  }
  const bytes=Buffer.concat(buffers);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==index.hash)throw new Error('Recovery archive checksum mismatch.');
  const archive=JSON.parse(require('node:zlib').inflateRawSync(bytes,{maxOutputLength:48*1024*1024}).toString());
  if(archive.protocol!==2)throw new Error('Invalid recovered project.');
  return archive;
 }
 async saveArchive(snapshot) {
  if(this.lastSaved&&Date.now()-this.lastSaved<1000)await new Promise(resolve=>setTimeout(resolve,1000-(Date.now()-this.lastSaved)));
  const list=await this.request('list'),own=list.copies?.find(row=>row.device===this.device);
  let bank=0,previous=own?.version||null,copy=snapshot;
  if(own) {
   const prior=(await this.getCopy(this.device,own.version)).value;
   if(prior.protocol!==2||!prior.index)throw new Error('Recovery slot uses another protocol.');
   bank=1-prior.index.bank;
   copy=require('./peer-session.cjs').mergeArchives(this.config,await this.readArchive(prior),snapshot);
  }
  const bytes=require('node:zlib').deflateRawSync(Buffer.from(JSON.stringify(copy)));
  const size=6*1024*1024,count=Math.ceil(bytes.length/size);
  if(count>8)throw new Error('Recovery archive exceeds the 48 MB bound.');
  const parts=[];
  for(let i=0;i<count;i++) {
   const device=crypto.createHmac('sha256',derive(this.config,'relay-recovery-parts-v2'))
    .update(this.device+':'+bank+':'+i).digest('hex').slice(0,32);
   const version=await this.putCopy(device,{protocol:2,part:true,data:bytes.subarray(i*size,(i+1)*size).toString('base64')});
   parts.push({device,version});
  }
  const index={protocol:2,index:{bank,parts,hash:crypto.createHash('sha256').update(bytes).digest('hex')},initialized:copy.initialized};
  const cipher=seal(this.config,index),version=crypto.createHash('sha256').update(cipher).digest('hex');
  // Publish the index last. The other bank retains the preceding complete copy.
  await this.request('put',{device:this.device,previous,version,cipher:cipher.toString('base64')});
  this.versions.set(this.device,version);this.lastSaved=Date.now();
 }
 close(){this.closed=true;for(const controller of this.controllers)controller.abort();}
}
module.exports={Recovery,endpoint,capability,seal,open};
