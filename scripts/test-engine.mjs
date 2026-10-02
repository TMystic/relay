import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const testRoot=path.join(root,'.engine-test');fs.mkdirSync(testRoot,{recursive:true});
const profile=path.join(testRoot,'profile'),extensions=path.join(testRoot,'extensions'),project=path.join(testRoot,'project-'+Date.now());
fs.mkdirSync(project,{recursive:true});fs.mkdirSync(path.join(profile,'User'),{recursive:true});
// An isolated fixture profile only; production Workspace Trust remains enabled.
fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify({'security.workspace.trust.enabled':false,'workbench.startupEditor':'none','telemetry.telemetryLevel':'off'}));
const executable=path.join(root,'engine-runtime',process.platform==='win32'?'VSCodium.exe':'codium');
const cli=path.join(root,'engine-runtime/resources/app/out/cli.js');
const run=(args,env,limit=180000)=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,env:{...process.env,...env},stdio:'inherit'});
  const timer=setTimeout(()=>{child.kill();reject(new Error('Native engine test timed out.'));},limit);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Editor exited with ${code}.`));});
});
await run([cli,'--user-data-dir',profile,'--extensions-dir',extensions,'--install-extension','esbenp.prettier-vscode','--force'],{ELECTRON_RUN_AS_NODE:'1'});
const result=path.join(testRoot,'result.json');if(fs.existsSync(result))fs.unlinkSync(result);
const env={...process.env,RELAY_ENGINE_TEST_ROOT:root,RELAY_ENGINE_TEST_RESULT:result};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
await run(['--disable-gpu','--disable-workspace-trust','--user-data-dir',profile,'--extensions-dir',extensions,'--extensionDevelopmentPath='+path.join(root,'extension'),'--extensionTestsPath='+path.join(root,'extension/engine-tests.cjs'),project],env);
if(!fs.existsSync(result))throw new Error('The native extension host did not report a result.');
const report=JSON.parse(fs.readFileSync(result,'utf8'));console.log(JSON.stringify(report,null,2));
if(!report.success)throw new Error('Native editor verification failed.');
