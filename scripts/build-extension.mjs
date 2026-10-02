import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const extension=path.join(root,'extension');
const resolver={name:'node-resolver',setup(builder){
  builder.onResolve({filter:/.*/},args=>{
    if(isBuiltin(args.path)||['vscode','bufferutil','utf-8-validate'].includes(args.path))return{path:args.path,external:true};
    const importer=args.importer || path.join(extension,'extension.cjs');
    const filename=createRequire(importer).resolve(args.path);
    return{path:filename,namespace:'node-source'};
  });
  builder.onLoad({filter:/.*/,namespace:'node-source'},args=>({contents:fs.readFileSync(args.path,'utf8'),loader:args.path.endsWith('.json')?'json':'js',resolveDir:path.dirname(args.path)}));
}};
await build({absWorkingDir:root,stdin:{contents:fs.readFileSync(path.join(extension,'extension.cjs'),'utf8'),sourcefile:path.join(extension,'extension.cjs'),resolveDir:extension,loader:'js'},outfile:'extension/dist/extension.cjs',bundle:true,platform:'node',target:'node22',format:'cjs',plugins:[resolver],legalComments:'eof',tsconfigRaw:{}});
const metadata=JSON.parse(fs.readFileSync(path.join(extension,'package.json'),'utf8'));
const licenses=['yjs','lib0','ws'].map(name=>`${name}\n${fs.readFileSync(path.join(root,'node_modules',name,'LICENSE'),'utf8')}\n`).join('\n');
fs.writeFileSync(path.join(extension,'THIRD-PARTY-LICENSES.txt'),licenses);
const entries=[
  ['[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="md" ContentType="text/plain"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="" ContentType="text/plain"/></Types>'],
  ['extension.vsixmanifest',`<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${metadata.name}" Version="${metadata.version}" Publisher="${metadata.publisher}"/><DisplayName>${metadata.displayName}</DisplayName><Description xml:space="preserve">${metadata.description}</Description><Tags>collaboration,relay</Tags><Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${metadata.engines.vscode}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets></PackageManifest>`],
];
for(const name of ['package.json','dist/extension.cjs','media/relay.svg','README.md','LICENSE','THIRD-PARTY-LICENSES.txt'])entries.push(['extension/'+name,fs.readFileSync(path.join(extension,name))]);
const crcTable=Array.from({length:256},(_,i)=>{for(let n=0;n<8;n++)i=(i&1)?(0xedb88320^(i>>>1)):(i>>>1);return i>>>0;});
const crc=data=>{let c=0xffffffff;for(const byte of data)c=crcTable[(c^byte)&255]^(c>>>8);return(c^0xffffffff)>>>0;};
const parts=[],central=[];let offset=0;
for(const [name,content]of entries){
 const filename=Buffer.from(name),data=Buffer.isBuffer(content)?content:Buffer.from(content),packed=zlib.deflateRawSync(data),checksum=crc(data);
 const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);header.writeUInt32LE(checksum,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
 parts.push(header,filename,packed);
 const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(8,10);cd.writeUInt32LE(checksum,16);cd.writeUInt32LE(packed.length,20);cd.writeUInt32LE(data.length,24);cd.writeUInt16LE(filename.length,28);cd.writeUInt32LE(offset,42);central.push(cd,filename);offset+=header.length+filename.length+packed.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
fs.mkdirSync(path.join(root,'desktop-assets'),{recursive:true});
fs.writeFileSync(path.join(root,'desktop-assets/relay-collaboration.vsix'),Buffer.concat([...parts,directory,end]));
console.log('Built bundled Relay collaboration VSIX.');

