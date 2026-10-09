'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require('node:path');
const readline=require('node:readline/promises');
const {PeerSession,parseInvite,openSnapshot}=require('../extension/peer-session.cjs');
async function main(){
 const root=path.resolve(process.argv[2] || '.relay-peer');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const configFile=path.join(root,'.env.relay-invite'),cache=path.join(root,'replica.enc');
 let config;
 if(fs.existsSync(configFile))config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 else {
  const input=readline.createInterface({input:process.stdin,output:process.stdout});
  try {config=parseInvite(await input.question('Paste your private peer invite (it grants editing access): '));}
  finally{input.close();}
  fs.writeFileSync(configFile,JSON.stringify({...config,name:'Local seed'}),{mode:0o600,flag:'wx'});
 }
 if(config.recovery && !config.recoveryDevice) {
  config.recoveryDevice=crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
 }
 let cached;
 try {cached=fs.existsSync(cache)?fs.readFileSync(cache):undefined;if(cached)openSnapshot(config.token,cached);}
 catch(error){if(!config.recovery)throw error;console.error('Local seed cache could not be read; waiting for a peer or encrypted recovery.');}
 const blocks=path.join(root,'blocks'),chunks=path.join(root,'chunks');
 const location=(directory,ref,offset)=>{
  if(!/^[a-f0-9]{64}$/.test(ref)||offset!==undefined&&(!Number.isInteger(offset)||offset<0))throw new Error('Invalid replica block.');
  return path.join(directory,ref+(offset===undefined?'':'.'+offset));
 };
 const store=(filename,bytes)=>{fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});const fd=fs.openSync(filename+'.tmp','w',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(filename+'.tmp',filename);};
 const load=filename=>fs.existsSync(filename)?fs.readFileSync(filename):null;
 const session=new PeerSession({...config,name:'Local seed'},{
  cached,storeBlock:(ref,bytes)=>store(location(blocks,ref),bytes),loadBlock:ref=>load(location(blocks,ref)),
  storeChunk:(ref,offset,bytes)=>store(location(chunks,ref,offset),bytes),loadChunk:(ref,offset)=>load(location(chunks,ref,offset)),
  checkpoint:bytes=>{
   const fd=fs.openSync(cache+'.tmp','w',0o600);
   try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(cache+'.tmp',cache);
  }
 });
 session.on('status',message=>console.log(message));
 session.on('problem',message=>console.error(message));
 session.connect();
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await session.close();process.exitCode=0;};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
 console.log('This local device keeps an encrypted replica available while the process is running.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
