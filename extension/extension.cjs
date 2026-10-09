const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Y = require('yjs');
const { PeerSession: Session, createWorkspace, parseInvite, hash, TextBinding } = require('./peer-session.cjs');
const { collect, sharedPath, safeTarget, writeSharedFile, delta, selected, changeDescription } = require('./files.cjs');
const {Recovery,endpoint}=require('./recovery.cjs');
const {openSnapshot}=require('./peer-session.cjs');
let active, context, status, team, changes, timelineTree, checksTree, checksCollection, mirrorQueue = Promise.resolve();
const editorBindings=new Map(), diskTimers=new Map();
const codeIssues=new Map(), recentFunctions=new Map(), reviewDocuments=new Map(), codeTimers=new Map(), codeChanges=new Map();
const stateKey = root => crypto.createHash('sha256').update(root).digest('hex');
const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const fail = error => {
  const message=String(error.message || error);
  const category=/Could not apply teammate/.test(message)?'teammate-apply':
    /transfer/i.test(message)?'transfer':/ENOSPC|disk full|storage/i.test(message)?'storage':'operation';
  // Categories make background diagnosis possible without logging code, file paths or invitations.
  console.error('Relay failure ['+category+']');
  return vscode.window.showErrorMessage('Relay: '+message);
};
class Tree {
  constructor(kind) { this.kind = kind; this.changed = new vscode.EventEmitter(); this.onDidChangeTreeData = this.changed.event; }
  refresh() { this.changed.fire(); }
  getTreeItem(item) { return item; }
  getChildren() {
    if (!active) return [];
    if (this.kind === 'team') return active.members.map(member => {
      const item = new vscode.TreeItem(member.name);
      item.description = member.file || 'Connected'; item.iconPath = new vscode.ThemeIcon('account');
      if (member.file && sharedPath(member.file)) item.command = { command:'vscode.open',title:'Open file',arguments:[vscode.Uri.file(safeTarget(folder(),member.file))] };
      return item;
    });
    if(this.kind==='checks')return [...codeIssues.values()].flat().map(issue=>{
      const item=new vscode.TreeItem(issue.message);item.description=issue.file;item.iconPath=new vscode.ThemeIcon(issue.warning?'warning':'symbol-method');
      item.command={command:'vscode.open',title:'Review teammate change',arguments:[vscode.Uri.file(safeTarget(folder(),issue.file)),{selection:issue.range}]};return item;
    });
    if(this.kind==='timeline')return (active.checkpoints||[]).map(checkpoint=>{
      const item=new vscode.TreeItem(checkpoint.label);item.description=checkpoint.time;item.tooltip=JSON.stringify(checkpoint.git);
      item.command={command:'relay.inspectCheckpoint',title:'Inspect checkpoint',arguments:[checkpoint]};return item;
    });
    return active.history.map(entry => {
      const item = new vscode.TreeItem(`${entry.actor} · ${entry.file}`);
      item.description = changeDescription(entry,active.changeStats?.(entry));
      item.tooltip = entry.time+'\n'+(entry.fileId?'Full saved version on this device; names are self-declared':'Review preview (first 8 KB per side; names are self-declared)');
      item.iconPath = new vscode.ThemeIcon('diff');
      item.command = { command:'relay.review',title:'Review change',arguments:[entry] };
      return item;
    });
  }
}
async function localSource(root, options = {}) {
  const gathered=await collect(root,options);
  for(const document of vscode.workspace.textDocuments) {
    if(document.uri.scheme!=='file' || !document.uri.fsPath.startsWith(root+path.sep))continue;
    const relative=path.relative(root,document.uri.fsPath).split(path.sep).join('/');
    if(!sharedPath(relative)||!selected(relative,options.exclude||[]))continue;
    try {safeTarget(root,relative);}catch{continue;}
    // Native editors can open binary files as lossy text; retain their byte representation.
    if(typeof gathered.files[relative]==='object' || gathered.skipped.includes(relative+' (binary)'))continue;
    const text=document.getText();
    if(text.includes('\0'))continue;
    if(Buffer.byteLength(text)>(options.large?2*1024*1024:512*1024))
      throw new Error('Unsaved file exceeds the sharing limit: '+relative+'. Save it outside the shared files or exclude it.');
    gathered.files[relative]=text;
  }
  const values=Object.values(gathered.files);
  const bytes=values.reduce((n,value)=>n+(typeof value==='string'?Buffer.byteLength(value):Buffer.from(value.binary,'base64').length),0);
  if(bytes>(options.large?16:1)*1024*1024 || values.length>(options.large?10000:1000))
    throw new Error('Unsaved editor content exceeds the shared project limit. Adjust sharing exclusions.');
  return gathered;
}
async function identity() {
  const name = await vscode.window.showInputBox({ title:'Relay',prompt:'Your name, shown to teammates',value:context.globalState.get('relay.name',''),validateInput:value=>value.trim() ? undefined : 'Enter your name.' });
  if (!name) return;
  await context.globalState.update('relay.name',name.trim().slice(0,40)); return name.trim().slice(0,40);
}
async function remember(root, config) {
  const key = stateKey(root), { token, ...metadata } = config;
  await context.secrets.store(`relay.token.${key}`,token);
  await context.globalState.update(`relay.session.${key}`,metadata);
}
async function saved(root) {
  const key = stateKey(root), metadata = context.globalState.get(`relay.session.${key}`), token = await context.secrets.get(`relay.token.${key}`);
  return metadata && token ? { ...metadata,token } : null;
}

