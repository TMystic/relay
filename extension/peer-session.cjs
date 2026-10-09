'use strict';
const Y = require('yjs');
const { diffLines } = require('diff');
const { changeStats } = require('./files.cjs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { sharedPath, delta } = require('./files.cjs');
const {Recovery,endpoint}=require('./recovery.cjs');
const MAX_STATE = 8 * 1024 * 1024;
const MAX_FRAME = 12 * 1024 * 1024;
const preview = value => {
  let text=Buffer.from(value).subarray(0,8192).toString();
  while(Buffer.byteLength(text)>8192)text=text.slice(0,-1);
  return text;
};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const encode = bytes => Buffer.from(bytes).toString('base64');
const mac = (token, value) => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(value).digest();
function validateConfig(config) {
  if (config?.mode !== 'p2p' || !/^[a-f0-9]{32}$/.test(config.room || '') || !/^[a-f0-9]{64}$/.test(config.token || ''))
    throw new Error('Use a complete relay:// peer invite. Old cloud links must be migrated explicitly.');
  if(config.recovery) {endpoint(config.recovery.url);if(!['failure-only','backup'].includes(config.recovery.policy))throw new Error('Invalid recovery policy.');}
}
function parseInvite(value) {
  const url = new URL(value);
  const query = new URLSearchParams(url.hash.slice(1));
  if (url.protocol !== 'relay:' || !['workspace','workspace-v2'].includes(url.hostname) || !/^\/[a-f0-9]{32}$/.test(url.pathname) || url.username || url.password || url.search)
    throw new Error('Use a complete relay://workspace peer invite.');
  const config = { mode:'p2p', room:url.pathname.slice(1), token:query.get('key') };
  if(url.hostname==='workspace-v2')config.protocol=2;
  if(query.has('cloud'))config.recovery={url:endpoint(query.get('cloud')),policy:query.get('policy') || 'failure-only'};
  validateConfig(config); return config;
}
function validateDoc(doc) {
  const files = doc.getMap('files');
  if (files.size > 1000) throw new Error('Shared source exceeds 1,000 files.');
  let total = 0;
  const names = new Set();
  for (const [name, text] of files) {
    if (!sharedPath(name) || !(text instanceof Y.Text)) throw new Error('Peer supplied an unsafe source path or value.');
    const canonical = name.normalize('NFC').toLowerCase();
    if (names.has(canonical)) throw new Error('Shared filenames collide on Windows.');
    names.add(canonical);
    const size = Buffer.byteLength(text.toString());
    if (size > 512 * 1024 || text.toString().includes('\0')) throw new Error('Shared files must be UTF-8 text smaller than 512 KB.');
    total += size;
  }
  if (total > 1024 * 1024) throw new Error('Shared source exceeds 1 MB.');
  for (const [name] of doc.share) if (name !== 'files') throw new Error('Unexpected shared data type.');
  if (Y.encodeStateAsUpdate(doc).length > MAX_STATE) throw new Error('Collaboration history exceeds 8 MB. Export source and create a fresh workspace.');
}
function decodeState(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_STATE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('Invalid peer update.');
  return Buffer.from(value,'base64');
}
function sealSnapshot(token, snapshot) {
  const key = mac(token,'relay-cache-v1'), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('relay-cache-v1'));
  const plain = Buffer.from(JSON.stringify(snapshot));
  return Buffer.concat([Buffer.from('RLY1'),nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
}
function openSnapshot(token, bytes) {
  if (bytes.length < 32 || bytes.length > 96*1024*1024 || bytes.subarray(0,4).toString() !== 'RLY1') throw new Error('Invalid local peer cache. Restore your backup before reconnecting.');
  const decipher = crypto.createDecipheriv('aes-256-gcm',mac(token,'relay-cache-v1'),bytes.subarray(4,16));
  decipher.setAAD(Buffer.from('relay-cache-v1')); decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16,-16)),decipher.final()]).toString());
}
class LegacyPeerSession extends EventEmitter {
  constructor(config, { cached, initialFiles, checkpoint, swarmFactory, recovery, recoveryInterval=10000 } = {}) {
    super(); validateConfig(config);
    this.config = config; this.doc = new Y.Doc(); this.checkpoint = checkpoint;
    this.closed = false; this.ready = false; this.seq = 0; this.members = []; this.history = [];
    this.peers = new Set(); this.frameBytes=0; this.baseline = {}; this.title = config.title || 'Peer workspace';
    this.swarmFactory = swarmFactory;
    this.recovery=recovery || (config.recovery ? new Recovery(config) : null);
    this.recoveryInterval=recoveryInterval;this.localDurable=true;this.cloudState=null;this.savePending=null;
    this.storageProblem=null;this.recoveryBusy=false;this.recoveryChecked=false;
    try {
      if (cached) {
        const snapshot = openSnapshot(config.token,cached);
        Y.applyUpdate(this.doc,decodeState(snapshot.state),'initial');
        this.baseline = snapshot.baseline || {}; this.history = this.cleanHistory(snapshot.history);
        this.ready = snapshot.initialized === true;
      } else if (initialFiles) {
        this.doc.transact(() => {
          for (const [name,text] of Object.entries(initialFiles)) {
            if (typeof text !== 'string') throw new Error('Invalid source text.');
            this.doc.getMap('files').set(name,new Y.Text(text));
          }
        },'initial');
        this.ready = true;
      }
      validateDoc(this.doc);
    } catch (error) { this.doc.destroy(); throw error; }
    this.persist()?.catch(()=>{});
  }
  snapshot(doc = this.doc, initialized) { return { state:encode(Y.encodeStateAsUpdate(doc)),initialized:initialized ?? (this.ready || doc.getMap('files').size>0),baseline:this.baseline,history:this.history }; }
  persist(doc = this.doc, initialized) {
    const snapshot=this.snapshot(doc,initialized);
    try {
      this.checkpoint?.(sealSnapshot(this.config.token,snapshot));
      if(doc===this.doc){this.localDurable=true;this.storageProblem=null;}
    } catch(error) {
      if(doc===this.doc){this.localDurable=false;this.storageProblem=error.message;}
      if(!this.recovery)throw error;
      const promise=doc===this.doc ? this.saveLatest(snapshot) : this.recovery.save(snapshot);
      return promise.then(()=>{if(!this.closed)this.status();});
    }
    if(this.recovery && this.config.recovery?.policy==='backup' && doc===this.doc)
      this.saveLatest(snapshot).catch(()=>{});
  }
  saveLatest(snapshot=this.snapshot()) {
    this.savePending=snapshot;
    if(this.saveFlight)return this.saveFlight;
    this.saveFlight=(async()=>{
      while(this.savePending && !this.closed) {
        const next=this.savePending;this.savePending=null;
        await this.recovery.save(next);
        this.cloudState=hash(next.state);
      }
    })().catch(error=>{
      if(!this.closed)this.emit('problem','Cloud recovery failed; keep this editor open. '+error.message);
      throw error;
    }).finally(()=>{this.saveFlight=null;if(!this.closed)this.status();});
    return this.saveFlight;
  }
  recoveryNeeded() {
    return !this.localDurable || !this.ready || ![...this.peers].some(p=>p.authenticated&&p.ack>=this.seq) ||
      this.config.recovery?.policy==='backup';
  }
  async recoverNow() {
    if(this.closed || !this.recovery || this.recoveryBusy || (this.recoveryChecked && !this.recoveryNeeded()))return;
    this.recoveryBusy=true;
    try {
      const copies=await this.recovery.read();this.recoveryChecked=true;
      for(const snapshot of copies) {
        if(this.closed)return;
        if(snapshot.initialized!==true)continue;
        const peer={authenticated:true,socket:{destroyed:false,write:()=>true}};
        await this.receive(peer,{type:'state',seq:0,update:snapshot.state,entries:snapshot.history});
      }
      if(this.ready && !this.closed && this.recoveryNeeded() && hash(this.snapshot().state)!==this.cloudState)await this.saveLatest();
    } catch(error) {
      if(!this.closed)this.emit('problem','Cloud recovery unavailable. Local/peer collaboration can continue: '+error.message);
    } finally {this.recoveryBusy=false;if(!this.closed)this.status();}
  }
  files() { return new Map([...this.doc.getMap('files')].map(([name,text])=>[name,text.toString()])); }
  cleanHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.filter(e=>e && /^[a-f0-9-]{36}$/.test(e.id || '') && sharedPath(e.file) &&
      typeof e.actor==='string' && e.actor.length<=80 && typeof e.time==='string' && e.time.length<=40 &&
      typeof e.before==='string' && Buffer.byteLength(e.before)<=8192 && typeof e.after==='string' && Buffer.byteLength(e.after)<=8192)
      .slice(0,50).map(e=>{
      const changes=diffLines(e.before,e.after);
      return {id:e.id,file:e.file,actor:e.actor,time:e.time,before:e.before,after:e.after,
        added:changes.filter(c=>c.added).reduce((n,c)=>n+c.count,0),
        removed:changes.filter(c=>c.removed).reduce((n,c)=>n+c.count,0)};
    });
  }
  edit(name, text, textUpdate) {
    if (this.closed) throw new Error('The peer workspace is closed.');
    if (!this.ready) throw new Error('Wait for a peer to send the workspace before editing.');
    if (!sharedPath(name) || (text !== null && typeof text !== 'string')) throw new Error('Invalid shared source file.');
    const before = this.files().get(name);
    if (!textUpdate && (before === text || (before === undefined && text === null))) return;
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate,Y.encodeStateAsUpdate(this.doc));
      const files = candidate.getMap('files');
      if(textUpdate)Y.applyUpdate(candidate,textUpdate);
      else if (text === null) files.delete(name); else files.set(name,new Y.Text(text));
      validateDoc(candidate);
    } finally { candidate.destroy(); }
    const vector = Y.encodeStateVector(this.doc);
    this.emit('before-change',name);
    if(textUpdate)Y.applyUpdate(this.doc,textUpdate,'local');else this.doc.transact(() => {
      const files = this.doc.getMap('files');
      if (text === null) { files.delete(name); return; }
      if (!files.has(name)) { files.set(name,new Y.Text(text)); return; }
      const target=files.get(name),change=delta(target.toString(),text);
      if (change.length) target.delete(change.start,change.length);
      if (change.text) target.insert(change.start,change.text);
    },'local');
    const entry={id:crypto.randomUUID(),file:name,actor:this.config.name || 'Teammate',time:new Date().toISOString(),
      before:preview(before || ''),after:preview(text || '')};
    // Reviews are bounded previews, not a tamper-proof audit log.
    this.history=this.cleanHistory([entry,...this.history]);
    this.persist()?.catch(()=>{}); this.seq++;
    const update=Y.encodeStateAsUpdate(this.doc,vector);
    for (const peer of this.peers) if (peer.authenticated) this.send(peer,{type:'update',update:encode(update),seq:this.seq,entries:[entry]});
    this.emit('files',this.files()); this.emit('activity',this.history); this.status();
  }

  file(name){return this.doc.getMap('files').get(name)?.toString();}
  hasFile(name){return this.doc.getMap('files').has(name);}
  textIdentity(name) {
    const type=this.doc.getMap('files').get(name);
    return type?JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(type,0)).type):null;
  }
  textSnapshot(name) {
    const identity=this.textIdentity(name);if(!identity)return null;
    return {protocol:1,name,identity,update:Y.encodeStateAsUpdate(this.doc),doc:this.doc};
  }
  applyTextUpdate(name,update,identity) {
    if(this.textIdentity(name)!==identity)throw new Error('The shared file was deleted or replaced. Keep your unsaved editor copy.');
    const candidate=new Y.Doc();
    try{Y.applyUpdate(candidate,Y.encodeStateAsUpdate(this.doc));Y.applyUpdate(candidate,update);validateDoc(candidate);
      this.edit(name,candidate.getMap('files').get(name).toString(),update);
    }finally{candidate.destroy();}
  }
  status() {
    const peers=[...this.peers].filter(p=>p.authenticated);
    const copies=peers.filter(p=>p.ack >= this.seq).length;
    const cloud=this.cloudState===hash(this.snapshot().state);
    const text=!this.ready ? 'Waiting for a peer'+(this.recovery?' or recovery copy':' with the project') :
      !this.localDurable ? (cloud?'Saved to encrypted recovery · local storage failed':
        copies?'Replicated to peers · local storage failed':'Not safely saved · local storage failed; keep editor open') :
      copies ? 'Saved locally · replicated to '+copies+' peer(s)' :
      'Saved locally · '+(cloud?'encrypted recovery copy confirmed':peers.length?'replicating to peers':'no other online copies');
    this.emit('status',text);
  }
  invite() {
    const query=new URLSearchParams({key:this.config.token});
    if(this.config.recovery){query.set('cloud',this.config.recovery.url);query.set('policy',this.config.recovery.policy);}
    return 'relay://workspace/'+this.config.room+'#'+query.toString();
  }
  presence(file) {
    if (file && !sharedPath(file)) return;
    for (const peer of this.peers) if (peer.authenticated) this.send(peer,{type:'presence',file:file || ''});
  }
  refreshMembers() {
    this.members=[...this.peers].filter(p=>p.authenticated).map(p=>({id:p.id,name:p.name+' · '+p.id.slice(0,8),file:p.file || ''}));
    this.emit('members',this.members); this.status();
  }
  send(peer, message) {
    if (peer.socket.destroyed) return;
    const bytes=Buffer.from(JSON.stringify(message));
    if (bytes.length>MAX_FRAME || peer.queuedBytes>MAX_FRAME*2) { peer.socket.destroy(); return; }
    const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);
    if(!peer.socket.write(Buffer.concat([header,bytes])))peer.queuedBytes=(peer.queuedBytes || 0)+bytes.length+4;
  }
  connect() {
    if (this.closed || this.swarm) return;
    if(this.recovery && !this.recoveryTimer) {
      this.recoveryTimer=setInterval(()=>this.recoverNow(),this.recoveryInterval);
      this.recoveryTimer.unref?.();
    }
    try {
      const Hyperswarm=require('hyperswarm');
      this.swarm=this.swarmFactory ? this.swarmFactory() : new Hyperswarm({maxPeers:32});
      this.swarm.on('error',()=>this.emit('problem','Peer discovery failed. Check your network; local data is retained.'));
      this.swarm.on('connection',socket=>this.attach(socket));
      const topic=mac(this.config.token,'relay-topic-v1:'+this.config.room);
      this.swarm.join(topic,{server:true,client:true});
      this.swarm.flush().catch(()=>{if(!this.closed)this.emit('problem','No reachable peers yet. Local data is retained.');});
      if (this.ready) this.emit('connected');
      this.status();
    } catch (error) { this.emit('problem',error.message); }
  }
  attach(socket) {
    if (this.closed || this.peers.size>=32 || !Buffer.isBuffer(socket.handshakeHash) || !Buffer.isBuffer(socket.remotePublicKey)) { socket.destroy(); return; }
    const peer={socket,id:socket.remotePublicKey.toString('hex'),nonce:crypto.randomBytes(32).toString('hex'),
      authenticated:false,ack:-1,pending:Buffer.alloc(0),expected:0,received:0,frame:null,frameTimer:null,queuedBytes:0,name:'Teammate',rate:0,window:Date.now()};
    this.peers.add(peer);
    const timer=setTimeout(()=>socket.destroy(),10000);
    socket.on('error',()=>{});
    socket.on('drain',()=>{peer.queuedBytes=0;});
    socket.on('close',()=>{
      clearTimeout(timer);clearTimeout(peer.frameTimer);
      this.frameBytes-=peer.expected+(peer.inputBytes||0);peer.expected=0;peer.frame=null;peer.inputBytes=0;peer.inputQueue=[];
      this.peers.delete(peer);this.refreshMembers();
    });
    const deferInput=chunk=>{
      if(!chunk.length)return;
      const length=chunk.length;
      if((peer.inputBytes||0)+length>MAX_FRAME*2||this.frameBytes+length>MAX_FRAME*4)throw new Error('Aggregate pending input limit.');
      peer.inputQueue??=[];peer.inputQueue.push(Buffer.from(chunk));peer.inputBytes=(peer.inputBytes||0)+length;this.frameBytes+=length;
    };
    const onData=chunk=>{
      if(socket.destroyed||this.closed)return;
      try {
        if(peer.receiving){deferInput(chunk);return;}
        if (Date.now()-peer.window>1000) { peer.window=Date.now();peer.rate=0; }
        let offset=0;
        while(offset<chunk.length) {
          if(!peer.expected) {
            const take=Math.min(4-peer.pending.length,chunk.length-offset);
            peer.pending=Buffer.concat([peer.pending,chunk.subarray(offset,offset+take)]);offset+=take;
            if(peer.pending.length!==4)continue;
            const length=peer.pending.readUInt32BE(0);peer.pending=Buffer.alloc(0);
            if(!length || length>MAX_FRAME || (!peer.authenticated && length>2048) || this.frameBytes+length>MAX_FRAME*4)throw new Error('Invalid frame size or aggregate buffer limit.');
            peer.expected=length;this.frameBytes+=length;peer.received=0;peer.frame=Buffer.allocUnsafe(length);
            peer.frameTimer=setTimeout(()=>socket.destroy(),15000);
          }
          const take=Math.min(peer.expected-peer.received,chunk.length-offset);
          chunk.copy(peer.frame,peer.received,offset,offset+take);offset+=take;peer.received+=take;
          if(peer.received===peer.expected) {
            if(++peer.rate>240)throw new Error('Peer message rate exceeded.');
            const bytes=peer.frame;
            clearTimeout(peer.frameTimer);
            this.frameBytes-=peer.expected;peer.frame=null;peer.expected=0;
            const message=JSON.parse(bytes.toString('utf8'));
            const pending=this.receive(peer,message);
            if(pending?.then) {
              peer.receiving=true;socket.pause();deferInput(chunk.subarray(offset));
              pending.catch(error=>{if(!this.closed){socket.destroy();this.emit('problem','Unable to durably receive peer changes: '+error.message);}})
                .finally(()=>{
                  peer.receiving=false;if(socket.destroyed||this.closed)return;
                  while(peer.inputQueue?.length&&!peer.receiving&&!socket.destroyed) {
                    const next=peer.inputQueue.shift();peer.inputBytes-=next.length;this.frameBytes-=next.length;onData(next);
                  }
                  if(!peer.receiving&&!socket.destroyed)socket.resume();
                });
              if(peer.authenticated)clearTimeout(timer);
              return;
            }
            if(peer.authenticated)clearTimeout(timer);
          }
        }
      } catch(error) { socket.destroy();this.emit('problem','Rejected peer data: '+error.message); }
    };
    socket.on('data',onData);
    this.send(peer,{type:'challenge',nonce:peer.nonce});
  }
  proof(peer, nonce) {
    return mac(this.config.token,Buffer.concat([Buffer.from('relay-auth-v1:'+this.config.room+':'+nonce+':'),peer.socket.handshakeHash]));
  }
  receive(peer, message) {
    if (!message || typeof message.type!=='string') throw new Error('Invalid peer message.');
    if (!peer.authenticated) {
      if (message.type==='challenge' && !peer.challenge && /^[a-f0-9]{64}$/.test(message.nonce || '')) {
        peer.challenge=true;this.send(peer,{type:'proof',proof:this.proof(peer,message.nonce).toString('hex'),name:(this.config.name || 'Teammate').slice(0,40)});return;
      }
      if (message.type==='proof' && typeof message.name==='string' && message.name.length<=40 && /^[a-f0-9]{64}$/.test(message.proof || '') &&
        crypto.timingSafeEqual(Buffer.from(message.proof,'hex'),this.proof(peer,peer.nonce))) {
        peer.authenticated=true;peer.name=message.name.replace(/[\x00-\x1f\x7f]/g,'');
        if (this.ready) this.send(peer,{type:'state',update:encode(Y.encodeStateAsUpdate(this.doc)),seq:this.seq,entries:this.history});
        this.refreshMembers();return;
      }
      throw new Error('Workspace authentication failed.');
    }
    if (message.type==='state' || message.type==='update') {
      if (!Number.isSafeInteger(message.seq) || message.seq<0) throw new Error('Invalid update sequence.');
      if((this.pendingReceives || 0)>=4)throw new Error('Too many pending durable writes.');
      const update=decodeState(message.update),vector=Y.encodeStateVector(this.doc),stateBefore=hash(Y.encodeStateAsUpdate(this.doc)),candidate=new Y.Doc();
      let durable;
      try {
        Y.applyUpdate(candidate,Y.encodeStateAsUpdate(this.doc));Y.applyUpdate(candidate,update);
        validateDoc(candidate);
        const incoming=this.cleanHistory(message.entries);
        const nextHistory=this.cleanHistory([...incoming,...this.history].filter((e,i,all)=>all.findIndex(x=>x.id===e.id)===i));
        const snapshot=this.snapshot(candidate,true);snapshot.history=nextHistory;
        // Keep staging separate from live history while cloud persistence is asynchronous.
        try {
          this.checkpoint?.(sealSnapshot(this.config.token,snapshot));
          this.localDurable=true;this.storageProblem=null;
        } catch(error) {
          this.localDurable=false;this.storageProblem=error.message;
          if(!this.recovery)throw error;
          durable=this.recovery.save(snapshot);
        }
        const apply=()=>{
          if(this.closed)return;
          if(hash(Y.encodeStateAsUpdate(this.doc))!==stateBefore)
            return this.receive(peer,message); // Include edits made while awaiting cloud durability.
          this.emit('before-change');Y.applyUpdate(this.doc,update,'remote');this.history=nextHistory;
          if(durable)this.cloudState=hash(snapshot.state);
          this.send(peer,{type:'ack',seq:message.seq});
          const merged=Y.encodeStateAsUpdate(this.doc,vector);
          if(merged.length>2) {
            this.seq++;
            for(const other of this.peers) if(other.authenticated)
              this.send(other,{type:'update',update:encode(merged),seq:this.seq,entries:this.history});
          }
          if(!this.ready){this.ready=true;this.emit('connected');}
          this.emit('files',this.files());this.emit('activity',this.history);this.status();
        };
        if(durable){this.pendingReceives=(this.pendingReceives || 0)+1;return durable.then(apply).finally(()=>{this.pendingReceives--;candidate.destroy();});}
        apply();
      } catch(error){candidate.destroy();throw error;}
      if(!durable)candidate.destroy();
    } else if(message.type==='ack') {
      if (!Number.isSafeInteger(message.seq) || message.seq<0 || message.seq>this.seq) throw new Error('Invalid acknowledgement.');
      peer.ack=Math.max(peer.ack,message.seq);this.status();
    } else if(message.type==='presence') {
      if(typeof message.file!=='string' || (message.file && !sharedPath(message.file)))throw new Error('Unsafe presence path.');
      peer.file=message.file;this.refreshMembers();
    } else throw new Error('Unknown peer message.');
  }
  async close() {
    if(this.closed)return;
    this.closed=true;
    clearInterval(this.recoveryTimer);this.recovery?.close?.();
    for(const peer of this.peers)peer.socket.destroy();
    if(this.swarm)await this.swarm.destroy();
    this.doc.destroy();
  }
}

