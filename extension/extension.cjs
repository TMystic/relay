const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Session, publish, parseInvite } = require('./session.cjs');
const { collect, sharedPath, safeTarget, delta } = require('./files.cjs');
let active, context, status, team, changes, applying = false, mirrorQueue = Promise.resolve();
const stateKey = root => crypto.createHash('sha256').update(root).digest('hex');
const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const fail = error => vscode.window.showErrorMessage(`Relay: ${error.message || error}`);
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
    return active.history.map(entry => {
      const item = new vscode.TreeItem(`${entry.actor} · ${entry.file}`);
      item.description = `+${entry.added || 0} −${entry.removed || 0}`;
      item.tooltip = `${entry.time}\nReview this teammate's changes`;
      item.iconPath = new vscode.ThemeIcon('diff');
      item.command = { command:'relay.review',title:'Review change',arguments:[entry] };
      return item;
    });
  }
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
function disconnect() {
  active?.close(); active = null; team?.refresh(); changes?.refresh();
  vscode.commands.executeCommand('setContext','relay.connected',false);
  if (status) { status.text='$(organization) Relay'; status.tooltip='Invite or join a team workspace'; }
}
async function mirror(root, session) {
  if (active !== session) return;
  applying = true;
  try {
    const files = session.files();
    for (const [name,text] of files) {
      const target = safeTarget(root,name), uri = vscode.Uri.file(target);
      const document = vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString());
      if (document && document.getText() !== text) {
        const edit = delta(document.getText(),text), batch = new vscode.WorkspaceEdit();
        batch.replace(uri,new vscode.Range(document.positionAt(edit.start),document.positionAt(edit.start+edit.length)),edit.text);
        if (!await vscode.workspace.applyEdit(batch)) throw new Error(`Could not apply teammate changes to ${name}.`);
      }
      // Only materialize this snapshot while it is still current; another edit may have arrived.
      if (session.files().get(name) !== text) continue;
      if (!fs.existsSync(target) || fs.readFileSync(target,'utf8') !== text) {
        fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,text,'utf8');
      }
    }
    for (const name of session.materialized || []) {
      if (!files.has(name)) {
        const target = safeTarget(root,name);
        if (fs.existsSync(target)) await vscode.workspace.fs.delete(vscode.Uri.file(target),{useTrash:true});
      }
    }
    session.materialized = new Set(files.keys());
  } finally { applying = false; }
}
function queueMirror(root, session) {
  mirrorQueue = mirrorQueue.then(()=>mirror(root,session)).catch(fail);
}
async function start(root, config, baseline) {
  disconnect();
  fs.mkdirSync(context.globalStorageUri.fsPath,{recursive:true});
  const cache = path.join(context.globalStorageUri.fsPath,`${stateKey(root + config.origin + config.room)}.yjs`);
  const cached = fs.existsSync(cache) ? fs.readFileSync(cache) : null;
  const session = active = new Session(config,{cached,checkpoint:bytes=>{
    fs.writeFileSync(cache+'.tmp',bytes); fs.renameSync(cache+'.tmp',cache);
  }});
  let initializing = true;
  if (cached) {
    const local = await collect(root);
    for (const [name,text] of Object.entries(local.files)) session.edit(name,text);
    for (const name of session.files().keys()) if (!fs.existsSync(safeTarget(root,name))) session.edit(name,null);
  }
  session.on('files',()=>{ if (!initializing) queueMirror(root,session); });
  session.on('status',text=>{ status.text=`$(organization) ${text}`; status.tooltip='Relay collaboration · click to invite'; });
  session.on('members',()=>team.refresh()); session.on('activity',()=>changes.refresh()); session.on('problem',message=>fail(message));
  session.once('connected',async()=>{
    try {
      if (baseline) {
        const local = await collect(root);
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
    const gathered = await collect(root);
    const openFiles = vscode.workspace.textDocuments.filter(d=>d.uri.scheme==='file' && d.uri.fsPath.startsWith(root+path.sep));
    for (const document of openFiles) {
      const relative = path.relative(root,document.uri.fsPath).split(path.sep).join('/');
      if (sharedPath(relative)) gathered.files[relative]=document.getText();
    }
    const details = `Share ${Object.keys(gathered.files).length} source files online? Dependency/build directories, .env files, binaries and symlinks are excluded. Anyone with the invite can edit the shared source.`;
    if (await vscode.window.showInformationMessage(details,{modal:true},'Share workspace') !== 'Share workspace') return;
    const origin = new URL(vscode.workspace.getConfiguration('relay').get('serverUrl')).origin;
    if (!origin.startsWith('https://')) throw new Error('Configure an HTTPS Relay server.');
    const config = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Sharing workspace online · the server may take a minute to wake'},()=>publish(origin,path.basename(root),gathered.files));
    config.name = name; await remember(root,config); await start(root,config,gathered.files);
  }
  await vscode.env.clipboard.writeText(active.invite());
  vscode.window.showInformationMessage('Public invite copied. Send it to your teammates.');
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
  const share = path.join(directory,`${selected.data.id}.share.json`);
  if (fs.existsSync(share)) {
    const config=JSON.parse(fs.readFileSync(share,'utf8')); config.name=context.globalState.get('relay.name','Teammate'); await remember(destination.fsPath,config);
  }
  await vscode.commands.executeCommand('vscode.openFolder',destination,false);
}
function activate(extensionContext) {
  context=extensionContext;
  team=new Tree('team'); changes=new Tree('changes');
  status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,20); status.command='relay.invite'; status.text='$(organization) Relay'; status.show();
  context.subscriptions.push(status,vscode.window.registerTreeDataProvider('relay.team',team),vscode.window.registerTreeDataProvider('relay.changes',changes));
  const commands={
    'relay.openFolder':()=>vscode.commands.executeCommand('workbench.action.files.openFolder'),
    'relay.createFolder':newFolder,'relay.invite':invite,'relay.join':join,'relay.importLegacy':importLegacy,
    'relay.disconnect':async()=>{ const root=folder(); disconnect(); if(root){await context.globalState.update(`relay.session.${stateKey(root)}`,undefined);await context.secrets.delete(`relay.token.${stateKey(root)}`);} },
    'relay.terminal':()=>{ const terminal=vscode.window.createTerminal({name:'Relay',cwd:folder()});terminal.show();return terminal; },
    'relay.extensions':()=>vscode.commands.executeCommand('workbench.view.extensions'),
  };
  for (const [name,handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(name,async(...args)=>{try{return await handler(...args);}catch(error){fail(error);}}));
  const review=new Map();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('relay-review',{provideTextDocumentContent:uri=>review.get(uri.toString()) || ''}));
  context.subscriptions.push(vscode.commands.registerCommand('relay.review',async entry=>{
    const before=vscode.Uri.parse(`relay-review:/${encodeURIComponent(entry.file)}?id=${entry.id}&side=before`),after=vscode.Uri.parse(`relay-review:/${encodeURIComponent(entry.file)}?id=${entry.id}&side=after`);
    review.set(before.toString(),entry.before);review.set(after.toString(),entry.after);
    await vscode.commands.executeCommand('vscode.diff',before,after,`${entry.actor} · ${entry.file}`);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{
    if (!active || event.document.uri.scheme!=='file' || !folder()) return;
    const name=path.relative(folder(),event.document.uri.fsPath).split(path.sep).join('/');
    try{if (sharedPath(name) && active.files().get(name)!==event.document.getText()) active.edit(name,event.document.getText());}catch(error){fail(error);}
  }));
  const root=folder();
  if (root) {
    const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root,'**/*'));
    const diskChange=async uri=>{
      if (!active || applying) return;
      const name=path.relative(root,uri.fsPath).split(path.sep).join('/'); if(!sharedPath(name))return;
      if(vscode.workspace.textDocuments.some(d=>d.uri.toString()===uri.toString() && d.isDirty))return;
      try {
        const target=safeTarget(root,name);
        if(!fs.existsSync(target)){active.edit(name,null);return;}
        if(!fs.statSync(target).isFile())return;
        const bytes=fs.readFileSync(target);if(bytes.includes(0) || bytes.length>512*1024)return;
        active.edit(name,new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      } catch(error){fail(error);}
    };
    context.subscriptions.push(watcher,watcher.onDidCreate(diskChange),watcher.onDidChange(diskChange),watcher.onDidDelete(diskChange));
    saved(root).then(config=>{if(config)return start(root,config);}).catch(fail);
  } else vscode.commands.executeCommand('workbench.view.extension.relay');
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor=>{
    if(active && editor && folder())active.presence(path.relative(folder(),editor.document.uri.fsPath).split(path.sep).join('/'));
  }));
  return { Session, collect, newFolder, start };
}
function deactivate(){disconnect();}
module.exports={activate,deactivate};