function documentName(root,document) {
  if(document.uri.scheme!=='file'||!document.uri.fsPath.startsWith(root+path.sep))return null;
  const name=path.relative(root,document.uri.fsPath).split(path.sep).join('/');
  return sharedPath(name)?name:null;
}
function editorBinding(root,session,document) {
  const name=documentName(root,document);if(!name||!selected(name,session.config.sharing?.exclude||[]))return null;
  const key=document.uri.toString(),existing=editorBindings.get(key);
  if(existing?.session===session&&existing.binding.identity===session.textIdentity(name))return existing;
  const snapshot=session.textSnapshot(name);if(!snapshot)return null;
  if(existing){clearTimeout(existing.timer);existing.binding.destroy();editorBindings.delete(key);}
  const binding=new TextBinding(snapshot,document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n');
  // Never invent CRDT ancestry for editor contents that are not this shared version.
  if(binding.text!==document.getText()){binding.destroy();return null;}
  const state={session,name,binding,timer:null};editorBindings.set(key,state);return state;
}
function flushEditorState(state) {
  clearTimeout(state.timer);state.timer=null;
  if(!state.binding.dirty||state.session.closed)return;
  safeTarget(folder(),state.name);
  const snapshot=state.session.textSnapshot(state.name);
  if(!snapshot)throw new Error('The shared file was deleted. Keep your unsaved editor copy.');
  const update=state.binding.update(snapshot);
  state.session.applyTextUpdate(state.name,update,state.binding.identity);
  state.binding.dirty=false;state.session.status();
}
function flushEditorEdits(session) {
  for(const state of editorBindings.values())if(state.session===session)flushEditorState(state);
}
function hasPendingEdits(session) {
  return [...editorBindings.values()].some(state=>state.session===session&&state.binding.dirty);
}
function scheduleEditorFlush(root,state) {
  if(state.timer)return; // A fixed window flushes during continuous typing; it is not a trailing debounce.
  state.timer=setTimeout(()=>{
    state.timer=null;
    try{flushEditorState(state);queueMirror(root,state.session);}catch(error){fail(error);}
  },32);
}
function acceptMirror(state,pending) {
  if(pending.accepted)return;
  state.binding.doc.destroy();state.binding.doc=pending.candidate.doc;state.binding.dirty=false;pending.accepted=true;
}
function receiveEditorChange(event) {
  const session=active,root=folder();
  if(!session||session.closed||!root)return;
  if(!event.contentChanges.length) {
    const state=editorBindings.get(event.document.uri.toString());
    if(state?.session===session)state.binding.eol=event.document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n';
    return;
  }
  const name=documentName(root,event.document);
  if(!name||!selected(name,session.config.sharing?.exclude||[])||typeof session.file(name)==='object')return;
  if(!session.ready && !(session.config.protocol===2&&session.textSnapshot(name)))return;
  try {
    try{safeTarget(root,name);}catch{return;} // Never publish an editor opened through a symlink.
    // A newly created text file has no shared ancestry yet.
    if(!session.hasFile(name))session.edit(name,event.document.getText());
    const state=editorBinding(root,session,event.document)||editorBindings.get(event.document.uri.toString());
    if(!state||state.session!==session)throw new Error('The editor and shared file versions differ. Keep the unsaved copy open while Relay resynchronizes.');
    const pending=state.binding.pending;
    if(pending&&!pending.accepted&&event.document.version===pending.version+1&&event.document.getText()===pending.after&&
       event.contentChanges.length===1&&event.contentChanges[0].rangeOffset===pending.edit.start&&
       event.contentChanges[0].rangeLength===pending.edit.length&&event.contentChanges[0].text===pending.edit.text) {
      acceptMirror(state,pending);return;
    }
    if(state.binding.text===event.document.getText())return;
    state.binding.edit(event.contentChanges,event.document.getText(),event.document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n');
    if(status){status.text='$(sync~spin) Syncing local edits';status.tooltip='Recent keystrokes are pending a shared checkpoint';}
    scheduleEditorFlush(root,state);
  }catch(error){fail(error);}
}
function retryMirror(root,session,name) {
  if(name){session.mirrorDirty??=new Set();session.mirrorDirty.add(name);}
  if(session.mirrorRetry||session.closed||active!==session)return;
  session.mirrorRetry=setTimeout(()=>{session.mirrorRetry=null;queueMirror(root,session);},25);
}

function disconnect() {
  for(const timer of diskTimers.values())clearTimeout(timer);diskTimers.clear();
  if(active){try{flushEditorEdits(active);}catch(error){fail(error);}clearTimeout(active.mirrorRetry);}
  for(const state of editorBindings.values()){clearTimeout(state.timer);state.binding.destroy();}editorBindings.clear();
  active?.close().catch(fail); active = null; team?.refresh(); changes?.refresh();timelineTree?.refresh();checksTree?.refresh();checksCollection?.clear();codeIssues.clear();recentFunctions.clear();for(const timer of codeTimers.values())clearTimeout(timer);codeTimers.clear();codeChanges.clear();
  vscode.commands.executeCommand('setContext','relay.connected',false);
  if (status) { status.text='$(organization) Relay'; status.tooltip='Invite or join a team workspace'; }
}

async function mirror(root, session) {
  if(active!==session)return;
  clearTimeout(session.mirrorRetry);session.mirrorRetry=null;
  flushEditorEdits(session);
  let changed=false;
  const wanted=session.mirrorAll?null:new Set(session.mirrorDirty||[]);
  session.mirrorAll=false;session.mirrorDirty?.clear();
  const files=session.files();
  for(const [name,text] of files) {
    if(!selected(name,session.config.sharing?.exclude||[]))continue;
    if(wanted&&!wanted.has(name))continue;
    if(active!==session)return;
    if(session.externalConflicts?.has(name))continue;
    const target=safeTarget(root,name),uri=vscode.Uri.file(target);
    const document=vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString());
    if(typeof text!=='string') {
      const bytes=Buffer.from(text.binary,'base64');
      if(document?.isDirty)throw new Error('Save or close the edited binary view before replacing '+name);
      if(session.file(name)?.binary!==text.binary)continue;
      const digest=hash(JSON.stringify(text));
      if(session.baseline[name]!==digest||!fs.existsSync(target)) {
        writeSharedFile(root,name,bytes);
        session.baseline[name]=digest;changed=true;
      }
      continue;
    }
    if(session.diskStates?.has(name)&&fs.existsSync(target)&&hash(fs.readFileSync(target))!==session.baseline[name]) {
      const adopted=await readDiskChange(root,session,uri);
      if(adopted)retryMirror(root,session,name);
      continue;
    }
    const nativeText=document?text.replace(/\r\n|\r|\n/g,document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n'):text;
    if(document&&document.getText()!==nativeText) {
      const state=editorBinding(root,session,document)||editorBindings.get(uri.toString());
      const edit=delta(document.getText(),nativeText),batch=new vscode.WorkspaceEdit();
      const version=document.version,candidate=new TextBinding(session.textSnapshot(name),document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n');
      const pending={version,after:nativeText,edit,candidate,accepted:false};
      if(state)state.binding.pending=pending;
      batch.replace(uri,new vscode.Range(document.positionAt(edit.start),document.positionAt(edit.start+edit.length)),edit.text);
      let applied;
      try {
        if(active!==session)return;
        applied=await (session.editorApplyEdit||vscode.workspace.applyEdit)(batch);
        if(applied&&state&&!pending.accepted&&document.getText()===nativeText)acceptMirror(state,pending);
      }finally{
        if(state?.binding.pending===pending)state.binding.pending=null;
        if(!pending.accepted)candidate.destroy();
      }
      if(active!==session)return;
      if(!applied) {
        const racing=document.version!==version||session.file(name)!==text||state?.binding.dirty;
        session.editorRejections??=new Map();
        const count=racing?0:(session.editorRejections.get(name)||0)+1;session.editorRejections.set(name,count);
        if(count>=3)throw new Error('Could not apply teammate changes to '+name+'. Keep the editor copy open and check whether the file is writable.');
        retryMirror(root,session,name);continue;
      }
      session.editorRejections?.delete(name);
      if(!state)editorBinding(root,session,document);
    }
    // A newer keystroke or peer update invalidates this materialization.
    if(session.file(name)!==text||document&&document.getText()!==nativeText) {retryMirror(root,session,name);continue;}
    const digest=hash(text);
    if(!fs.existsSync(target)||(session.baseline[name]!==digest&&fs.readFileSync(target,'utf8')!==text)) {
      writeSharedFile(root,name,Buffer.from(text,'utf8'));
    }
    if(session.baseline[name]!==digest){session.baseline[name]=digest;changed=true;}
    rememberDiskState(session,name,text);
    if(document) {
      const state=editorBinding(root,session,document);
      if(state&&!state.binding.dirty&&!state.binding.pending) {
        const candidate=new TextBinding(session.textSnapshot(name),document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n');
        if(candidate.text===document.getText()){state.binding.destroy();state.binding=candidate;}
        else candidate.destroy();
      }
    }
  }
  for(const name of session.materialized||[])if(selected(name,session.config.sharing?.exclude||[])&&(!wanted||wanted.has(name))&&!session.hasFile(name)) {
    const target=safeTarget(root,name);
    if(fs.existsSync(target))await vscode.workspace.fs.delete(vscode.Uri.file(target),{useTrash:true});
    delete session.baseline[name];changed=true;
  }
  session.materialized=new Set(Object.keys(session.baseline));
  if(changed)session.persist()?.catch(()=>{});
}
function rememberDiskState(session,name,value,snapshot=session.textSnapshot?.(name)) {
  if(typeof value!=='string'||!snapshot)return;
  session.diskStates??=new Map();
  session.diskStates.delete(name);
  session.diskStates.set(name,{value,snapshot:{protocol:snapshot.protocol,name:snapshot.name,identity:snapshot.identity,update:snapshot.update}});
  let size=0;for(const state of session.diskStates.values())size+=state.snapshot.update.byteLength+Buffer.byteLength(state.value);
  // Eviction requires explicit conflict review if a newer editor version cannot be anchored safely.
  for(const [key,state] of session.diskStates) {
    if(size<=64*1024*1024)break;
    size-=state.snapshot.update.byteLength+Buffer.byteLength(state.value);session.diskStates.delete(key);
  }
}
function adoptDiskText(root,session,name,value,document) {
  flushEditorEdits(session);
  const current=session.file(name),snapshot=session.textSnapshot(name),base=session.diskStates?.get(name);
  if(value===current) {
    session.externalConflicts?.delete(name);
    session.baseline[name]=hash(value);rememberDiskState(session,name,value);return;
  }
  if(base&&snapshot&&base.snapshot.identity===snapshot.identity) {
    const binding=new TextBinding(base.snapshot);
    try {
      const edit=delta(base.value,value);
      binding.edit([{rangeOffset:edit.start,rangeLength:edit.length,text:edit.text}],value);
      session.applyTextUpdate(name,binding.update(snapshot),binding.identity);
      rememberDiskState(session,name,value,{...base.snapshot,update:Y.encodeStateAsUpdate(binding.doc)});
    }finally{binding.destroy();}
  } else {
    if(typeof current==='string'&&session.baseline[name]&&hash(current)!==session.baseline[name]) {
      session.externalConflicts??=new Set();session.externalConflicts.add(name);
      throw new Error('An external edit has no matching saved version. Both copies are preserved; review the disk file and editor before saving.');
    }
    if(document?.isDirty&&typeof current!=='string')throw new Error('An external replacement overlaps an unsaved editor. Preserve both copies before saving.');
    session.edit(name,value);rememberDiskState(session,name,value);
  }
  session.externalConflicts?.delete(name);
  session.baseline[name]=hash(value);
  session.persist()?.catch(()=>{});
}
async function readDiskChange(root,session,uri) {
  if(!session||session.closed)return false;
  const name=path.relative(root,uri.fsPath).split(path.sep).join('/');
  if(!sharedPath(name)||!selected(name,session.config.sharing?.exclude||[]))return false;
  if(!session.ready&&session.file(name)===undefined)return false;
  const document=vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString());
  try {
    const target=safeTarget(root,name);
    if(!fs.existsSync(target)) {
      if(!session.hasFile(name))return false;
      if(document?.isDirty)throw new Error('External deletion overlaps an unsaved editor; the editor copy is preserved.');
      session.edit(name,null);delete session.baseline[name];session.diskStates?.delete(name);return true;
    }
    if(!fs.statSync(target).isFile())return false;
    const bytes=fs.readFileSync(target);
    if(bytes.length>(session.config.protocol===2?2*1024*1024:512*1024))throw new Error('External file exceeds the sharing limit; its disk contents are preserved.');
    let value;
    try{if(bytes.includes(0))throw new Error('Binary');value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    catch {
      if(!session.config.sharing?.binary&&!(session.config.protocol===2&&typeof session.file(name)==='object'))return false;
      value={binary:bytes.toString('base64')};
    }
    const diskHash=hash(typeof value==='string'?value:JSON.stringify(value));
    if(session.baseline[name]===diskHash)return false;
    if(typeof value==='string')adoptDiskText(root,session,name,value,document);
    else {
      if(document?.isDirty)throw new Error('External binary replacement overlaps an unsaved editor; both copies are preserved.');
      session.edit(name,value);session.baseline[name]=diskHash;session.diskStates?.delete(name);
    }
    session.mirrorDirty??=new Set();session.mirrorDirty.add(name);queueMirror(root,session);
    return true;
  }catch(error){
    session.externalConflicts??=new Set();session.externalConflicts.add(name);fail(error);return false;
  }
}
function scheduleDiskChange(root,uri) {
  const key=uri.toString(),session=active;
  if(!session)return;
  clearTimeout(diskTimers.get(key));
  diskTimers.set(key,setTimeout(()=>{
    diskTimers.delete(key);
    if(active!==session||session.closed)return;
    if(!session.ready&&session.file(path.relative(root,uri.fsPath).split(path.sep).join('/'))===undefined) {
      scheduleDiskChange(root,uri);return;
    }
    readDiskChange(root,session,uri);
  },40));
}

function queueMirror(root,session) {
  if(active!==session||session.closed)return;
  if(!session.mirrorDirty?.size)session.mirrorAll=true;
  if(session.mirrorQueued){session.mirrorAgain=true;return;}
  session.mirrorQueued=true;
  mirrorQueue=mirrorQueue.then(()=>mirror(root,session)).catch(error=>{
    if(session.recovery&&!session.closed)session.saveLatest().catch(()=>{});
    if(active===session){session.emit('mirror-problem',error);fail(error);}
  }).finally(()=>{
    session.mirrorQueued=false;
    if(session.mirrorAgain){session.mirrorAgain=false;if(session.mirrorAll||session.mirrorDirty?.size)queueMirror(root,session);}
  });
}
async function start(root, config, baseline, options = {}) {
  disconnect();
  try{fs.mkdirSync(context.globalStorageUri.fsPath,{recursive:true});}catch(error){if(!config.recovery)throw error;}
  const cache = path.join(context.globalStorageUri.fsPath,`${stateKey(root + config.mode + config.room)}.yjs`);
  let cached=null;
  try {
    cached=fs.existsSync(cache)?fs.readFileSync(cache):null;
    if(cached)openSnapshot(config.token,cached);
  } catch(error) {
    if(!config.recovery)throw error;
    cached=null;
    vscode.window.showWarningMessage('Relay local cache could not be read. Trying encrypted recovery; existing source will be backed up first.');
  }
  if(config.recovery && !config.recoveryDevice) {
    config.recoveryDevice=crypto.randomBytes(16).toString('hex');
    await remember(root,config);
  }
  // A missing/corrupt CRDT cache has no reliable ancestry. Preserve current source
  // before recovering, rather than silently overwriting potentially newer work.
  if(config.recovery && !cached && !baseline) {
    const local=await localSource(root,{allowEmpty:true});
    if(Object.keys(local.files).length) {
      const recoveryRoot=path.join(root,'.relay');
      if(fs.existsSync(recoveryRoot) && fs.lstatSync(recoveryRoot).isSymbolicLink())throw new Error('Recovery backup directory must not be a symbolic link.');
      const backup=path.join(recoveryRoot,'recovery-source-'+Date.now());
      for(const [name,text] of Object.entries(local.files)) {
        const target=path.join(backup,...name.split('/'));
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text,{mode:0o600});
      }
      vscode.window.showWarningMessage('Relay preserved your current source in '+backup+' before attempting recovery. Compare it after recovery.');
    }
  }
  if (config.mode !== 'p2p') throw new Error('This folder uses the old cloud backend. Use Relay: Migrate to Peer Workspace to create a new local workspace.');
  const lock=cache+'.lock';
  if(fs.existsSync(lock)) {
    let owner;try{owner=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw new Error('Relay cache lock cannot be read. Preserve the cache before recovery.');}
    let live=false;try{process.kill(owner.pid,0);live=true;}catch(error){if(error.code==='EPERM')live=true;}
    if(live)throw new Error('This workspace already has an active Relay session. Close its other editor window first.');
    fs.unlinkSync(lock);
  }
  const lockFd=fs.openSync(lock,'wx',0o600);try{fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid}));}finally{fs.closeSync(lockFd);}
  const blockRoot=cache+'.blocks',chunkRoot=cache+'.chunks';
  const atomic=(filename,bytes)=>{
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    if(fs.existsSync(filename)&&fs.lstatSync(filename).isSymbolicLink())throw new Error('Cache must not follow symlinks.');
    const temporary=filename+'.'+crypto.randomUUID()+'.tmp';
    const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
    try {
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,filename);
    }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  };
  const blockPath=(root,ref,offset)=>{
    if(!/^[a-f0-9]{64}$/.test(ref)||offset!==undefined&&(!Number.isInteger(offset)||offset<0))throw new Error('Invalid saved block.');
    return path.join(root,ref+(offset===undefined?'':'.'+offset));
  };
  let session;
  try{session = active = new Session(config,{
    pruneBlocks:refs=>{
      if(!fs.existsSync(blockRoot))return;
      for(const name of fs.readdirSync(blockRoot))if(/^[a-f0-9]{64}$/.test(name)&&!refs.has(name))fs.unlinkSync(path.join(blockRoot,name));
    },
    storeBlock:(ref,bytes)=>atomic(blockPath(blockRoot,ref),bytes),
    loadBlock:ref=>{const filename=blockPath(blockRoot,ref);return fs.existsSync(filename)?fs.readFileSync(filename):null;},
    storeChunk:(ref,offset,bytes)=>{
      if(fs.existsSync(chunkRoot)) {
        const entries=fs.readdirSync(chunkRoot).filter(name=>/^[a-f0-9]{64}\.\d+$/.test(name));
        if(entries.length>=1024 && !fs.existsSync(blockPath(chunkRoot,ref,offset))) {
          const oldest=entries.map(name=>({name,time:fs.statSync(path.join(chunkRoot,name)).mtimeMs})).sort((a,b)=>a.time-b.time).slice(0,128);
          for(const entry of oldest)fs.unlinkSync(path.join(chunkRoot,entry.name));
        }
      }
      atomic(blockPath(chunkRoot,ref,offset),bytes);
    },
    loadChunk:(ref,offset)=>{const filename=blockPath(chunkRoot,ref,offset);return fs.existsSync(filename)?fs.readFileSync(filename):null;},
    swarmFactory:options.swarmFactory,cached,initialFiles:cached ? undefined : baseline,checkpoint:bytes=>{
    atomic(cache,bytes);
  }});}catch(error){fs.unlinkSync(lock);throw error;}
  const originalClose=session.close.bind(session);
  session.close=()=>{
    try{if(fs.existsSync(lock)&&JSON.parse(fs.readFileSync(lock,'utf8')).pid===process.pid)fs.unlinkSync(lock);}catch{}
    return originalClose();
  };
  session.editorApplyEdit=options.applyEditorEdit;
  // Semantic operations must observe keystrokes inside the batching window.
  for(const method of ['checkpointProject','proposal','applyProposal'])if(typeof session[method]==='function') {
    const original=session[method].bind(session);
    session[method]=(...args)=>{flushEditorEdits(session);return original(...args);};
  }

  const canEdit=session.ready;
  let initializing = true;
  if (cached && canEdit) {
    const local = await localSource(root,{allowEmpty:true,large:config.protocol===2,binary:config.protocol===2,...config.sharing});
    // Reconcile only changes since the last successful disk mirror.
    // Newer cached edits survive a crash between checkpointing and materializing.
    for (const [name,text] of Object.entries(local.files)) {
      if (session.baseline[name] && session.baseline[name] !== hash(typeof text==='string'?text:JSON.stringify(text))) session.edit(name,text);
      else if (!session.baseline[name] && !session.hasFile(name)) session.edit(name,text);
    }
    for (const name of Object.keys(session.baseline)) if (!fs.existsSync(safeTarget(root,name))) session.edit(name,null);
    session.materialized=new Set(Object.keys(session.baseline));
  }
  const prepareEditors=name=>{
    for(const document of vscode.workspace.textDocuments)
      if(!name||documentName(root,document)===name)editorBinding(root,session,document);
  };
  prepareEditors();session.on('before-change',prepareEditors);
  session.on('files',(_files,changedName)=>{
    if(changedName){session.mirrorDirty??=new Set();session.mirrorDirty.add(changedName);}
    if(!initializing)queueMirror(root,session);
  });
  session.on('status',text=>{ status.text=hasPendingEdits(session)?'$(sync~spin) Syncing local edits':'$(organization) '+text; status.tooltip='Relay collaboration · click to invite'; });
  session.on('members',()=>team.refresh()); session.on('activity',()=>{changes.refresh();timelineTree?.refresh();});
  session.on('change',change=>{
    session.mirrorDirty??=new Set();session.mirrorDirty.add(change.file);
    scheduleCodeCheck(root,session,change);
  }); session.on('problem',message=>fail(message));
  session.once('connected',async()=>{
    try {
      if (baseline) {
        const local = await localSource(root,{allowEmpty:true,large:config.protocol===2,binary:config.protocol===2,...config.sharing});
        for (const [name,text] of Object.entries(local.files)) if (baseline[name] !== text) session.edit(name,text);
      }
      initializing = false;
      queueMirror(root,session);
      vscode.commands.executeCommand('setContext','relay.connected',true);
      team.refresh(); changes.refresh();
    } catch (error) { fail(error); }
  });
  session.connect();
  return session;
}
async function newFolder(selectedParent, suppliedName) {
  const parent = selectedParent || (await vscode.window.showOpenDialog({title:'Choose the parent directory',canSelectFolders:true,canSelectFiles:false,canSelectMany:false}))?.[0]?.fsPath;
  if (!parent) return;
  const name = suppliedName || await vscode.window.showInputBox({title:'Create project folder',prompt:'Project folder name',validateInput:value=>/^[\w .-]+$/.test(value) && !['.','..'].includes(value) && !/[. ]$/.test(value) ? undefined : 'Enter a folder name without path separators.'});
  if (!name) return;
  if (!/^[\w .-]+$/.test(name) || ['.','..'].includes(name) || /[. ]$/.test(name)) throw new Error('Invalid project folder name.');
  const root = path.join(parent,name);
  if (fs.existsSync(root)) throw new Error('That folder already exists. Use Open Project Folder.');
  fs.mkdirSync(root);
  if (!suppliedName) await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(root),false);
  return root;
}
async function invite() {
  const root = folder();
  if (!root) return vscode.window.showInformationMessage('Open or create a project folder before inviting teammates.');
  if (!active) {
    const name = await identity(); if (!name) return;
    const sharing=context.globalState.get('relay.sharing.'+stateKey(root),{exclude:[],binary:false});
    const gathered = await localSource(root,{large:true,...sharing});
    const details = 'Share '+Object.keys(gathered.files).length+' files directly with peers? '+gathered.skipped.length+' paths excluded. Binary sharing is '+(sharing.binary?'enabled (whole-file replacements)':'disabled')+'. Dependency/build directories, credential files and symlinks are excluded. Anyone with the invite can edit. At least one device with the latest copy must be online for a teammate to download it.';
    if (await vscode.window.showInformationMessage(details,{modal:true},'Share workspace') !== 'Share workspace') return;
    const config = createWorkspace(path.basename(root),gathered.files,{protocol:2});
    config.sharing=sharing;
    config.name = name; await remember(root,config); await start(root,config,gathered.files);
  }
  await vscode.env.clipboard.writeText(active.invite());
  vscode.window.showInformationMessage('Private invite copied. Send it only to trusted teammates. Recovery-enabled invites can use the last uploaded encrypted copy when peers are unavailable.');
}
async function join() {
  const link = await vscode.window.showInputBox({title:'Join a Relay workspace',prompt:'Paste the full invite link',ignoreFocusOut:true});
  if (!link) return;
  const config = parseInvite(link), name = await identity(); if (!name) return;
  const picked = (await vscode.window.showOpenDialog({title:'Choose an empty folder for the shared project',canSelectFolders:true,canSelectFiles:false,canSelectMany:false}))?.[0];
  if (!picked) return;
  if (fs.readdirSync(picked.fsPath).length) throw new Error('Choose an empty folder to keep your existing files safe.');
  config.name = name;
  await remember(picked.fsPath,config);
  if (folder() === picked.fsPath) await start(picked.fsPath,config);
  else await vscode.commands.executeCommand('vscode.openFolder',picked,false);
}
async function enableRecovery() {
  const root=folder();if(!root||!active)throw new Error('Invite or join a peer workspace first.');
  const config={...active.config};
  const value=await vscode.window.showInputBox({title:'Encrypted recovery',prompt:'Supabase relay-recovery function URL',
    value:config.recovery?.url || context.globalState.get('relay.recovery.url',require('./recovery-default.json').url),ignoreFocusOut:true,
    validateInput:value=>{try{endpoint(value);return undefined;}catch(error){return error.message;}}});
  if(!value)return;
  config.recovery={url:endpoint(value),policy:'failure-only'};
  config.recoveryDevice=config.recoveryDevice || crypto.randomBytes(16).toString('hex');
  const client=new Recovery(config);
  try {
    try{await client.request('list');}
    catch {
      const setup=await vscode.window.showInputBox({title:'Enable recovery for this workspace',prompt:'Owner recovery setup code (kept out of invites)',password:true,ignoreFocusOut:true,
        validateInput:value=>/^[a-f0-9]{64}$/.test(value)?undefined:'Enter the 64-character setup code.'});
      if(!setup)return;
      await client.provision(setup);
    }
  }finally{client.close();}
  await remember(root,config);
  await context.globalState.update('relay.recovery.url',config.recovery.url);
  await start(root,config);
  await vscode.env.clipboard.writeText(active.invite());
  vscode.window.showInformationMessage('Encrypted failure-only recovery enabled. Updated invitation copied; share it with teammates so they can recover too.');
}
async function disableRecovery() {
  const root=folder();if(!root||!active)return;
  if(!active.localDurable)throw new Error('Restore local storage before disabling your recovery fallback.');
  const config={...active.config};delete config.recovery;
  await remember(root,config);await start(root,config);
  vscode.window.showInformationMessage('Cloud fallback disabled on this device. Existing encrypted recovery copies and previously shared invitations remain valid.');
}
async function importLegacy() {
  const directory = process.env.RELAY_LEGACY_DATA_DIR;
  if (!directory || !fs.existsSync(directory)) throw new Error('No previous Relay workspaces were found on this computer.');
  const available = fs.readdirSync(directory).filter(name=>/^[a-f0-9]{16}\.json$/.test(name)).map(name=>{
    const data=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8')); return {label:data.name || 'Workspace',description:data.id,data};
  });
  const selected = await vscode.window.showQuickPick(available,{title:'Import previous Relay workspace'}); if (!selected) return;
  const destination = (await vscode.window.showOpenDialog({title:'Choose an empty folder for your previous code',canSelectFolders:true,canSelectFiles:false}))?.[0]; if (!destination) return;
  if (fs.readdirSync(destination.fsPath).length) throw new Error('Choose an empty folder for the import.');
  const Y = require('yjs'), doc = new Y.Doc();
  Y.applyUpdate(doc,Buffer.from(selected.data.state,'base64'));
  for (const [name,text] of doc.getMap('files')) if (sharedPath(name)) {
    const filename=safeTarget(destination.fsPath,name); fs.mkdirSync(path.dirname(filename),{recursive:true}); fs.writeFileSync(filename,text.toString(),'utf8');
  }
  doc.destroy();
  // Import source only. Never silently reconnect an old cloud invitation.
  await vscode.commands.executeCommand('vscode.openFolder',destination,false);
}

