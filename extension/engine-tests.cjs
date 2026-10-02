const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const vscode=require('vscode');
exports.run=async()=>{
  const base=process.env.RELAY_ENGINE_TEST_ROOT;
  if(!base)throw new Error('Set RELAY_ENGINE_TEST_ROOT.');
  const result=process.env.RELAY_ENGINE_TEST_RESULT;
  let server, peer;
  const checks=[];
  try{
    const extension=vscode.extensions.getExtension('TMystic.relay-collaboration');
    assert.ok(extension);const api=await extension.activate();
    const commands=await vscode.commands.getCommands(true);
    for(const command of ['relay.openFolder','relay.createFolder','relay.terminal','relay.extensions','relay.invite','relay.join'])assert.ok(commands.includes(command));
    checks.push('Native folder, terminal, extensions and collaboration commands registered');
    const parent=path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath);
    const created=await vscode.commands.executeCommand('relay.createFolder',parent,'Created project '+Date.now());
    assert.ok(fs.statSync(created).isDirectory());checks.push('Create Folder creates a real filesystem folder');
    const {startServer}=await import(pathToFileURL(path.join(base,'server/index.js')).href);
    server=await startServer({port:0,dataDir:path.join(parent,'server-fixture')});
    const config={...server.credentials,origin:`http://127.0.0.1:${server.port}`,name:'Native editor tester'};
    const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
    const host=await api.start(root,config);
    await until(()=>host.ready && fs.existsSync(path.join(root,'src/main.js')));
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,'src/main.js')));
    await vscode.window.showTextDocument(document);
    peer=new api.Session({...config,name:'Remote peer tester'});peer.connect();
    await until(()=>peer.ready);
    const edit=new vscode.WorkspaceEdit();edit.insert(document.uri,new vscode.Position(0,0),'// Native editor changed this\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(()=>peer.files().get('src/main.js').includes('Native editor changed this'));
    checks.push('Real TextDocument edits reach a second collaborative client');
    peer.edit('src/main.js','// Remote peer changed this\n'+peer.files().get('src/main.js'));
    await until(()=>document.getText().includes('Remote peer changed this'));
    assert.ok(document.getText().includes('Native editor changed this'));
    checks.push('Remote edits update the native editor without losing local edits');
    const newFile=vscode.Uri.file(path.join(root,'new folder','a b.js'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(newFile.fsPath)));
    await vscode.workspace.fs.writeFile(newFile,Buffer.from('// Real project file\n'));
    await until(()=>peer.files().get('new folder/a b.js')==='// Real project file\n');
    checks.push('Real file creation, including folders and spaces, reaches teammates');
    const terminal=await vscode.commands.executeCommand('relay.terminal');
    assert.ok(terminal);const pid=await terminal.processId;assert.ok(pid>0);terminal.dispose();
    checks.push('Integrated terminal starts an actual local shell process');
    await vscode.commands.executeCommand('relay.extensions');
    assert.ok(vscode.extensions.getExtension('esbenp.prettier-vscode'));
    checks.push('A third-party Open VSX extension is installed and visible in the extension host');
    await vscode.commands.executeCommand('relay.disconnect');
    fs.writeFileSync(result,JSON.stringify({success:true,checks},null,2));
  }catch(error){if(result)fs.writeFileSync(result,JSON.stringify({success:false,checks,error:error.stack},null,2));throw error;}
  finally{peer?.close();if(server)await server.close();}
};
async function until(condition){for(let n=0;n<400;n++){if(condition())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Native editor test timed out.');}
