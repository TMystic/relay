const Y = require('yjs');
const { WebSocket } = require('ws');
const { EventEmitter } = require('node:events');
const { sharedPath, delta } = require('../extension/files.cjs');
const encode = bytes => Buffer.from(bytes).toString('base64');
function parseInvite(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new Error('Use a full HTTPS Relay invite.');
  const query = new URLSearchParams(url.hash.slice(1));
  const room = query.get('room'), token = query.get('token');
  if (!/^[a-f0-9]{16}$/.test(room || '') || !/^[a-f0-9]{48}$/.test(token || '')) throw new Error('The invite is incomplete. Copy the entire link.');
  return { origin: url.origin, room, token };
}
class Session extends EventEmitter {
  constructor(config, { cached, initialFiles, checkpoint } = {}) {
    super(); this.config = config; this.doc = new Y.Doc(); this.closed = false; this.ready = false;
    this.seq = 0; this.ack = 0; this.members = []; this.history = []; this.checkpoint = checkpoint;
    if (cached) Y.applyUpdate(this.doc, cached, 'initial');
    if (initialFiles) this.doc.transact(() => { for (const [name,text] of Object.entries(initialFiles)) this.doc.getMap('files').set(name,new Y.Text(text)); }, 'initial');
    this.doc.on('update', (update, origin) => {
      this.checkpoint?.(Y.encodeStateAsUpdate(this.doc));
      if (origin !== 'remote' && origin !== 'initial') this.sendUpdate(update);
      this.emit('files', this.files());
    });
  }
  files() { return new Map([...this.doc.getMap('files')].filter(([name,text]) => sharedPath(name) && text instanceof Y.Text).map(([name,text]) => [name,text.toString()])); }
  edit(name, text) {
    if (!sharedPath(name)) return;
    if (text !== null) {
      const current = this.files(); current.set(name,text);
      if (current.size > 1000 || [...current.values()].reduce((sum,value)=>sum+Buffer.byteLength(value),0)>1024*1024)
        throw new Error('The shared source limit is 1 MB across 1,000 files. Your local editor remains available.');
    }
    this.doc.transact(() => {
      const files = this.doc.getMap('files');
      if (text === null) { files.delete(name); return; }
      if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) throw new Error('Shared source files must be UTF-8 text smaller than 512 KB.');
      if (!files.has(name)) { files.set(name, new Y.Text(text)); return; }
      const target = files.get(name), change = delta(target.toString(), text);
      if (change.length) target.delete(change.start, change.length);
      if (change.text) target.insert(change.start, change.text);
    }, 'local');
  }
  send(message) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  sendUpdate(update) {
    this.seq++; this.emit('status', this.ready ? 'Syncing changes…' : 'Offline · changes saved locally');
    if (this.ready) this.send({ type:'update', update:encode(update), seq:this.seq });
  }
  presence(file) { this.send({ type:'presence',file }); }
  connect() {
    if (this.closed) return;
    const url = new URL('/sync', this.config.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.emit('status', 'Connecting…');
    const ws = this.socket = new WebSocket(url);
    const timeout = setTimeout(() => ws.terminate(), 120000);
    ws.on('open', () => this.send({ type:'join',room:this.config.room,token:this.config.token,name:this.config.name }));
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'init') {
          clearTimeout(timeout); this.history = m.history; this.title = m.name; this.ready = true;
          Y.applyUpdate(this.doc, Buffer.from(m.state,'base64'),'remote');
          this.sendUpdate(Y.encodeStateAsUpdate(this.doc));
          this.emit('connected'); this.emit('activity',this.history);
        } else if (m.type === 'update') Y.applyUpdate(this.doc,Buffer.from(m.update,'base64'),'remote');
        else if (m.type === 'ack') { this.ack = Math.max(this.ack,m.seq || 0); this.emit('status',this.ack >= this.seq ? 'All changes synced' : 'Syncing changes…'); }
        else if (m.type === 'members') { this.members = m.members; this.emit('members',m.members); }
        else if (m.type === 'activity') { this.history = [m.entry,...this.history.filter(e => e.id !== m.entry.id)].slice(0,100); this.emit('activity',this.history); }
        else if (m.type === 'error') this.emit('problem',m.message);
      } catch { this.emit('problem','A collaboration message could not be read.'); }
    });
    ws.on('error', () => {});
    ws.on('close', code => {
      clearTimeout(timeout); this.ready = false;
      if (this.closed) return;
      this.emit('status','Offline · changes saved locally');
      if (code === 4003) { this.emit('problem','This invite was rejected. Join with a valid invite.'); return; }
      this.retry = setTimeout(() => this.connect(), 2000);
    });
  }
  invite() { const url = new URL(this.config.origin); url.hash = new URLSearchParams({room:this.config.room,token:this.config.token}).toString(); return url.href; }
  close() { this.closed = true; clearTimeout(this.retry); this.socket?.terminate(); this.doc.destroy(); }
}
async function publish(origin, name, files, history = []) {
  if (Object.keys(files).length>1000 || Object.values(files).reduce((sum,text)=>sum+Buffer.byteLength(text),0)>1024*1024)
    throw new Error('The shared source limit is 1 MB across 1,000 files.');
  const doc = new Y.Doc();
  try {
    doc.transact(() => { for (const [file,text] of Object.entries(files)) {
      if(!sharedPath(file) || typeof text!=='string' || Buffer.byteLength(text)>512*1024)throw new Error('Invalid shared source file.');
      doc.getMap('files').set(file,new Y.Text(text));
    } });
    const response = await fetch(new URL('/api/rooms',origin), { method:'POST',headers:{ Origin:origin,'Content-Type':'application/json' },body:JSON.stringify({name,state:encode(Y.encodeStateAsUpdate(doc)),history}),signal:AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('The online workspace could not be created. Retry when the server wakes.');
    const config = await response.json();
    parseInvite(`${origin}/#${new URLSearchParams({room:config.room,token:config.token})}`);
    return { ...config, origin };
  } finally { doc.destroy(); }
}
module.exports = { Session, publish, parseInvite };