async function gitRepository() {
  const extension=vscode.extensions.getExtension('vscode.git');if(!extension)return null;
  const api=(await extension.activate()).getAPI(1);
  return api.repositories.find(repo=>folder()===repo.rootUri.fsPath || folder()?.startsWith(repo.rootUri.fsPath+path.sep));
}
async function gitIdentity() {const repo=await gitRepository();return {branch:repo?.state.HEAD?.name||'',commit:repo?.state.HEAD?.commit||''};}
function reviewUri(file,side){return vscode.Uri.parse('relay-review:/'+encodeURIComponent(file)+'?side='+side+'&id='+crypto.randomUUID());}
async function showComparison(file,before,after,title) {
  const left=reviewUri(file,'before'),right=reviewUri(file,'after');
  reviewDocuments.set(left.toString(),before);reviewDocuments.set(right.toString(),after);
  while(reviewDocuments.size>40)reviewDocuments.delete(reviewDocuments.keys().next().value);
  await vscode.commands.executeCommand('vscode.diff',left,right,title);
}
async function reviewEntry(entry) {
  let before=entry.before,after=entry.after;
  if(entry.fileId){before=active.version(entry,'before');after=active.version(entry,'after');}
  if(entry.kind==='binary') {
    const describe=value=>value?'Binary file · '+Buffer.from(value.binary,'base64').length+' bytes · SHA-256 '+hash(Buffer.from(value.binary,'base64')):'File absent';
    before=describe(before);after=describe(after);
  }
  await showComparison(entry.file,before||'',after||'',entry.actor+' · '+entry.file);
}
async function reviewProposal(proposal,title) {
  const session=active,current=session.file(proposal.file);
  const display=value=>typeof value==='string'?value:value===null?'File absent':'Binary file · '+valueBytesForView(value)+' bytes';
  await showComparison(proposal.file,display(current??null),display(proposal.value),title+' · '+proposal.file);
  if(await vscode.window.showInformationMessage('Review the comparison before applying. Relay will stop if the file changes.',{modal:true},'Apply reviewed change')==='Apply reviewed change') {
    if(active!==session)throw new Error('The workspace changed during review.');
    session.applyProposal(proposal);
  }
}
function valueBytesForView(value){return Buffer.from(value.binary,'base64').length;}
function scheduleCodeCheck(root,session,change) {
  if(!selected(change.file,session.config.sharing?.exclude||[]))return;
  if(typeof change.after!=='string') {
    if(change.after==null) {
      clearTimeout(codeTimers.get(change.file));codeTimers.delete(change.file);
      codeIssues.delete(change.file);codeChanges.delete(change.file);
      for(const key of recentFunctions.keys())if(key.startsWith(change.file+':'))recentFunctions.delete(key);
      checksCollection?.delete(vscode.Uri.file(safeTarget(root,change.file)));checksTree?.refresh();
      return;
    }
    if(change.binary&&change.origin==='remote'){codeIssues.set(change.file,[{file:change.file,message:change.actor+' replaced this binary file. Review the asset.',warning:false,range:new vscode.Range(0,0,0,0)}]);checksCollection?.delete(vscode.Uri.file(safeTarget(root,change.file)));checksTree?.refresh();}
    return;
  }
  const uri=vscode.Uri.file(safeTarget(root,change.file));
  const batch=codeChanges.get(change.file)||[];batch.push(change);codeChanges.set(change.file,batch.slice(-100));
  const priorTimer=codeTimers.get(change.file);if(priorTimer)clearTimeout(priorTimer);
  codeTimers.set(change.file,setTimeout(async()=>{
    codeTimers.delete(change.file);const pending=codeChanges.get(change.file)||[change];codeChanges.delete(change.file);
    try {
      await mirrorQueue;if(active!==session||typeof session.file(change.file)!=='string')return;
      const doc=await vscode.workspace.openTextDocument(uri);
      const symbols=await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',uri)||[];
      if(active!==session||typeof session.file(change.file)!=='string')return;
      let changeRange,range,currentChange;
      const makeRange=change=>{changeRange=delta(typeof change.before==='string'?change.before:'',change.after);return new vscode.Range(doc.positionAt(changeRange.start),doc.positionAt(changeRange.start+Math.max(1,changeRange.text.length)));};
      const conflicts=[], teammateChanges=new Map();
      function visit(items,parent='') {
        for(const symbol of items) {
          const symbolRange=symbol.range||symbol.location?.range,key=change.file+':'+parent+symbol.name;
          if(symbolRange&&[vscode.SymbolKind.Function,vscode.SymbolKind.Method,vscode.SymbolKind.Constructor].includes(symbol.kind)&&symbolRange.intersection(range)) {
            const previous=recentFunctions.get(key);
            if(previous && (previous.remote||currentChange.origin==='remote') && previous.actorKey!==(currentChange.actorKey||currentChange.actor) && Date.now()-previous.time<120000)
              conflicts.push({file:change.file,message:previous.actor+' and '+currentChange.actor+' changed '+symbol.name+' within two minutes. Review the combined code.',warning:true,range:symbolRange});
            if(currentChange.origin==='remote')teammateChanges.set(key,{file:change.file,message:currentChange.actor+' changed '+symbol.name+'. Review the updated function.',warning:false,range:symbolRange});
            recentFunctions.set(key,{actor:currentChange.actor,actorKey:currentChange.actorKey||currentChange.actor,remote:currentChange.origin==='remote',time:Date.now()});
          }
          if(symbol.children)visit(symbol.children,parent+symbol.name+'.');
        }
      }
      for(const event of pending){
        currentChange=event;range=makeRange(event);visit(symbols);
        if(event.origin==='remote'&&teammateChanges.size===0)
          teammateChanges.set('file',{file:change.file,message:event.actor+' changed this file. Review the updated code.',warning:false,range});
      }
      for(const [key,value] of recentFunctions)if(Date.now()-value.time>120000)recentFunctions.delete(key);
      // The panel reports collaboration activity only. Language diagnostics stay in Problems.
      if(teammateChanges.size||conflicts.length){
        codeIssues.set(change.file,[...conflicts,...teammateChanges.values()].slice(0,50));
        checksCollection?.set(uri,conflicts.map(issue=>new vscode.Diagnostic(issue.range,issue.message,vscode.DiagnosticSeverity.Warning)));
      }
      checksTree?.refresh();
    }catch(error){if(active===session&&typeof session.file(change.file)==='string')fail(error);}
  },1200));
}