// Protocol 2 gives every file an independent CRDT and transfers verified blocks.
// Protocol 1 remains available for existing invitations and recovery copies.
const zlib=require('node:zlib');
const FILE_LIMIT=2*1024*1024, PROJECT_LIMIT=16*1024*1024, FILE_STATE_LIMIT=8*1024*1024, CHUNK=128*1024;
function fileValue(doc, kind) {
  return kind==='binary' ? {binary:doc.getMap('asset').get('bytes') || ''} : doc.getText('content').toString();
}
function equalValue(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function valueBytes(value){return typeof value==='string'?Buffer.byteLength(value):Buffer.from(value.binary,'base64').length;}
function validateValue(value,kind) {
  if(kind==='text') {
    if(typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>FILE_LIMIT)throw new Error('Text file exceeds 2 MB or is not UTF-8 text.');
  } else if(kind==='binary') {
    if(!value || typeof value.binary!=='string'||value.binary.length>Math.ceil(FILE_LIMIT/3)*4||Buffer.from(value.binary,'base64').length>FILE_LIMIT||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.binary))throw new Error('Invalid binary file.');
  } else throw new Error('Invalid file kind.');
}
function validateFileDoc(doc,kind) {
  validateValue(fileValue(doc,kind),kind);
  for(const [key,type] of doc.share) {
    if(key!==(kind==='text'?'content':'asset') || !(type instanceof (kind==='text'?Y.Text:Y.Map)))throw new Error('Unexpected per-file data.');
  }
  if(kind==='binary' && [...doc.getMap('asset').keys()].some(key=>key!=='bytes'))throw new Error('Invalid binary record.');
  if(Y.encodeStateAsUpdate(doc).length>FILE_STATE_LIMIT)throw new Error('File history exceeds 8 MB; checkpoint and start a fresh workspace.');
}
function blockSeal(config,bytes) {
  const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',mac(config.token,'relay-block-v2:'+config.room),nonce);
  cipher.setAAD(Buffer.from(config.room));
  return Buffer.concat([Buffer.from('RLB2'),nonce,cipher.update(zlib.deflateRawSync(bytes)),cipher.final(),cipher.getAuthTag()]);
}
function blockOpen(config,bytes) {
  if(bytes.length<32||bytes.length>FILE_STATE_LIMIT+65536||bytes.subarray(0,4).toString()!=='RLB2')throw new Error('Invalid file block.');
  const cipher=crypto.createDecipheriv('aes-256-gcm',mac(config.token,'relay-block-v2:'+config.room),bytes.subarray(4,16));
  cipher.setAAD(Buffer.from(config.room));cipher.setAuthTag(bytes.subarray(-16));
  return zlib.inflateRawSync(Buffer.concat([cipher.update(bytes.subarray(16,-16)),cipher.final()]),{maxOutputLength:FILE_STATE_LIMIT});
}

