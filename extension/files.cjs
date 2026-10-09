const fs = require('node:fs');
const path = require('node:path');
const ignored = new Set(['.git', '.svn', '.hg', '.vscode', '.idea', '.history', 'node_modules', '.relay', '.engine-cache', 'engine-runtime', 'dist', 'build', 'release', 'coverage', '.next', 'vendor', '__pycache__', '.backups', '.tools', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.codex', '.agents', '.relay-peer']);
function sharedPath(name) {
  return typeof name === 'string' && name.length <= 240 && !/[\x00-\x1f<>:"\\|?*]/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !ignored.has(part.toLowerCase()) && !/^\.relay-write-[a-f0-9-]{36}\.tmp$/i.test(part) && !/^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|credentials(?:\.|$)|id_(?:rsa|ed25519|ecdsa)(?:\.|$))/i.test(part) && !/\.(?:pem|key|p12|pfx|keystore)$/i.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function safeTarget(root, name) {
  if (!sharedPath(name)) throw new Error('This file is outside the shared source paths.');
  const base = fs.realpathSync(root), target = path.resolve(base, ...name.split('/'));
  if (!target.startsWith(base + path.sep)) throw new Error('Invalid file path.');
  let current = base;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Shared files cannot follow symbolic links.');
    } catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  return target;
}
function writeSharedFile(root, name, bytes) {
  const target = safeTarget(root, name);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  safeTarget(root, name);
  const temporary = path.join(path.dirname(target), '.relay-write-'+require('node:crypto').randomUUID()+'.tmp');
  let fd, created=false, mode=0o600;
  try {
    try { mode=fs.lstatSync(target).mode & 0o777; } catch(error) { if(error.code!=='ENOENT')throw error; }
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),mode);
    created=true;
    fs.fchmodSync(fd,mode);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    if(safeTarget(root,name)!==target)throw new Error('The shared destination changed during writing.');
    fs.renameSync(temporary,target);
  } finally {
    if(fd!==undefined)fs.closeSync(fd);
    if(created)try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
function selected(name, patterns = []) {
  return !patterns.some(pattern => {
    const escaped = pattern.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '.*');
    return new RegExp('^' + escaped + '(?:/.*)?$').test(name);
  });
}
async function collect(root, { allowEmpty = false, large = false, exclude = [], binary = false } = {}) {
  const files = Object.create(null), skipped = [];
  let total = 0;
  async function walk(directory, prefix = '') {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (!sharedPath(name) || !selected(name,exclude) || entry.isSymbolicLink()) { skipped.push(name); continue; }
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), name + '/'); continue; }
      if (!entry.isFile()) continue;
      const filename = path.join(directory, entry.name), stat = await fs.promises.stat(filename);
      if (stat.size > (large ? 2 * 1024 * 1024 : 512 * 1024)) { skipped.push(name); continue; }
      const bytes = await fs.promises.readFile(filename);
      let text;
      try { if(bytes.includes(0))throw new Error('Binary'); text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch {
        if(!large || !binary){skipped.push(name+' (binary)');continue;}
        text = {binary:bytes.toString('base64')};
      }
      total += bytes.length;
      if (total > (large ? 16 : 1) * 1024 * 1024 || Object.keys(files).length >= (large ? 10000 : 1000)) throw new Error(large ? 'This beta shares up to 16 MB across 10,000 files (2 MB per file). Adjust sharing exclusions.' : 'This preview shares up to 1 MB of source across 1,000 files. Exclude generated files or use a smaller folder.');
      files[name] = text;
    }
  }
  await walk(root);
  if (!allowEmpty && !Object.keys(files).length) files['README.md'] = '# Shared project\n';
  return { files, skipped };
}
function delta(before, after) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, length: oldEnd - start, text: after.slice(start, newEnd) };
}
function changeStats(before, after, kind = 'text') {
  if(kind === 'binary') {
    const size = value => value?.binary ? Buffer.from(value.binary, 'base64').length : 0;
    return { status:'binary', beforeBytes:size(before), afterBytes:size(after) };
  }
  if((before != null && typeof before !== 'string') || (after != null && typeof after !== 'string'))return {status:'unavailable'};
  // A pathological rewrite must not stall synchronization or display invented zeros.
  const parts = require('diff').diffLines(before ?? '', after ?? '', {timeout:50,maxEditLength:4000});
  if(!parts)return {status:'complex'};
  return {status:'text',added:parts.reduce((n,p)=>n+(p.added?p.count:0),0),removed:parts.reduce((n,p)=>n+(p.removed?p.count:0),0)};
}
function changeDescription(entry, stats = entry.stats) {
  const action = entry.created ? ' · Created' : entry.deleted ? ' · Deleted' : '';
  if(stats?.status === 'binary')return 'Binary · '+stats.beforeBytes+' → '+stats.afterBytes+' bytes'+action;
  if(stats?.status === 'text')return '+'+stats.added+' −'+stats.removed+action;
  if(stats?.status === 'complex')return 'Large rewrite · review diff'+action;
  if(!entry.fileId && Number.isInteger(entry.added) && Number.isInteger(entry.removed))return '+'+entry.added+' −'+entry.removed+action;
  return 'Saved version unavailable'+action;
}
module.exports = { sharedPath, safeTarget, writeSharedFile, collect, delta, selected, changeStats, changeDescription };
