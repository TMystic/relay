import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const targets=process.argv.slice(2);
if(!targets.length)targets.push('linux','win32');
for(const target of targets)if(!['linux','win32'].includes(target))throw new Error('Use linux or win32.');
// WSL builds use the native Windows runtime for installer generation instead of requiring Wine.
let windowsNode=process.env.RELAY_WINDOWS_NODE;
if(process.platform==='linux' && process.env.WSL_DISTRO_NAME && targets.includes('win32') && !windowsNode) {
 const probe="$relayNode=Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'; if(Test-Path -LiteralPath $relayNode){$relayNode}else{$relayNode=(Get-Command node -ErrorAction SilentlyContinue).Source;if($relayNode){$relayNode}else{throw 'Set RELAY_WINDOWS_NODE to a Windows Node.js executable.'}}";
 windowsNode=execFileSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoProfile','-NonInteractive','-Command',probe],{encoding:'utf8'}).trim();
}

const run=(args,env={})=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:'inherit',windowsHide:true});
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Build failed with exit '+code)));
});
await run(['scripts/build-extension.mjs']);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
fs.mkdirSync(path.join(root,'.tools'),{recursive:true});
const wrapper=path.join(root,'.tools','beta-wrapper');
fs.mkdirSync(path.join(wrapper,'electron'),{recursive:true});
fs.copyFileSync(path.join(root,'electron/editor-main.cjs'),path.join(wrapper,'electron/editor-main.cjs'));
fs.writeFileSync(path.join(wrapper,'package.json'),JSON.stringify({
 name:'relay-beta-tester',version:manifest.version+'-beta.1',private:true,main:'electron/editor-main.cjs',
 description:manifest.description,author:manifest.author,homepage:manifest.homepage,license:manifest.license,
 productName:'Relay Beta Tester',relayChannel:'beta'
},null,2)+'\n');

const suffix='$'+'{version}-$'+'{arch}.$'+'{ext}';
for(const platform of targets){
 const engine='.engine-cache/beta-engine-'+platform;
 await run(['scripts/prepare-engine.mjs',platform,engine],{RELAY_BETA:'1'});
 const config={
  ...manifest.build,
  appId:'io.github.tmystic.relay.beta',
  productName:'Relay Beta Tester',
  directories:{...manifest.build.directories,app:'.tools/beta-wrapper',output:'release/beta-'+manifest.version},
  extraMetadata:{name:'relay-beta-tester',productName:'Relay Beta Tester',version:manifest.version+'-beta.1',relayChannel:'beta'},
  extraResources:[{from:engine,to:'engine',filter:['**/*']},{from:'desktop-assets',to:'desktop-assets',filter:['*.vsix']}],
  nsis:{...manifest.build.nsis,artifactName:'Relay-Beta-Tester-Setup-'+suffix},
  portable:{...manifest.build.portable,artifactName:'Relay-Beta-Tester-Portable-'+suffix},
  linux:{...manifest.build.linux,executableName:'relay-beta-tester',target:['AppImage','deb'],artifactName:'Relay-Beta-Tester-'+suffix}
 };
 const filename=path.join(root,'.tools/beta-builder-'+platform+'.json');
 fs.writeFileSync(filename,JSON.stringify(config,null,2));
 // Do not reuse an archive from a previous attempt with a different bundled extension.
 if(platform==='win32')fs.rmSync(path.join(root,config.directories.output,'relay-beta-tester-'+manifest.version+'-beta.1-x64.nsis.7z'),{force:true});

 const args=['node_modules/electron-builder/cli.js','--config',filename,platform==='win32'?'--win':'--linux','--x64','--publish','never'];
 if(platform==='win32' && process.platform==='linux' && windowsNode) {
  const winRoot=execFileSync('wslpath',['-w',root],{encoding:'utf8'}).trim();
  const winConfig=execFileSync('wslpath',['-w',filename],{encoding:'utf8'}).trim();
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const command="Set-Location -LiteralPath "+quote(winRoot)+"; & "+quote(windowsNode)+
   " "+[winRoot+'\\\\node_modules\\\\electron-builder\\\\cli.js','--config',winConfig,'--win','--x64','--publish','never'].map(quote).join(' ')+"; exit $LASTEXITCODE";
  await new Promise((resolve,reject)=>{
   const child=spawn('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile','-NonInteractive','-Command',command],{stdio:'inherit',windowsHide:true});
   child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Native Windows packaging failed with '+code)));
  });
 } else await run(args,{CSC_IDENTITY_AUTO_DISCOVERY:'false'});
}