async function reviewRepairs() {
  if(!active?.applyProposal)throw new Error('Repair review requires a new beta workspace.');
  const editor=vscode.window.activeTextEditor;if(!editor||!folder())throw new Error('Open the file to review available repairs.');
  const document=editor.document,file=path.relative(folder(),document.uri.fsPath).split(path.sep).join('/');
  if(!sharedPath(file)||typeof active.file(file)!=='string')throw new Error('Choose a shared text file.');
  const diagnostics=vscode.languages.getDiagnostics(document.uri).filter(d=>d.severity===vscode.DiagnosticSeverity.Error);
  const selected=await vscode.window.showQuickPick(diagnostics.map(d=>({label:d.message,d})),{title:'Choose an error for repair review'});
  if(!selected)return;
  const actions=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',document.uri,selected.d.range,vscode.CodeActionKind.QuickFix.value,20)||[];
  const safe=actions.filter(action=>action.edit&&!action.disabled&&!action.command&&action.edit.entries().every(([uri,edits])=>uri.toString()===document.uri.toString()&&edits.every(e=>e.range&&typeof e.newText==='string')));
  if(!safe.length)return vscode.window.showInformationMessage('The language extension offered no text-only repair for this error. Review the Problems panel.');
  const choice=await vscode.window.showQuickPick(safe.map(action=>({label:action.title,action})),{title:'Review a suggested repair'});
  if(!choice)return;
  const before=document.getText(),edits=choice.action.edit.get(document.uri).map(e=>({start:document.offsetAt(e.range.start),end:document.offsetAt(e.range.end),text:e.newText})).sort((a,b)=>b.start-a.start);
  let after=before,previousStart=before.length+1;
  for(const edit of edits){if(edit.end>previousStart)throw new Error('Repair has overlapping edits.');after=after.slice(0,edit.start)+edit.text+after.slice(edit.end);previousStart=edit.start;}
  await reviewProposal({file,expected:hash(JSON.stringify(before)),value:after},choice.label);
}