class TextBinding {
  constructor(snapshot,eol=null) {
    if(!snapshot)throw new Error('Shared text file is unavailable.');
    this.identity=snapshot.identity;this.protocol=snapshot.protocol;this.name=snapshot.name;this.eol=eol;
    this.doc=new Y.Doc();Y.applyUpdate(this.doc,snapshot.update);this.dirty=false;this.pending=null;
  }
  get type(){return this.protocol===2?this.doc.getText('content'):this.doc.getMap('files').get(this.name);}
  get text(){const raw=this.type.toString();return this.eol?raw.replace(/\r\n|\r|\n/g,this.eol):raw;}
  rawOffset(offset,raw,visible) {
    if(!this.eol||raw===visible)return offset;
    let position=0;
    for(let index=0;index<raw.length;index++) {
      if(position===offset)return index;
      if(raw[index]==='\r'||raw[index]==='\n') {
        if(raw[index]==='\r'&&raw[index+1]==='\n')index++;
        position+=this.eol.length;
      }else position++;
      if(position>offset)throw new Error('An editor edit splits a line ending.');
    }
    if(position===offset)return raw.length;
    throw new Error('Invalid editor offset.');
  }
  edit(changes,after,eol=this.eol) {
    const ordered=[...changes].sort((a,b)=>b.rangeOffset-a.rangeOffset);
    const visible=this.text,raw=this.type.toString();
    let projected=visible,limit=projected.length;
    for(const change of ordered) {
      const start=change.rangeOffset,end=start+change.rangeLength;
      if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>limit||typeof change.text!=='string')
        throw new Error('Editor change does not match its shared document version.');
      projected=projected.slice(0,start)+change.text+projected.slice(end);limit=start;
    }
    if(projected!==after)throw new Error('Editor change does not match its shared document version.');
    const mapped=ordered.map(change=>{
      const start=this.rawOffset(change.rangeOffset,raw,visible),end=this.rawOffset(change.rangeOffset+change.rangeLength,raw,visible);
      return {start,length:end-start,text:this.eol?change.text.replace(/\r\n|\r|\n/g,'\n'):change.text};
    });
    this.doc.transact(()=>{for(const change of mapped){this.type.delete(change.start,change.length);this.type.insert(change.start,change.text);}});
    this.eol=eol;
    this.dirty=true;
  }
  update(snapshot){if(snapshot.identity!==this.identity)throw new Error('The shared file was deleted or replaced. Keep your unsaved editor copy.');return Y.encodeStateAsUpdate(this.doc,Y.encodeStateVector(snapshot.doc));}
  destroy(){this.pending?.candidate?.destroy();this.doc.destroy();}
}

