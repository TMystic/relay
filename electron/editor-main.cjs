const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (process.argv.includes('--classic')) {
  require('./main.cjs');
} else {
  if (process.env.RELAY_USER_DATA) app.setPath('userData',process.env.RELAY_USER_DATA);
  if(process.platform==='win32')app.setAppUserModelId('io.github.tmystic.relay');
  app.whenReady().then(async()=>{
    const base=app.isPackaged ? process.resourcesPath : path.resolve(__dirname,'..');
    const engine=path.join(base,app.isPackaged ? 'engine' : 'engine-runtime');
    const executable=path.join(engine,process.platform==='win32' ? 'VSCodium.exe' : 'codium');
    const profile=path.join(app.getPath('userData'),'editor');
    const extensions=path.join(app.getPath('userData'),'extensions');
    const vsix=path.join(base,'desktop-assets/relay-collaboration.vsix');
    if (!fs.existsSync(executable) || !fs.existsSync(vsix)) throw new Error('The editor engine is missing. Reinstall the complete Relay package.');
    fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(extensions,{recursive:true});
    const settingsDir=path.join(profile,'User');fs.mkdirSync(settingsDir,{recursive:true});
    const settings=path.join(settingsDir,'settings.json');
    if(!fs.existsSync(settings))fs.writeFileSync(settings,JSON.stringify({
      'workbench.colorTheme':'Default Dark Modern',
      'window.title':'${dirty}${activeEditorShort}${separator}${rootName}${separator}Relay',
      'workbench.startupEditor':'none','telemetry.telemetryLevel':'off',
    },null,2));
    const manifest=JSON.parse(fs.readFileSync(path.join(base,app.isPackaged ? 'app.asar/package.json' : 'package.json'),'utf8'));
    const stamp=path.join(profile,'.relay-extension-version');
    if(!fs.existsSync(stamp) || fs.readFileSync(stamp,'utf8')!==manifest.version) {
      await new Promise((resolve,reject)=>{
        const child=spawn(executable,[path.join(engine,'resources/app/out/cli.js'),'--user-data-dir',profile,'--extensions-dir',extensions,'--install-extension',vsix,'--force'],{
          windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe'],
        });
        let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
        child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Relay collaboration installation failed: '+output.slice(-2000))));
      });
      fs.writeFileSync(stamp,manifest.version);
    }
    const env={...process.env,RELAY_LEGACY_DATA_DIR:path.join(app.getPath('userData'),'workspaces')};
    delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(executable,['--user-data-dir',profile,'--extensions-dir',extensions],{windowsHide:true,env,stdio:'ignore'});
    child.on('error',error=>{dialog.showErrorBox('Relay could not start',error.message);app.quit();});
    child.on('exit',()=>app.quit());
  }).catch(error=>{dialog.showErrorBox('Relay could not start',error.message);app.quit();});
}