function activate(extensionContext) {
  context=extensionContext;
  team=new Tree('team'); changes=new Tree('changes');timelineTree=new Tree('timeline');checksTree=new Tree('checks');checksCollection=vscode.languages.createDiagnosticCollection('Relay collaboration');
  status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,20); status.command='relay.invite'; status.text='$(organization) Relay'; status.show();
  context.subscriptions.push(status,vscode.window.registerTreeDataProvider('relay.team',team),vscode.window.registerTreeDataProvider('relay.changes',changes),vscode.window.registerTreeDataProvider('relay.timeline',timelineTree),vscode.window.registerTreeDataProvider('relay.codeChecks',checksTree),checksCollection);
  const commands={
    'relay.openFolder':()=>vscode.commands.executeCommand('workbench.action.files.openFolder'),
    'relay.sharing':async()=>{
      const root=folder();if(!root)return;
      if(active)throw new Error('Disconnect before changing sharing rules. New invitations use the selected files; existing peers retain copies already shared.');
      const previous=context.globalState.get('relay.sharing.'+stateKey(root),{exclude:[],binary:false});
      const patterns=await vscode.window.showInputBox({title:'Sharing exclusions',prompt:'Comma-separated paths or globs to exclude (for example assets/**, *.log). Secrets remain excluded.',value:previous.exclude.join(',')});
      if(patterns===undefined)return;
      const binary=await vscode.window.showQuickPick(['Text files only','Include binary files as whole-file replacements'],{title:'Binary sharing'});
      if(!binary)return;
      await context.globalState.update('relay.sharing.'+stateKey(root),{exclude:patterns.split(',').map(p=>p.trim()).filter(Boolean).slice(0,100),binary:binary.startsWith('Include')});
    },
    'relay.checkpoint':async()=>{
      if(!active?.checkpointProject)throw new Error('Create a new beta workspace to use full checkpoints.');
      const label=await vscode.window.showInputBox({title:'Project checkpoint',prompt:'Name this saved point in the project'});
      if(label)active.checkpointProject(label,await gitIdentity());
    },
    'relay.inspectCheckpoint':async checkpoint=>{
      const selected=await vscode.window.showQuickPick(checkpoint.files.map(file=>({label:file.file,description:file.kind,file})),{title:checkpoint.label});
      if(!selected)return;
      const file=selected.file;
      await reviewEntry({id:checkpoint.id,file:file.file,fileId:file.id,kind:file.kind,beforeRef:file.ref,afterRef:active.manifest.getMap('files').get(file.file)?.id===file.id?active.heads[file.id]||null:null,actor:checkpoint.label});
    },
    'relay.restore':async()=>{
      if(!active?.proposal)throw new Error('Full restores require a new beta workspace.');
      const selected=await vscode.window.showQuickPick(active.timeline.map(entry=>({label:entry.file,description:entry.time+' · '+entry.actor,entry})),{title:'Undo a saved change while preserving newer edits'});
      if(selected)await reviewProposal(active.proposal(selected.entry),'Safe restore');
    },
    'relay.repairs':reviewRepairs,
    'relay.gitBranch':()=>vscode.commands.executeCommand('git.branch'),
    'relay.gitCommit':()=>vscode.commands.executeCommand('git.commit'),
    'relay.pullRequest':async()=>{
      const repo=await gitRepository(),remote=repo?.state.remotes.find(r=>r.fetchUrl?.includes('github.com'));
      const match=remote?.fetchUrl?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/),branch=repo?.state.HEAD?.name;
      if(!match||!branch||!/^[-\w./]+$/.test(branch))throw new Error('A GitHub remote and named branch are required. Push the reviewed branch using Source Control first.');
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/'+match[1]+'/'+match[2]+'/compare/'+encodeURIComponent(branch)+'?expand=1'));
    },
    'relay.enableRecovery':enableRecovery,'relay.disableRecovery':disableRecovery,
    'relay.createFolder':newFolder,'relay.invite':invite,'relay.join':join,'relay.importLegacy':importLegacy,
    'relay.migratePeers':async()=>{
      const root=folder();if(!root)return;
      if(await vscode.window.showInformationMessage('Create a new peer workspace from this local folder? Existing cloud teammates must use a new invite. Your old cloud workspace is retained.',{modal:true},'Migrate')!=='Migrate')return;
      const previous=await saved(root);
      if(previous) {
        const {token,...metadata}=previous;
        await context.secrets.store('relay.legacy.token.'+stateKey(root),token);
        await context.globalState.update('relay.legacy.session.'+stateKey(root),metadata);
      }
      disconnect();
      await context.globalState.update('relay.session.'+stateKey(root),undefined);
      await context.secrets.delete('relay.token.'+stateKey(root));
      return invite();
    },
    'relay.disconnect':async()=>{ const root=folder(); disconnect(); if(root){await context.globalState.update(`relay.session.${stateKey(root)}`,undefined);await context.secrets.delete(`relay.token.${stateKey(root)}`);} },
    'relay.terminal':()=>{ const terminal=vscode.window.createTerminal({name:'Relay',cwd:folder()});terminal.show();return terminal; },
    'relay.extensions':()=>vscode.commands.executeCommand('workbench.view.extensions'),
  };
  for (const [name,handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(name,async(...args)=>{try{return await handler(...args);}catch(error){fail(error);}}));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('relay-review',{provideTextDocumentContent:uri=>reviewDocuments.get(uri.toString()) || ''}));
  context.subscriptions.push(vscode.commands.registerCommand('relay.review',entry=>reviewEntry(entry).catch(fail)));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(receiveEditorChange));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document=>{
    if(active?.ready&&folder())editorBinding(folder(),active,document);
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document=>{
    const state=editorBindings.get(document.uri.toString());if(!state)return;
    try{flushEditorState(state);queueMirror(folder(),state.session);}catch(error){fail(error);}
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document=>{
    const key=document.uri.toString(),state=editorBindings.get(key);if(!state)return;
    try{flushEditorState(state);}catch(error){fail(error);}
    state.binding.destroy();editorBindings.delete(key);
  }));
  const root=folder();
  if (root) {
    const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root,'**/*'));
    const diskChange=uri=>scheduleDiskChange(root,uri);
    context.subscriptions.push(watcher,watcher.onDidCreate(diskChange),watcher.onDidChange(diskChange),watcher.onDidDelete(diskChange));
    saved(root).then(config=>{
      if(config?.mode==='p2p')return start(root,config);
      if(config)vscode.window.showInformationMessage('This folder has a cloud invitation. Run Relay: Migrate to Peer Workspace to switch explicitly.');
    }).catch(fail);
  } else vscode.commands.executeCommand('workbench.view.extension.relay');
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor=>{
    if(active && editor && folder())active.presence(path.relative(folder(),editor.document.uri.fsPath).split(path.sep).join('/'));
  }));
  return { Session, collect, localSource, newFolder, start, scheduleCodeCheck, codeIssues, reviewRepairs, changesTree:changes, flushEditorEdits, editorBindings };
}
function deactivate(){disconnect();}
module.exports={activate,deactivate,PeerSession:Session,TextBinding};