class FileSession extends LegacyPeerSession {
  constructor(config, options={}) {
    // Initializing the legacy socket layer with an empty document avoids sharing
    // the legacy whole-project CRDT on protocol 2 connections.
    super({...config,recovery:undefined},{swarmFactory:options.swarmFactory});
    this.config=config;this.checkpoint=options.checkpoint;this.recovery=options.recovery || (config.recovery?new Recovery(config):null);
    this.recoveryInterval=options.recoveryInterval || 10000;
    this.storeBlock=options.storeBlock;this.loadBlock=options.loadBlock;
    this.storeChunk=options.storeChunk;this.loadChunk=options.loadChunk;this.pruneBlocks=options.pruneBlocks;
    this.blocks=new Map();this.unsavedBlocks=new Set();this.documents=new Map();this.fileStats=new Map();this.heads={};this.timeline=[];this.checkpoints=[];this.timelineStats=new WeakMap();
    this.manifest=new Y.Doc();this.ready=false;this.pendingTransfers=new Map();this.outgoing=new Map();
    this.metrics={sentBytes:0,receivedBytes:0,chunksReused:0,filesReceived:0};
    if(options.cached) {
      const snapshot=openSnapshot(config.token,options.cached);
      if(snapshot.protocol!==2)throw new Error('This workspace requires a protocol 2 cache.');
      Y.applyUpdate(this.manifest,decodeState(snapshot.manifest));
      this.baseline=snapshot.baseline || {};this.timeline=this.cleanTimeline(snapshot.timeline);
      this.checkpoints=Array.isArray(snapshot.checkpoints)?snapshot.checkpoints.slice(0,20):[];
      for(const [id,ref] of Object.entries(snapshot.heads || {})) {
        const bytes=this.getBlock(ref);if(!bytes)throw new Error('A saved file block is missing; retain your source and recover before reconnecting.');
        this.install(id,bytes);
      }
      this.ready=snapshot.initialized===true;
    } else if(options.initialFiles) {
      for(const [name,value] of Object.entries(options.initialFiles))this.initialFile(name,value);
      this.ready=true;
    }
    this.validateManifest();this.validateProject();this.persist()?.catch(()=>{});
  }
  initialFile(name,value) {
    const kind=typeof value==='string'?'text':'binary';validateValue(value,kind);
    const id=crypto.randomBytes(16).toString('hex'),doc=new Y.Doc();
    if(kind==='text')doc.getText('content').insert(0,value);else doc.getMap('asset').set('bytes',value.binary);
    this.manifest.getMap('files').set(name,{id,kind});this.documents.set(id,doc);this.saveDoc(id,doc);
  }
  validateManifest(doc=this.manifest) {
    const seen=new Set(),ids=new Set(),files=doc.getMap('files');
    if(files.size>10000)throw new Error('Project exceeds 10,000 files.');
    for(const [name,record] of files) {
      if(!sharedPath(name)||!record||!/^[a-f0-9]{32}$/.test(record.id)||!['text','binary'].includes(record.kind))throw new Error('Invalid shared file manifest.');
      const canonical=name.normalize('NFC').toLowerCase();
      if(seen.has(canonical)||ids.has(record.id))throw new Error('Shared paths or file identities collide.');
      seen.add(canonical);ids.add(record.id);
    }
    for(const [key,type] of doc.share)if(key!=='files'||!(type instanceof Y.Map))throw new Error('Invalid manifest data.');
    if(Y.encodeStateAsUpdate(doc).length>MAX_STATE)throw new Error('Manifest history exceeds 8 MB.');
  }
  record(id){return [...this.manifest.getMap('files')].find(([,r])=>r.id===id);}
  validateProject(replacementId,replacement) {
    let size=0,stateSize=0;
    for(const [,record] of this.manifest.getMap('files')) {
      const doc=record.id===replacementId?replacement:this.documents.get(record.id);
      if(!doc)continue;
      let stats=this.fileStats.get(record.id);
      if(!stats||stats.doc!==doc) {
        validateFileDoc(doc,record.kind);const value=fileValue(doc,record.kind);
        stats={doc,value,size:valueBytes(value),stateSize:Y.encodeStateAsUpdate(doc).length};this.fileStats.set(record.id,stats);
      }
      size+=stats.size;stateSize+=stats.stateSize;
    }
    if(size>PROJECT_LIMIT)throw new Error('Project exceeds the 16 MB beta limit.');
    if(stateSize>32*1024*1024)throw new Error('Project CRDT history exceeds 32 MB. Checkpoint and start a fresh workspace.');
  }
  putBlock(bytes) {
    const ref=hash(bytes);
    try{this.storeBlock?.(ref,bytes);}catch(error){this.blocks.set(ref,bytes);this.unsavedBlocks.add(ref);this.storageProblem=error.message;}
    if(!this.storeBlock)this.blocks.set(ref,bytes);
    return ref;
  }
  flushBlocks() {
    for(const ref of this.unsavedBlocks) {this.storeBlock(ref,this.blocks.get(ref));this.unsavedBlocks.delete(ref);this.blocks.delete(ref);}
  }
  getBlock(ref) {
    if(!/^[a-f0-9]{64}$/.test(ref || ''))throw new Error('Invalid block reference.');
    const bytes=this.blocks.get(ref)||this.loadBlock?.(ref);
    if(bytes && hash(bytes)!==ref)throw new Error('Saved file checksum mismatch.');
    return bytes;
  }
  saveDoc(id,doc) {
    const bytes=blockSeal(this.config,Y.encodeStateAsUpdate(doc)),ref=this.putBlock(bytes);this.heads[id]=ref;return ref;
  }
  install(id,bytes) {
    const record=this.record(id)?.[1];if(!record)throw new Error('Unknown file identity.');
    const doc=new Y.Doc();
    try {
      Y.applyUpdate(doc,blockOpen(this.config,bytes));validateFileDoc(doc,record.kind);
      this.validateProject(id,doc);this.documents.get(id)?.destroy();this.documents.set(id,doc);
      this.heads[id]=this.putBlock(bytes);
    }catch(error){doc.destroy();throw error;}
  }
  files() {
    if(!this.manifest)return new Map();
    return new Map([...this.manifest.getMap('files')].flatMap(([name,r])=> {
      const doc=this.documents.get(r.id);return doc?[[name,this.fileStats.get(r.id)?.doc===doc?this.fileStats.get(r.id).value:fileValue(doc,r.kind)]]:[];
    }));
  }
  cleanTimeline(entries) {
    if(!Array.isArray(entries))return [];
    return entries.filter(e=>e&&/^[a-f0-9-]{36}$/.test(e.id||'')&&sharedPath(e.file)&&typeof e.actor==='string'&&e.actor.length<=80&&
      /^[a-f0-9]{32}$/.test(e.fileId||'')&&['text','binary'].includes(e.kind)&&
      [e.beforeRef,e.afterRef].every(r=>r===null||/^[a-f0-9]{64}$/.test(r||''))&&typeof e.time==='string'&&e.time.length<=40).slice(0,200);
  }
  changeStats(entry) {
    if(entry.stats?.status==='text' && Number.isSafeInteger(entry.stats.added) && entry.stats.added>=0 &&
      Number.isSafeInteger(entry.stats.removed) && entry.stats.removed>=0)return entry.stats;
    if(entry.stats?.status==='binary' && Number.isSafeInteger(entry.stats.beforeBytes) && entry.stats.beforeBytes>=0 &&
      Number.isSafeInteger(entry.stats.afterBytes) && entry.stats.afterBytes>=0)return entry.stats;
    if(entry.stats?.status==='complex')return entry.stats;
    if(this.timelineStats.has(entry))return this.timelineStats.get(entry);
    let stats;
    try{stats=changeStats(this.version(entry,'before'),this.version(entry,'after'),entry.kind);}
    catch{stats={status:'unavailable'};}
    if(stats.status!=='unavailable')this.timelineStats.set(entry,stats);
    return stats;
  }
  get history(){return this.timeline || [];}
  set history(value){if(this.manifest)this.timeline=value;}
  snapshot() {
    if(!this.manifest)return super.snapshot();
    return {protocol:2,manifest:encode(Y.encodeStateAsUpdate(this.manifest)),heads:Object.fromEntries([...this.manifest.getMap('files').values()].filter(r=>this.heads[r.id]).map(r=>[r.id,this.heads[r.id]])),initialized:this.ready,
      baseline:{...this.baseline},timeline:this.timeline,checkpoints:this.checkpoints};
  }
  persist() {
    if(!this.manifest)return;
    this.trimVersions();const snapshot=this.snapshot();
    try {this.flushBlocks();this.checkpoint?.(sealSnapshot(this.config.token,snapshot));this.localDurable=true;this.storageProblem=null;}
    catch(error){this.localDurable=false;this.storageProblem=error.message;if(!this.recovery)throw error;return this.saveLatest(snapshot);}
    if(this.config.recovery?.policy==='backup')this.saveLatest(snapshot).catch(()=>{});
  }
  status() {
    if(!this.manifest)return;
    const copies=[...this.peers].filter(p=>p.authenticated&&p.ack>=this.seq).length;
    this.emit('status',!this.ready?'Downloading verified project files':!this.localDurable?'Local save failed · keep editor open':
      'Saved locally · '+(this.cloudState===this.recoveryHash()?'encrypted recovery confirmed · ':'')+(copies?'replicated to '+copies+' peer(s)':'waiting for peer copies')+
      (this.pendingTransfers.size?' · '+this.pendingTransfers.size+' transfers':''));
  }
  invite(){return super.invite().replace('relay://workspace/','relay://workspace-v2/');}
  proof(peer,nonce){return mac(this.config.token,Buffer.concat([Buffer.from('relay-auth-v2:'+this.config.room+':'+nonce+':'),peer.socket.handshakeHash]));}
  connect() {
    // Domain separation ensures older clients never discover a protocol 2 room.
    const factory=this.swarmFactory;
    this.swarmFactory=()=>{
      const swarm=factory?factory():new (require('hyperswarm'))({maxPeers:32});
      const join=swarm.join.bind(swarm);swarm.join=(_,options)=>join(mac(this.config.token,'relay-topic-v2:'+this.config.room),options);return swarm;
    };
    super.connect();
  }
  cleanHistory(entries){return this.cleanTimeline?this.cleanTimeline(entries):[];}
  attach(socket) {
    super.attach(socket);
    const peer=[...this.peers].find(peer=>peer.socket===socket);if(!peer)return;
    socket.on('close',()=>{
      clearTimeout(peer.sendTimer);
      if(peer.transfer&&this.pendingTransfers.get(peer.transfer.ref)===peer.transfer)this.pendingTransfers.delete(peer.transfer.ref);
      peer.sendQueue=[];peer.offers?.clear();this.status();
    });
  }

