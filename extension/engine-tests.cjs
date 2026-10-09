const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const vscode=require('vscode');
exports.run=async()=>{
  const base=process.env.RELAY_ENGINE_TEST_ROOT;
  if(!base)throw new Error('Set RELAY_ENGINE_TEST_ROOT.');
  const result=process.env.RELAY_ENGINE_TEST_RESULT;
  let server, peer, host;
  const checks=[];
  try{
    const extension=vscode.extensions.getExtension('TMystic.relay-collaboration');
    assert.ok(extension);const api=await extension.activate();
    const commands=await vscode.commands.getCommands(true);
    for(const command of ['relay.openFolder','relay.createFolder','relay.terminal','relay.extensions','relay.invite','relay.join','relay.enableRecovery','relay.disableRecovery','relay.checkpoint','relay.restore','relay.repairs','relay.sharing','relay.pullRequest'])assert.ok(commands.includes(command));
    checks.push('Native folder, terminal, extensions and collaboration commands registered');
    const parent=path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath);
    const created=await vscode.commands.executeCommand('relay.createFolder',parent,'Created project '+Date.now());
    assert.ok(fs.statSync(created).isDirectory());checks.push('Create Folder creates a real filesystem folder');
    const createTestnet=require(path.join(base,'node_modules/hyperdht/testnet'));
    const Hyperswarm=require(path.join(base,'node_modules/hyperswarm'));
    const net=await createTestnet(3);
    server={close:()=>net.destroy()};
    const factory=()=>new Hyperswarm({dht:net.createNode({firewalled:false})});
    const crypto=require('node:crypto');
    const config={protocol:2,mode:'p2p',room:crypto.randomBytes(16).toString('hex'),token:crypto.randomBytes(32).toString('hex'),name:'Native editor tester',sharing:{exclude:['private/**'],binary:false}};
    const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
    let interceptMirror=null;
    host=await api.start(root,config,{'src/main.js':'// Native project\n'},{swarmFactory:factory,
      applyEditorEdit:batch=>interceptMirror?interceptMirror(batch):vscode.workspace.applyEdit(batch)});
    const mirrorProblems=[];host.on('mirror-problem',e=>mirrorProblems.push(e.message));
    await host.swarm.flush();
    await until(()=>host.ready && fs.existsSync(path.join(root,'src/main.js')));
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'src/main.js')));
    await vscode.window.showTextDocument(document);
    peer=new api.Session({...config,name:'Native editor tester'},{swarmFactory:factory});peer.connect();
    await until(()=>peer.ready);
    const edit=new vscode.WorkspaceEdit();edit.insert(document.uri,new vscode.Position(0,0),'// Native editor changed this\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(()=>peer.files().get('src/main.js').includes('Native editor changed this'));
    const localItem=api.changesTree.getChildren().find(item=>item.label.endsWith('src/main.js'));
    assert.equal(localItem.description,'+1 \u22120');
    checks.push('Real TextDocument edits reach a second collaborative client with correct Live Changes counts');
    peer.edit('src/main.js','// Remote peer changed this\n'+peer.files().get('src/main.js'));
    await until(()=>document.getText().includes('Remote peer changed this'));
    assert.ok(document.getText().includes('Native editor changed this'));
    const remoteItem=api.changesTree.getChildren().find(item=>item.label.endsWith('src/main.js'));
    assert.equal(remoteItem.description,'+1 \u22120');
    await vscode.commands.executeCommand(remoteItem.command.command,...remoteItem.command.arguments);
    assert.ok(vscode.window.tabGroups.all.flatMap(group=>group.tabs).some(tab=>tab.input instanceof vscode.TabInputTextDiff));
    checks.push('Remote edits update the native editor; Live Changes counts and review diff work');
    // Reproduce a native document-version rejection while real keystrokes arrive.
    let raced=false;
    interceptMirror=async batch=>{
      interceptMirror=null;raced=true;
      const typingEditor=await vscode.window.showTextDocument(document);
      const end=document.positionAt(document.getText().length);typingEditor.selection=new vscode.Selection(end,end);
      for(const character of 'System.out.println("fast typing");\n')
        await vscode.commands.executeCommand('type',{text:character});
      return false; // The editor rejected the teammate edit after its version changed.
    };
    peer.edit('src/main.js','// Concurrent teammate marker\n'+peer.files().get('src/main.js'));
    await until(()=>raced);
    await until(()=>document.getText().includes('System.out.println("fast typing");') &&
      document.getText().includes('Concurrent teammate marker') && document.getText()===peer.files().get('src/main.js'));
    assert.deepEqual(mirrorProblems,[]);
    checks.push('Fast typing survives a rejected stale teammate edit and converges without sync errors');
    peer.edit('Main.java','class Main {\n  // LOCAL:\n}\n');
    await until(()=>fs.existsSync(path.join(root,'Main.java')));
    const javaDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'Main.java')));
    const javaEditor=await vscode.window.showTextDocument(javaDoc);
    const localPosition=javaDoc.positionAt(javaDoc.getText().indexOf('// LOCAL:')+'// LOCAL:'.length);
    javaEditor.selection=new vscode.Selection(localPosition,localPosition);
    const code='System.out.println("continuous typing");';
    let typedLength=0,remoteCount=0;
    for(const character of code) {
      await vscode.commands.executeCommand('type',{text:character});typedLength+=character.length;
      if(typedLength%3===0) {
        peer.edit('Main.java',peer.files().get('Main.java')+'// teammate '+remoteCount+'\n');remoteCount++;
      }
    }
    await until(()=>javaDoc.getText()===peer.files().get('Main.java')&&javaDoc.getText().includes(code));
    for(let i=0;i<remoteCount;i++)assert.ok(javaDoc.getText().includes('// teammate '+i+'\n'));
    const begin=javaDoc.getText().indexOf(code);
    javaEditor.selection=new vscode.Selection(javaDoc.positionAt(begin),javaDoc.positionAt(begin+code.length));
    await vscode.commands.executeCommand('deleteLeft');
    const pasted='System.out.println("pasted");';
    await vscode.commands.executeCommand('type',{text:pasted});
    api.flushEditorEdits(host);
    await until(()=>javaDoc.getText()===peer.files().get('Main.java')&&javaDoc.getText().includes(pasted));
    assert.equal(javaDoc.getText().includes(code),false);
    assert.deepEqual(mirrorProblems,[]);
    checks.push('Continuous typing, backspace and paste converge with simultaneous teammate edits');
    const last=javaDoc.positionAt(javaDoc.getText().length);
    javaEditor.selections=[new vscode.Selection(0,0,0,0),new vscode.Selection(last,last)];
    await vscode.commands.executeCommand('type',{text:'// multi\n'});api.flushEditorEdits(host);
    await until(()=>javaDoc.getText()===peer.files().get('Main.java'));
    assert.ok(javaDoc.getText().startsWith('// multi\n')&&javaDoc.getText().endsWith('// multi\n'));
    checks.push('Native multi-cursor changes and explicit pending-edit flush preserve all edits');

    host.edit('pending.js','// pending boundary\n');
    await until(()=>fs.existsSync(path.join(root,'pending.js')));
    const pendingDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'pending.js')));
    const pendingEditor=await vscode.window.showTextDocument(pendingDoc);
    pendingEditor.selection=new vscode.Selection(pendingDoc.positionAt(pendingDoc.getText().length),pendingDoc.positionAt(pendingDoc.getText().length));
    let instant,observedPending=false,checkpointError;
    const checkpointListener=vscode.workspace.onDidChangeTextDocument(event=>{
      if(event.document===pendingDoc&&event.document.getText().includes('FINAL_CHECKPOINT_TOKEN')&&!instant) {
        observedPending=[...api.editorBindings.values()].some(s=>s.name==='pending.js'&&s.binding.dirty);
        try{instant=host.checkpointProject('Immediately after typing');}catch(error){checkpointError=error;}
      }
    });
    await vscode.commands.executeCommand('type',{text:'FINAL_CHECKPOINT_TOKEN'});checkpointListener.dispose();
    if(checkpointError)throw checkpointError;
    assert.ok(observedPending,'fixture must hit the pending edit window');assert.ok(instant);
    assert.equal(host.file('pending.js'),pendingDoc.getText(),'a checkpoint must include pending native keystrokes');
    const savedFile=instant.files.find(f=>f.file==='pending.js');
    assert.equal(host.version({...savedFile,afterRef:savedFile.ref},'after'),pendingDoc.getText());
    checks.push('Immediate project checkpoints include the final pending native keystrokes');

    host.edit('guard.js','// first\n');host.edit('guard.js','// reviewed version\n');
    await until(()=>fs.existsSync(path.join(root,'guard.js')));
    const guardDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'guard.js')));
    await until(()=>guardDoc.getText()===host.file('guard.js'));
    const guarded=host.proposal(host.timeline.find(e=>e.file==='guard.js'));
    const guardEditor=await vscode.window.showTextDocument(guardDoc);
    guardEditor.selection=new vscode.Selection(guardDoc.positionAt(guardDoc.getText().length),guardDoc.positionAt(guardDoc.getText().length));
    let restoreError,restoreObservedPending=false;
    const restoreListener=vscode.workspace.onDidChangeTextDocument(event=>{
      if(event.document===guardDoc&&event.document.getText().includes('UNREVIEWED_LOCAL_TOKEN')&&!restoreError) {
        restoreObservedPending=[...api.editorBindings.values()].some(s=>s.name==='guard.js'&&s.binding.dirty);
        try{host.applyProposal(guarded);}catch(error){restoreError=error;}
      }
    });
    await vscode.commands.executeCommand('type',{text:'UNREVIEWED_LOCAL_TOKEN'});restoreListener.dispose();
    assert.ok(restoreObservedPending);assert.match(restoreError?.message||'',/changed during review/);
    assert.equal(host.file('guard.js'),guardDoc.getText());
    checks.push('Restore review rejects pending local edits rather than overwriting them');

    host.edit('windows-eol.js','// CRLF source\r\n// second\r\n');
    await until(()=>fs.existsSync(path.join(root,'windows-eol.js')));
    const eolDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'windows-eol.js')));
    const eolEditor=await vscode.window.showTextDocument(eolDoc);
    assert.equal(eolDoc.eol,vscode.EndOfLine.CRLF);
    eolEditor.selection=new vscode.Selection(0,0,0,0);
    await vscode.commands.executeCommand('type',{text:'// local CRLF\r\n'});api.flushEditorEdits(host);
    await until(()=>eolDoc.getText()===peer.file('windows-eol.js')?.replace(/\r\n|\r|\n/g,'\r\n'));
    peer.edit('windows-eol.js','// teammate uses LF\n'+peer.file('windows-eol.js'));
    await until(()=>eolDoc.getText()===peer.file('windows-eol.js')?.replace(/\r\n|\r|\n/g,'\r\n'));
    assert.equal((eolDoc.getText().match(/teammate uses LF/g)||[]).length,1);
    checks.push('CRLF native documents converge with teammates using LF without echo duplication');



    peer.edit('windows-eol.js',peer.file('windows-eol.js').replace(/\r\n|\r|\n/g,'\n'));
    await until(()=>host.file('windows-eol.js')===peer.file('windows-eol.js')&&!host.mirrorQueued);
    await new Promise(resolve=>setTimeout(resolve,100));
    const hiddenEditor=await vscode.window.showTextDocument(eolDoc);
    const replaceAt=eolDoc.getText().indexOf('second');
    assert.ok(replaceAt>=0);
    hiddenEditor.selection=new vscode.Selection(eolDoc.positionAt(replaceAt),eolDoc.positionAt(replaceAt+'second'.length));
    await vscode.commands.executeCommand('type',{text:'REPLACED_SOURCE'});api.flushEditorEdits(host);
    await until(()=>eolDoc.getText()===peer.file('windows-eol.js')?.replace(/\r\n|\r|\n/g,'\r\n')&&peer.file('windows-eol.js').includes('REPLACED_SOURCE'));
    assert.equal(eolDoc.getText().includes('second'),false);
    checks.push('Invisible shared line-ending rewrites preserve the ancestry of the next native replacement');


    const snapshot=peer.textSnapshot('windows-eol.js');
    const Y=require(path.join(base,'node_modules/yjs')),rewritten=new Y.Doc();
    Y.applyUpdate(rewritten,snapshot.update);
    const original=rewritten.getText('content').toString();
    rewritten.getText('content').delete(0,original.length);rewritten.getText('content').insert(0,original);
    peer.applyTextUpdate('windows-eol.js',Y.encodeStateAsUpdate(rewritten),snapshot.identity);rewritten.destroy();
    await new Promise(resolve=>setTimeout(resolve,200));
    await until(()=>!host.mirrorQueued);
    const visible=eolDoc.getText(),sameOffset=visible.indexOf('REPLACED_SOURCE');
    hiddenEditor.selection=new vscode.Selection(eolDoc.positionAt(sameOffset),eolDoc.positionAt(sameOffset+'REPLACED_SOURCE'.length));
    await vscode.commands.executeCommand('type',{text:'FINAL_REPLACEMENT'});api.flushEditorEdits(host);
    await until(()=>eolDoc.getText()===peer.file('windows-eol.js')?.replace(/\r\n|\r|\n/g,'\r\n')&&peer.file('windows-eol.js').includes('FINAL_REPLACEMENT'));
    assert.equal(peer.file('windows-eol.js').includes('REPLACED_SOURCE'),false);
    checks.push('Identical visible CRDT rewrites refresh native character ancestry before later edits');

    const eolChange=new vscode.WorkspaceEdit();eolChange.set(eolDoc.uri,[vscode.TextEdit.setEndOfLine(vscode.EndOfLine.LF)]);
    assert.ok(await vscode.workspace.applyEdit(eolChange));
    const switchedEditor=await vscode.window.showTextDocument(eolDoc);
    const switchedEnd=eolDoc.positionAt(eolDoc.getText().length);switchedEditor.selection=new vscode.Selection(switchedEnd,switchedEnd);
    await vscode.commands.executeCommand('type',{text:'// after native EOL switch\n'});api.flushEditorEdits(host);
    await until(()=>eolDoc.getText()===peer.file('windows-eol.js')?.replace(/\r\n|\r|\n/g,'\n'));
    assert.ok(eolDoc.getText().includes('after native EOL switch'));
    checks.push('Changing native line endings keeps later edits synchronized');

    host.edit('undo.txt','Undo fixture\n');
    await until(()=>fs.existsSync(path.join(root,'undo.txt')));
    const undoDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'undo.txt')));
    const undoEditor=await vscode.window.showTextDocument(undoDoc);
    const undoBefore=undoDoc.getText(),undoEnd=undoDoc.positionAt(undoBefore.length);
    undoEditor.selection=new vscode.Selection(undoEnd,undoEnd);
    await vscode.commands.executeCommand('type',{text:'LOCAL_UNDO_TOKEN'});api.flushEditorEdits(host);
    await until(()=>peer.file('undo.txt')===undoDoc.getText());
    await vscode.commands.executeCommand('undo');api.flushEditorEdits(host);
    await until(()=>peer.file('undo.txt')===undoDoc.getText());assert.equal(undoDoc.getText(),undoBefore);
    await vscode.commands.executeCommand('redo');api.flushEditorEdits(host);
    await until(()=>peer.file('undo.txt')===undoDoc.getText());assert.equal(undoDoc.getText(),undoBefore+'LOCAL_UNDO_TOKEN');
    checks.push('Native local undo and redo replicate the resulting document correctly');


    const originalSend=peer.send.bind(peer),heldChunks=[];
    let holdDownload=true;
    peer.send=(destination,message)=>{
      if(holdDownload&&message.type==='chunk'){heldChunks.push({destination,message});return;}
      return originalSend(destination,message);
    };
    peer.edit('background.bin',{binary:crypto.randomBytes(512*1024).toString('base64')});
    await until(()=>heldChunks.length>0&&!host.ready);
    const downloadingEditor=await vscode.window.showTextDocument(javaDoc),downloadEnd=javaDoc.positionAt(javaDoc.getText().length);
    downloadingEditor.selection=new vscode.Selection(downloadEnd,downloadEnd);
    await vscode.commands.executeCommand('type',{text:'EDIT_WHILE_DOWNLOADING'});api.flushEditorEdits(host);
    assert.ok(host.file('Main.java').includes('EDIT_WHILE_DOWNLOADING'),'known files must remain editable during background transfers');
    holdDownload=false;for(const item of heldChunks)originalSend(item.destination,item.message);peer.send=originalSend;
    await until(()=>host.ready&&javaDoc.getText()===peer.file('Main.java')&&host.hasFile('background.bin'));
    assert.ok(javaDoc.getText().includes('EDIT_WHILE_DOWNLOADING'));
    checks.push('Typing in a verified file stays synchronized during a delayed new binary download');
    const binaryOutside=path.join(parent,'synthetic-binary-outside-'+Date.now()+'.txt');
    const binaryTemp=path.join(root,'protected.bin.relay-tmp');
    fs.writeFileSync(binaryOutside,'synthetic outside sentinel');
    fs.symlinkSync(binaryOutside,binaryTemp);
    const protectedBytes=Buffer.from([0,255,128,42]);
    try {
      peer.edit('protected.bin',{binary:protectedBytes.toString('base64')});
      await until(()=>fs.existsSync(path.join(root,'protected.bin')));
      assert.equal(fs.readFileSync(binaryOutside,'utf8'),'synthetic outside sentinel');
      assert.deepEqual(fs.readFileSync(path.join(root,'protected.bin')),protectedBytes);
    } finally {fs.unlinkSync(binaryTemp);fs.unlinkSync(binaryOutside);}
    checks.push('Native incoming binary transfer cannot write through an existing temporary symlink');

    const textOutside=path.join(parent,'synthetic-hardlink-outside-'+Date.now()+'.txt');
    fs.writeFileSync(textOutside,'synthetic outside sentinel');
    fs.linkSync(textOutside,path.join(root,'protected.txt'));
    try {
      peer.edit('protected.txt','verified native incoming text\n');
      await until(()=>fs.readFileSync(path.join(root,'protected.txt'),'utf8')==='verified native incoming text\n');
      assert.equal(fs.readFileSync(textOutside,'utf8'),'synthetic outside sentinel');
    } finally {fs.unlinkSync(textOutside);}
    checks.push('Native incoming text replaces a hard link without changing its outside alias');


    peer.edit('blocked.js','// before stable failure\n');
    await until(()=>fs.existsSync(path.join(root,'blocked.js')));
    const blocked=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'blocked.js')));
    interceptMirror=async()=>false;
    peer.edit('blocked.js','// incoming blocked change\n');
    await until(()=>mirrorProblems.some(message=>message.includes('Could not apply teammate changes to blocked.js')));
    assert.equal(blocked.getText(),'// before stable failure\n');
    assert.equal(host.file('blocked.js'),'// incoming blocked change\n','delayed disk notifications cannot revert a newer shared edit');
    interceptMirror=null;
    peer.edit('blocked.js','// incoming after retry\n');
    try{await until(()=>blocked.getText()==='// incoming after retry\n');}
    catch(error){throw new Error(JSON.stringify({error:error.message,native:blocked.getText(),host:host.file('blocked.js'),peer:peer.file('blocked.js'),
      queued:host.mirrorQueued,again:host.mirrorAgain,dirty:[...(host.mirrorDirty||[])],all:host.mirrorAll,
      bindings:[...api.editorBindings.values()].filter(s=>s.name==='blocked.js').map(s=>({text:s.binding.text,dirty:s.binding.dirty,pending:!!s.binding.pending})),
      problems:mirrorProblems}));}
    checks.push('Persistent editor failures remain visible and preserve the local copy; later updates can recover');




    const newFile=vscode.Uri.file(path.join(root,'new folder','a b.js'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(newFile.fsPath)));
    await vscode.workspace.fs.writeFile(newFile,Buffer.from('// Real project file\n'));
    await until(()=>peer.files().get('new folder/a b.js')==='// Real project file\n');
    checks.push('Real file creation, including folders and spaces, reaches teammates');
    const unsavedUri=vscode.Uri.file(path.join(root,'unsaved.js'));
    await vscode.workspace.fs.writeFile(unsavedUri,Buffer.from('// disk version\n'));
    const unsavedDoc=await vscode.workspace.openTextDocument(unsavedUri);
    const unsavedEdit=new vscode.WorkspaceEdit();
    unsavedEdit.insert(unsavedUri,new vscode.Position(0,0),'// unsaved editor change\n');
    assert.ok(await vscode.workspace.applyEdit(unsavedEdit));
    assert.equal((await api.localSource(root)).files['unsaved.js'],unsavedDoc.getText());
    checks.push('Sharing includes unsaved editor text rather than stale disk content');
    const oversized=new vscode.WorkspaceEdit();oversized.insert(unsavedUri,new vscode.Position(0,0),'x'.repeat(512*1024));
    assert.ok(await vscode.workspace.applyEdit(oversized));
    await assert.rejects(()=>api.localSource(root),/Unsaved file exceeds/);
    const resetOversized=new vscode.WorkspaceEdit();resetOversized.replace(unsavedUri,new vscode.Range(0,0,unsavedDoc.lineCount,0),'// within limit\n');
    assert.ok(await vscode.workspace.applyEdit(resetOversized));
    checks.push('Unsaved editor buffers cannot bypass file sharing limits');
    const binaryUri=vscode.Uri.file(path.join(root,'raw-asset.bin'));
    const binaryBytes=Buffer.from([255,129,254]);
    await vscode.workspace.fs.writeFile(binaryUri,binaryBytes);
    await vscode.workspace.openTextDocument(binaryUri);
    const binarySource=await api.localSource(root,{large:true,binary:true});
    assert.deepEqual(binarySource.files['raw-asset.bin'],{binary:binaryBytes.toString('base64')});
    assert.equal((await api.localSource(root,{large:true,binary:false})).files['raw-asset.bin'],undefined);
    checks.push('Opening a binary file cannot replace shared bytes with lossy editor text');

    const outside=path.join(parent,'outside-'+Date.now()+'.js');
    const link=path.join(root,'linked.js');
    fs.writeFileSync(outside,'// private outside source\n');
    fs.symlinkSync(outside,link);
    const linkDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(link));
    const linkEditor=await vscode.window.showTextDocument(linkDoc);
    linkEditor.selection=new vscode.Selection(0,0,0,0);
    await vscode.commands.executeCommand('type',{text:'// synthetic private keystrokes\\n'});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(host.hasFile('linked.js'),false,'typing through a symlink must never publish outside source');
    assert.equal((await api.localSource(root)).files['linked.js'],undefined);
    fs.unlinkSync(link);fs.unlinkSync(outside);
    checks.push('An open symlink cannot leak files outside the shared folder');


    const privateDir=path.join(root,'private');fs.mkdirSync(privateDir,{recursive:true});
    const privatePath=path.join(privateDir,'notes.txt');fs.writeFileSync(privatePath,'synthetic local private notes\n');
    peer.edit('private/notes.txt','incoming peer contents\n');
    await until(()=>host.file('private/notes.txt')==='incoming peer contents\n');
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(fs.readFileSync(privatePath,'utf8'),'synthetic local private notes\n','remote files cannot overwrite excluded local paths');
    checks.push('Sharing exclusions also protect local files from incoming materialization');

    const typescript=vscode.extensions.getExtension('vscode.typescript-language-features');assert.ok(typescript);await typescript.activate();
    host.edit('check.ts','export function calculate(): number {\n  return 1;\n}\n');
    await until(()=>fs.existsSync(path.join(root,'check.ts')));
    const codeDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'check.ts')));
    await vscode.window.showTextDocument(codeDoc);
    await until(()=>vscode.languages.getDiagnostics(codeDoc.uri).length===0);
    await new Promise(r=>setTimeout(r,1500));
    host.edit('external-tool.java','class ExternalTool {\n  void initial() {}\n}\n');
    await until(()=>fs.existsSync(path.join(root,'external-tool.java'))&&peer.file('external-tool.java')?.includes('initial'));
    const externalDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'external-tool.java')));
    await vscode.window.showTextDocument(externalDoc);
    const dirtyExternal=new vscode.WorkspaceEdit();dirtyExternal.insert(externalDoc.uri,new vscode.Position(0,0),'// native unsaved marker\n');
    assert.ok(await vscode.workspace.applyEdit(dirtyExternal));
    await until(()=>peer.file('external-tool.java')?.includes('native unsaved marker'));
    await until(()=>fs.readFileSync(externalDoc.uri.fsPath,'utf8')===externalDoc.getText());
    assert.equal(externalDoc.isDirty,true);
    const generated=fs.readFileSync(externalDoc.uri.fsPath,'utf8').replace('initial','generated');
    fs.writeFileSync(externalDoc.uri.fsPath,generated);
    await until(()=>externalDoc.getText().includes('void generated')&&peer.file('external-tool.java')?.includes('void generated'));
    assert.ok(externalDoc.getText().includes('native unsaved marker'));
    checks.push('External tools update a dirty native Java buffer and its teammate without restarting');
    const savedExternal=fs.readFileSync(externalDoc.uri.fsPath,'utf8');
    const concurrentExternal=new vscode.WorkspaceEdit();concurrentExternal.insert(externalDoc.uri,new vscode.Position(0,0),'// concurrent typing marker\n');
    assert.ok(await vscode.workspace.applyEdit(concurrentExternal));
    fs.writeFileSync(externalDoc.uri.fsPath,savedExternal.replace('generated','generatedAgain'));
    await until(()=>externalDoc.getText().includes('generatedAgain')&&externalDoc.getText().includes('concurrent typing marker')&&
      peer.file('external-tool.java')?.includes('generatedAgain')&&peer.file('external-tool.java')?.includes('concurrent typing marker'));
    checks.push('Concurrent native typing and an external tool rewrite preserve both edits on both peers');
    host.edit('check.ts','export function calculate(): number {\n  return "local invalid";\n}\n');
    await until(()=>codeDoc.getText().includes('local invalid'));
    await until(()=>vscode.languages.getDiagnostics(codeDoc.uri).some(d=>d.severity===vscode.DiagnosticSeverity.Error));
    await new Promise(r=>setTimeout(r,1600));
    assert.equal(api.codeIssues.get('check.ts')?.length||0,0);
    checks.push('Ordinary local type errors remain in Problems and never enter Code Checks');
    host.edit('check.ts','export function calculate(): number {\n  return 2;\n}\n');
    await new Promise(r=>setTimeout(r,1600));
    peer.edit('check.ts','export function calculate(): number {\n  return "wrong type";\n}\n');
    await until(()=>codeDoc.getText().includes('wrong type'));
    await until(()=>vscode.languages.getDiagnostics(codeDoc.uri).some(d=>d.severity===vscode.DiagnosticSeverity.Error));
    await until(()=>api.codeIssues.get('check.ts')?.some(issue=>issue.warning));
    assert.ok(api.codeIssues.get('check.ts').some(issue=>issue.message.includes('calculate')));
    assert.ok(api.codeIssues.get('check.ts').every(issue=>issue.message.includes('changed calculate')));
    checks.push('Code Checks shows teammate function activity and overlaps while TypeScript errors stay in Problems');
    host.checkpointProject('Native checkpoint',{branch:'main'});
    const entry=host.timeline.find(e=>e.file==='check.ts'&&e.beforeRef&&e.afterRef);
    assert.ok(entry);assert.equal(typeof host.version(entry,'before'),'string');
    const proposal=host.proposal(entry);assert.ok(proposal.expected);
    checks.push('Full checkpoint versions and guarded restore proposals work in the installed extension');
    host.edit('check.ts',null);
    await until(()=>!fs.existsSync(path.join(root,'check.ts'))&&!api.codeIssues.has('check.ts'));
    await new Promise(r=>setTimeout(r,1400));
    assert.equal(api.codeIssues.has('check.ts'),false);
    checks.push('Deleted files clear stale collaboration diagnostics');
    const terminal=await vscode.commands.executeCommand('relay.terminal');
    assert.ok(terminal);const pid=await terminal.processId;assert.ok(pid>0);terminal.dispose();
    checks.push('Integrated terminal starts an actual local shell process');
    await vscode.commands.executeCommand('relay.extensions');
    assert.ok(vscode.extensions.getExtension('esbenp.prettier-vscode'));
    checks.push('A third-party Open VSX extension is installed and visible in the extension host');

    await vscode.window.showTextDocument(undoDoc);
    const finalEditor=vscode.window.activeTextEditor,finalEnd=undoDoc.positionAt(undoDoc.getText().length);
    finalEditor.selection=new vscode.Selection(finalEnd,finalEnd);
    await vscode.commands.executeCommand('type',{text:'FINAL_DISCONNECT_TOKEN'});
    await vscode.commands.executeCommand('relay.disconnect');
    assert.equal(host.file('undo.txt'),undoDoc.getText(),'disconnect must flush the final keystrokes');
    checks.push('Disconnect commits the last native keystrokes before closing the peer session');
    fs.writeFileSync(result,JSON.stringify({success:true,checks},null,2));
  }catch(error){if(result)fs.writeFileSync(result,JSON.stringify({success:false,checks,error:error.stack,shared:host?Object.fromEntries([...host.files()].map(([k,v])=>[k,typeof v==='string'?v.slice(0,4000):v])):{},native:vscode.workspace.textDocuments.filter(d=>d.uri.scheme==='file').map(d=>({file:path.basename(d.uri.fsPath),text:d.getText().slice(0,4000),version:d.version})),peer:peer?Object.fromEntries([...peer.files()].map(([k,v])=>[k,typeof v==='string'?v.slice(0,4000):v])):{}},null,2));throw error;}
  finally{await vscode.commands.executeCommand('relay.disconnect');await peer?.close();if(server)await server.close();}
};
async function until(condition){for(let n=0;n<400;n++){if(condition())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Native editor test timed out.');}