  announce(peer) {
    if(peer.socket.destroyed)return;
    if(!this.ready||[...this.manifest.getMap('files').values()].some(r=>!this.documents.has(r.id)||!this.heads[r.id])) {
      this.deferredAnnouncements=true;return;
    }
    peer.offers??=new Map();
    for(const [ref,offer] of peer.offers)if(offer.done&&offer.seq<=peer.ack)peer.offers.delete(ref);
    const offers=[...this.manifest.getMap('files')].filter(([,r])=>this.heads[r.id]).map(([name,r])=>{
      const ref=this.heads[r.id],bytes=this.getBlock(ref);return {name,id:r.id,ref,size:bytes.length};
    });
    for(const offer of offers)peer.offers.set(offer.ref,{...offer,seq:this.seq,done:false});
    // Keep advertised immutable versions available while another peer requests them.
    // A slow reader cannot pin unbounded block history.
    const pinned=new Map();
    for(const other of this.peers)for(const [ref,offer] of other.offers||[])pinned.set(ref,offer.size);
    if(peer.offers.size>20000||[...pinned.values()].reduce((n,size)=>n+size,0)>128*1024*1024){peer.socket.destroy();return;}
    this.send(peer,{type:'manifest',update:encode(Y.encodeStateAsUpdate(this.manifest)),seq:this.seq,offers,entries:this.timeline});
  }

  file(name) {
    const record=this.manifest.getMap('files').get(name),doc=record&&this.documents.get(record.id);
    if(!doc)return undefined;
    const stats=this.fileStats.get(record.id);
    return stats?.doc===doc?stats.value:fileValue(doc,record.kind);
  }
  hasFile(name){return this.manifest.getMap('files').has(name);}
  textIdentity(name) {
    const record=this.manifest.getMap('files').get(name);
    return record?.kind==='text'&&this.documents.has(record.id)?record.id:null;
  }
  textSnapshot(name) {
    const record=this.manifest.getMap('files').get(name),doc=record&&this.documents.get(record.id);
    if(record?.kind!=='text'||!doc)return null;
    return {protocol:2,name,identity:record.id,update:Y.encodeStateAsUpdate(doc),doc};
  }
  applyTextUpdate(name,update,identity) {
    const snapshot=this.textSnapshot(name);
    if(!snapshot||snapshot.identity!==identity)throw new Error('The shared file was deleted or replaced. Keep your unsaved editor copy.');
    const candidate=new Y.Doc();
    try{Y.applyUpdate(candidate,snapshot.update);Y.applyUpdate(candidate,update);validateFileDoc(candidate,'text');
      this.edit(name,candidate.getText('content').toString(),update);
    }finally{candidate.destroy();}
  }
  edit(name,value,textUpdate) {
    const loaded=this.manifest.getMap('files').get(name);
    if(this.closed||!this.ready&&(!loaded||!this.documents.has(loaded.id)))throw new Error('Wait for this verified file before editing.');
    if(!sharedPath(name))throw new Error('Unsafe shared path.');
    const before=this.files().get(name);
    if(!textUpdate&&(equalValue(before,value)||(before===undefined&&value===null)))return;
    const kind=typeof value==='string'?'text':'binary';
    if(value!==null)validateValue(value,kind);
    const record=this.manifest.getMap('files').get(name);
    if(record&&value!==null&&record.kind!==kind)throw new Error('Delete the file before changing its text/binary kind.');
    const manifest=new Y.Doc();Y.applyUpdate(manifest,Y.encodeStateAsUpdate(this.manifest));
    const id=record?.id || crypto.randomBytes(16).toString('hex'),doc=new Y.Doc();
    if(record)Y.applyUpdate(doc,Y.encodeStateAsUpdate(this.documents.get(id)));
    const vector=Y.encodeStateVector(doc);
    try {
      if(value===null)manifest.getMap('files').delete(name);
      else {
        if(!record)manifest.getMap('files').set(name,{id,kind});
        if(textUpdate)Y.applyUpdate(doc,textUpdate);else if(kind==='text') {const text=doc.getText('content'),change=delta(text.toString(),value);doc.transact(()=>{text.delete(change.start,change.length);text.insert(change.start,change.text);});}
        else doc.getMap('asset').set('bytes',value.binary);
      }
      this.validateManifest(manifest);
      let total=value===null?0:valueBytes(value);
      for(const [other,current] of this.files())if(other!==name)total+=valueBytes(current);
      if(total>PROJECT_LIMIT)throw new Error('Project exceeds the 16 MB beta limit.');
      if(value!==null)validateFileDoc(doc,kind);
      const beforeRef=record?this.heads[id]:null,afterRef=value===null?null:this.putBlock(blockSeal(this.config,Y.encodeStateAsUpdate(doc)));
      const entry={id:crypto.randomUUID(),file:name,fileId:id,kind:record?.kind||kind,actor:this.config.name||'Teammate',
        time:new Date().toISOString(),beforeRef,afterRef,deleted:value===null,created:!record,stats:changeStats(before,value,record?.kind||kind)};
      // Save the complete staged index before mutating the visible session.
      const snapshot=this.snapshot();snapshot.manifest=encode(Y.encodeStateAsUpdate(manifest));
      snapshot.heads=Object.fromEntries([...manifest.getMap('files').values()].map(r=>[r.id,r.id===id?afterRef:this.heads[r.id]]).filter(([,ref])=>ref));snapshot.timeline=this.cleanTimeline([entry,...this.timeline]);
      let storageError;
      try{this.flushBlocks();this.checkpoint?.(sealSnapshot(this.config.token,snapshot));}catch(error){storageError=error;}
      this.emit('before-change',name);
      Y.applyUpdate(this.manifest,Y.encodeStateAsUpdate(manifest));
      if(value!==null){this.documents.get(id)?.destroy();this.documents.set(id,doc);this.heads[id]=afterRef;}
      this.timeline=snapshot.timeline;this.pruneDocuments();this.seq++;this.localDurable=!storageError;
      if(storageError){this.storageProblem=storageError.message;if(this.recovery)this.saveLatest(snapshot).catch(()=>{});else this.emit('problem','Local save failed; keep the editor open. '+storageError.message);}
      for(const peer of this.peers)if(peer.authenticated) {
        if(record&&value!==null && Y.encodeStateAsUpdate(doc,vector).length<CHUNK)
          this.send(peer,{type:'file-update',id,update:encode(Y.encodeStateAsUpdate(doc,vector)),seq:this.seq,entry});
        else if(this.ready)this.announce(peer);
        else this.deferredAnnouncements=true;
      }
      this.emit('change',{file:name,before,after:value,actor:entry.actor,actorKey:'local:'+this.doc.clientID,origin:'local',id:entry.id,binary:entry.kind==='binary'});
      this.emit('files',this.files());this.emit('activity',this.timeline);this.status();
    }catch(error){doc.destroy();throw error;}
    finally{manifest.destroy();if(value===null)doc.destroy();}
  }
  version(entry,side) {
    const ref=entry[side+'Ref'];if(ref===null)return null;
    const bytes=this.getBlock(ref);if(!bytes)throw new Error('This version is no longer available on this device.');
    const doc=new Y.Doc();try{Y.applyUpdate(doc,blockOpen(this.config,bytes));return fileValue(doc,entry.kind);}finally{doc.destroy();}
  }
  proposal(entry) {
    const before=this.version(entry,'before'),after=this.version(entry,'after'),current=this.files().get(entry.file)??null;
    if(entry.kind==='binary'||before===null||after===null) {
      if(!equalValue(current,after))throw new Error('Newer changes overlap this restore. Review or restore into a separate Git branch.');
      return {file:entry.file,expected:hash(JSON.stringify(current)),value:before};
    }
    const {createPatch,applyPatch}=require('diff');
    const value=applyPatch(current,createPatch(entry.file,after,before),{fuzzFactor:0});
    if(value===false)throw new Error('Newer changes overlap this restore. Review or restore into a separate Git branch.');
    return {file:entry.file,expected:hash(JSON.stringify(current)),value};
  }
  applyProposal(proposal) {
    if(hash(JSON.stringify(this.files().get(proposal.file)??null))!==proposal.expected)throw new Error('The file changed during review. Generate a new proposal.');
    this.edit(proposal.file,proposal.value);
  }
  checkpointProject(label,git={}) {
    const entry={id:crypto.randomUUID(),label:String(label).slice(0,100),time:new Date().toISOString(),git,
      files:[...this.manifest.getMap('files')].map(([file,r])=>({file,...r,ref:this.heads[r.id]||null}))};
    this.checkpoints=[entry,...this.checkpoints].slice(0,20);this.persist();this.emit('activity',this.timeline);return entry;
  }

  send(peer,message) {
    const length=Buffer.byteLength(JSON.stringify(message));if(this.metrics)this.metrics.sentBytes+=length;
    if(typeof peer.socket.on!=='function')return super.send(peer,message);
    peer.sendQueue=peer.sendQueue||[];peer.sendSize=(peer.sendSize||0)+length;
    if(peer.sendSize>MAX_FRAME*2){peer.socket.destroy();return;}
    peer.sendQueue.push({message,length});
    if(peer.sendTimer)return;
    const drain=()=>{
      peer.sendTimer=null;if(peer.socket.destroyed){peer.sendQueue=[];peer.sendSize=0;return;}
      const next=peer.sendQueue.shift();if(!next)return;
      peer.sendSize-=next.length;super.send(peer,next.message);
      if(peer.sendQueue.length){peer.sendTimer=setTimeout(drain,7);peer.sendTimer.unref?.();}
    };
    peer.sendTimer=setTimeout(drain,7);peer.sendTimer.unref?.();
  }

  receive(peer,message) {
    if(!peer.authenticated) {
      if(message.type==='proof') {
        const ready=this.ready;this.ready=false;try{super.receive(peer,message);}finally{this.ready=ready;}
        if(peer.authenticated&&this.ready)this.announce(peer);return;
      }
      return super.receive(peer,message);
    }
    this.metrics.receivedBytes+=Buffer.byteLength(JSON.stringify(message));
    if(message.type==='manifest') {
      if(!Number.isSafeInteger(message.seq)||message.seq<0||!Array.isArray(message.offers)||message.offers.length>10000)throw new Error('Invalid manifest offer.');
      const advertised=new Y.Doc();Y.applyUpdate(advertised,decodeState(message.update));this.validateManifest(advertised);
      const offered=new Set();
      for(const offer of message.offers){
        if(!offer||!sharedPath(offer.name)||advertised.getMap('files').get(offer.name)?.id!==offer.id||
          !/^[a-f0-9]{64}$/.test(offer.ref)||!Number.isInteger(offer.size)||offer.size<32||offer.size>FILE_STATE_LIMIT+65536)throw new Error('Invalid file transfer offer.');
        if(offered.has(offer.id))throw new Error('Duplicate file offer.');offered.add(offer.id);
      }
      for(const [,record] of advertised.getMap('files'))if(!offered.has(record.id))throw new Error('Incomplete file manifest offer.');
      advertised.destroy();
      const candidate=new Y.Doc();try{Y.applyUpdate(candidate,Y.encodeStateAsUpdate(this.manifest));Y.applyUpdate(candidate,decodeState(message.update));this.validateManifest(candidate);
        const deletions=[];
        for(const [file,r] of this.manifest.getMap('files'))if(!candidate.getMap('files').has(file)&&this.heads[r.id])
          deletions.push({id:crypto.randomUUID(),file,fileId:r.id,kind:r.kind,actor:peer.name||'Teammate',time:new Date().toISOString(),beforeRef:this.heads[r.id],afterRef:null,deleted:true,stats:changeStats(this.files().get(file),null,r.kind)});
        const staged=this.snapshot();staged.manifest=encode(Y.encodeStateAsUpdate(candidate));staged.heads=Object.fromEntries([...candidate.getMap('files').values()].filter(r=>this.heads[r.id]).map(r=>[r.id,this.heads[r.id]]));staged.initialized=this.ready&&[...candidate.getMap('files').values()].every(r=>this.documents.has(r.id));staged.timeline=this.cleanTimeline([...deletions,...this.timeline]);
        try{this.flushBlocks();this.checkpoint?.(sealSnapshot(this.config.token,staged));}
        catch(error){this.localDurable=false;this.storageProblem=error.message;if(!this.recovery)throw error;}
        Y.applyUpdate(this.manifest,decodeState(message.update));this.timeline=staged.timeline;this.ready=staged.initialized;this.pruneDocuments();}finally{candidate.destroy();}
      this.timeline=this.cleanTimeline(this.timeline);
      peer.manifestSeq=message.seq;peer.offerComplete=false;peer.waiting=new Map();
      for(const offer of message.offers) {
        if(this.manifest.getMap('files').get(offer.name)?.id!==offer.id)continue;
        if(this.heads[offer.id]===offer.ref)continue;
        peer.waiting.set(offer.id,offer);
      }
      this.requestNext(peer);return;
    }
    if(message.type==='want') {
      if(!/^[a-f0-9]{64}$/.test(message.ref||'')||!Number.isInteger(message.offset)||message.offset<0||message.offset%CHUNK!==0)throw new Error('Invalid transfer request.');
      const bytes=this.getBlock(message.ref);
      const offered=peer.offers?.get(message.ref);
      if(!bytes || message.offset>=bytes.length || !offered || offered.id!==message.id)throw new Error('Unknown file transfer.');
      if(message.offset+CHUNK>=bytes.length)offered.done=true;
      this.send(peer,{type:'chunk',id:message.id,ref:message.ref,offset:message.offset,data:encode(bytes.subarray(message.offset,message.offset+CHUNK))});return;
    }
    if(message.type==='chunk') {
      const transfer=peer.transfer;
      if(!transfer||message.id!==transfer.id||message.ref!==transfer.ref||message.offset!==transfer.offset||typeof message.data!=='string'||message.data.length>Math.ceil(CHUNK/3)*4)throw new Error('Unexpected file chunk.');
      const bytes=Buffer.from(message.data,'base64');
      if(bytes.length!==Math.min(CHUNK,transfer.size-transfer.offset))throw new Error('Incomplete file chunk.');
      this.storeChunk?.(transfer.ref,transfer.offset,bytes);transfer.chunks.push(bytes);transfer.offset+=bytes.length;
      if(transfer.offset<transfer.size){this.nextChunk(peer);return;}
      const block=Buffer.concat(transfer.chunks);
      if(hash(block)!==transfer.ref)throw new Error('File transfer checksum mismatch.');
      const record=this.record(transfer.id);
      const finish=()=>{peer.waiting.delete(transfer.id);this.pendingTransfers.delete(transfer.ref);peer.transfer=null;this.metrics.filesReceived++;return this.requestNext(peer);};
      const durable=record?this.mergeFile(peer,transfer.id,block,peer.manifestSeq,null):null;
      return durable?.then?durable.then(finish):finish();
    }
    if(message.type==='file-update') {
      const record=this.record(message.id);if(!record)throw new Error('Unknown updated file.');
      if(!Number.isSafeInteger(message.seq)||message.seq<0)throw new Error('Invalid file update sequence.');
      return this.mergeFile(peer,message.id,decodeState(message.update),message.seq,message.entry,true);
    }
    if(message.type==='ack'||message.type==='presence')return super.receive(peer,message);
    throw new Error('Unknown protocol 2 message.');
  }
  nextChunk(peer){this.send(peer,{type:'want',id:peer.transfer.id,ref:peer.transfer.ref,offset:peer.transfer.offset});}
  requestNext(peer) {
    if(peer.transfer)return;
    const offer=peer.waiting?.values().next().value;
    if(!offer) {
      const initial=!this.ready;peer.offerComplete=true;
      this.ready=[...this.manifest.getMap('files').values()].every(r=>this.documents.has(r.id)&&this.heads[r.id]);
      if(!this.ready){this.status();return;}
      let durable;try{durable=this.persist();}catch(error){if(initial)this.ready=false;throw error;}
      if(durable?.then)return durable.then(()=>this.finishManifest(peer,initial)).catch(error=>{if(initial)this.ready=false;throw error;});
      return this.finishManifest(peer,initial);
    }
    const transfer={...offer,offset:0,chunks:[]};peer.transfer=transfer;this.pendingTransfers.set(offer.ref,transfer);
    while(transfer.offset<transfer.size) {
      const saved=this.loadChunk?.(transfer.ref,transfer.offset);
      if(!saved||saved.length!==Math.min(CHUNK,transfer.size-transfer.offset))break;
      transfer.chunks.push(saved);transfer.offset+=saved.length;this.metrics.chunksReused++;
    }
    if(transfer.offset===transfer.size) {
      const block=Buffer.concat(transfer.chunks);
      if(hash(block)!==transfer.ref)throw new Error('Cached transfer checksum mismatch.');
      const finish=()=>{peer.waiting.delete(transfer.id);peer.transfer=null;this.pendingTransfers.delete(transfer.ref);return this.requestNext(peer);};
      const durable=this.mergeFile(peer,transfer.id,block,peer.manifestSeq,null);return durable?.then?durable.then(finish):finish();
    } else this.nextChunk(peer);
    this.status();
  }
  finishManifest(peer,initial) {
      this.send(peer,{type:'ack',seq:peer.manifestSeq});
      for(const other of this.peers)if(other!==peer&&other.authenticated&&other.offerComplete)this.send(other,{type:'ack',seq:other.manifestSeq});
      if(initial||this.deferredAnnouncements) {
        this.deferredAnnouncements=false;
        for(const other of this.peers)if(other.authenticated)this.announce(other);
      }
      if(initial)this.emit('connected');
      this.emit('files',this.files());this.emit('activity',this.timeline);this.status();return;
  }
  mergeFile(peer,id,bytes,seq,entry,raw=false) {
    const [name,record]=this.record(id),existing=this.documents.get(id),candidate=new Y.Doc();
    const before=existing?fileValue(existing,record.kind):undefined,beforeRef=this.heads[id]||null,vector=existing?Y.encodeStateVector(existing):null,originalState=existing?Y.encodeStateAsUpdate(existing):null;
    try {
      if(existing)Y.applyUpdate(candidate,originalState);
      Y.applyUpdate(candidate,raw?bytes:blockOpen(this.config,bytes));validateFileDoc(candidate,record.kind);this.validateProject(id,candidate);
      const after=fileValue(candidate,record.kind),state=Y.encodeStateAsUpdate(candidate);
      if(originalState&&Buffer.from(state).equals(Buffer.from(originalState))) {
        candidate.destroy();this.metrics.duplicateUpdates=(this.metrics.duplicateUpdates||0)+1;
        if(raw&&!peer.transfer&&!peer.waiting?.size&&(this.localDurable||this.cloudState===this.recoveryHash()))this.send(peer,{type:'ack',seq});
        return;
      }

      const ref=this.putBlock(!raw&&Buffer.from(state).equals(blockOpen(this.config,bytes))?bytes:blockSeal(this.config,state));
      const next=this.snapshot();next.heads={...this.heads,[id]:ref};
      const activity={id:crypto.randomUUID(),file:name,fileId:id,kind:record.kind,actor:peer.name||'Teammate',time:new Date().toISOString(),beforeRef,afterRef:ref,created:!existing,stats:changeStats(before,after,record.kind)};
      if(!equalValue(before,after))next.timeline=this.cleanTimeline([activity,...this.timeline]);
      const beforeState=this.recoveryHash();
      let durable;
      try{this.flushBlocks();this.checkpoint?.(sealSnapshot(this.config.token,next));}
      catch(error){this.localDurable=false;if(!this.recovery)throw error;durable=this.recovery.save(this.archive(next,{[ref]:this.getBlock(ref)}));}
      const apply=()=>{
      if(this.closed){candidate.destroy();return;}
      if(this.recoveryHash()!==beforeState){candidate.destroy();return this.mergeFile(peer,id,bytes,seq,entry,raw);}
      this.emit('before-change',name);
      this.documents.set(id,candidate);existing?.destroy();this.heads[id]=ref;this.timeline=next.timeline;this.localDurable=!durable;
      if(durable)this.cloudState=this.recoveryHash(next);
      if(raw&&!peer.transfer&&!peer.waiting?.size)this.send(peer,{type:'ack',seq});
      this.seq++;
      const update=vector?Y.encodeStateAsUpdate(candidate,vector):null;
      for(const other of this.peers)if(other.authenticated&&other!==peer) {
        if(update&&update.length<CHUNK)this.send(other,{type:'file-update',id,update:encode(update),seq:this.seq,entry:activity});
        else this.announce(other);
      }
      if(!equalValue(before,after)) {
        this.emit('change',{file:name,before,after,actor:activity.actor,actorKey:peer.id||peer.name||'remote',origin:'remote',id:activity.id,binary:record.kind==='binary'});
        if(this.ready)this.emit('activity',this.timeline);
      }
      if(this.ready)this.emit('files',this.files(),name);
      this.status();
      };
      return durable?durable.then(apply).catch(error=>{candidate.destroy();throw error;}):apply();
    }catch(error){candidate.destroy();this.localDurable=false;throw error;}
  }



  pruneDocuments() {
    const ids=new Set([...this.manifest.getMap('files').values()].map(r=>r.id));
    for(const [id,doc] of this.documents)if(!ids.has(id)){doc.destroy();this.documents.delete(id);this.fileStats.delete(id);delete this.heads[id];}
  }
  trimVersions() {
    const refs=new Set(Object.values(this.snapshot().heads));let budget=0;
    const add=ref=>{
      if(!ref||refs.has(ref))return true;
      const bytes=this.getBlock(ref);if(!bytes)return false;
      if(budget+bytes.length>128*1024*1024)return false;
      budget+=bytes.length;refs.add(ref);return true;
    };
    for(const peer of this.peers)for(const [ref] of peer.offers||[])add(ref);
    this.timeline=this.timeline.filter(entry=>add(entry.beforeRef)&&add(entry.afterRef));
    this.checkpoints=this.checkpoints.filter(checkpoint=>Array.isArray(checkpoint.files)&&checkpoint.files.every(file=>add(file.ref)));
    if(this.pruneBlocks)this.pruneBlocks(refs);else for(const ref of this.blocks.keys())if(!refs.has(ref)&&!this.unsavedBlocks.has(ref))this.blocks.delete(ref);
  }
  archive(snapshot=this.snapshot(),extra={}) {
    const blocks={},refs=new Set(Object.values(snapshot.heads));
    for(const ref of refs) {
      const bytes=extra[ref]||this.getBlock(ref);if(!bytes)throw new Error('Recovery file block is missing.');
      blocks[ref]=encode(bytes);
    }
    return {...snapshot,blocks,baseline:undefined,timeline:[],checkpoints:[]};
  }
  recoveryHash(snapshot=this.snapshot()){return hash(snapshot.manifest+JSON.stringify(snapshot.heads));}
  saveLatest(snapshot=this.snapshot()) {
    this.savePending=this.archive(snapshot);
    if(this.saveFlight)return this.saveFlight;
    this.saveFlight=(async()=>{
      while(this.savePending&&!this.closed) {
        const next=this.savePending;this.savePending=null;await this.recovery.save(next);this.cloudState=this.recoveryHash(next);
      }
    })().catch(error=>{if(!this.closed)this.emit('problem','Encrypted recovery failed: '+error.message+'. Keep a local or peer copy.');throw error;})
      .finally(()=>{this.saveFlight=null;this.status();});
    return this.saveFlight;
  }
  async recoverNow() {
    if(this.closed||!this.recovery||this.recoveryBusy||(this.recoveryChecked&&!this.recoveryNeeded()))return;
    this.recoveryBusy=true;
    try {
      const archives=await this.recovery.read();this.recoveryChecked=true;
      for(const archive of archives) {
        if(this.closed)return;if(archive.protocol!==2||!archive.initialized)continue;
        const beforeState=this.recoveryHash(),merged=mergeArchives(this.config,this.archive(),archive),snapshot={...this.snapshot(),manifest:merged.manifest,heads:merged.heads,initialized:true};
        for(const [ref,bytes] of Object.entries(merged.blocks))this.putBlock(Buffer.from(bytes,'base64'));
        let failed=false;try{this.checkpoint?.(sealSnapshot(this.config.token,snapshot));}catch{failed=true;await this.recovery.save(merged);}
        if(this.recoveryHash()!==beforeState){this.recoveryChecked=false;continue;}
        Y.applyUpdate(this.manifest,decodeState(merged.manifest));this.pruneDocuments();
        for(const [id,ref] of Object.entries(merged.heads))this.install(id,this.getBlock(ref));
        this.localDurable=!failed;this.cloudState=failed?this.recoveryHash(snapshot):null;
        if(!this.ready){this.ready=true;this.emit('connected');}
        for(const peer of this.peers)if(peer.authenticated)this.announce(peer);
        this.emit('files',this.files());
      }
      if(this.ready&&this.recoveryNeeded()&&this.cloudState!==this.recoveryHash())await this.saveLatest();
    }catch(error){if(!this.closed)this.emit('problem','Cloud recovery unavailable: '+error.message);}
    finally{this.recoveryBusy=false;this.status();}
  }

  async close(){if(this.closed)return;for(const peer of this.peers)clearTimeout(peer.sendTimer);await super.close();this.manifest?.destroy();for(const doc of this.documents?.values()||[])doc.destroy();}
}

function mergeArchives(config,left,right) {
  const session=new FileSession({...config,recovery:undefined}),manifest=session.manifest;
  try {
    for(const archive of [left,right]) {
      if(!archive||archive.protocol!==2||!archive.blocks||typeof archive.manifest!=='string')throw new Error('Invalid recovery archive.');
      Y.applyUpdate(manifest,decodeState(archive.manifest));session.validateManifest();
    }
    const heads={},blocks={};
    for(const [,record] of manifest.getMap('files')) {
      const doc=new Y.Doc();
      try {
        for(const archive of [left,right]) {
          const ref=archive.heads?.[record.id];if(!ref)continue;
          const encoded=archive.blocks[ref];
          if(typeof encoded!=='string'||encoded.length>Math.ceil((FILE_STATE_LIMIT+65536)/3)*4)throw new Error('Missing recovery file block.');
          const bytes=Buffer.from(encoded,'base64');if(hash(bytes)!==ref)throw new Error('Recovery block checksum mismatch.');
          Y.applyUpdate(doc,blockOpen(config,bytes));
        }
        validateFileDoc(doc,record.kind);session.documents.set(record.id,doc);
        const bytes=blockSeal(config,Y.encodeStateAsUpdate(doc)),ref=hash(bytes);heads[record.id]=ref;blocks[ref]=encode(bytes);
      }catch(error){doc.destroy();throw error;}
    }
    session.validateProject();
    return {protocol:2,manifest:encode(Y.encodeStateAsUpdate(manifest)),heads,blocks,initialized:left.initialized||right.initialized,timeline:[]};
  }finally{session.close();}
}
class PeerSession {
  constructor(config,options){return config.protocol===2?new FileSession(config,options):new LegacyPeerSession(config,options);}
}
function createWorkspace(title,files,options={}) {
  const config={mode:'p2p',room:crypto.randomBytes(16).toString('hex'),token:crypto.randomBytes(32).toString('hex'),title};
  if(options.protocol===2)config.protocol=2;
  const session=new PeerSession(config,{initialFiles:files});session.close();return config;
}
module.exports={mergeArchives,blockSeal,PeerSession,FileSession,LegacyPeerSession,parseInvite,createWorkspace,validateDoc,sealSnapshot,openSnapshot,hash,blockOpen,CHUNK};

module.exports.TextBinding=TextBinding;
