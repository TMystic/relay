const fs = require('node:fs');
const path = require('node:path');
const ignored = new Set(['.git', '.svn', '.hg', '.vscode', '.idea', '.history', 'node_modules', '.relay', '.engine-cache', 'engine-runtime', 'dist', 'build', 'release', 'coverage', '.next', 'vendor', '__pycache__']);
function sharedPath(name) {
  return typeof name === 'string' && name.length <= 240 && !/[\x00-\x1f<>:"\\|?*]/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !ignored.has(part) && !/^\.env(?:\.|$)/.test(part));
}
function safeTarget(root, name) {
  if (!sharedPath(name)) throw new Error('This file is outside the shared source paths.');
  const base = fs.realpathSync(root), target = path.resolve(base, ...name.split('/'));
  if (!target.startsWith(base + path.sep)) throw new Error('Invalid file path.');
  let current = base;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Shared files cannot follow symbolic links.');
  }
  return target;
}
async function collect(root) {
  const files = {}, skipped = [];
  let total = 0;
  async function walk(directory, prefix = '') {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (!sharedPath(name) || entry.isSymbolicLink()) { skipped.push(name); continue; }
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), name + '/'); continue; }
      if (!entry.isFile()) continue;
      const filename = path.join(directory, entry.name), stat = await fs.promises.stat(filename);
      if (stat.size > 512 * 1024) { skipped.push(name); continue; }
      const bytes = await fs.promises.readFile(filename);
      if (bytes.includes(0)) { skipped.push(name); continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { skipped.push(name); continue; }
      total += bytes.length;
      if (total > 1024 * 1024 || Object.keys(files).length >= 1000) throw new Error('This preview shares up to 1 MB of source across 1,000 files. Exclude generated files or use a smaller folder.');
      files[name] = text;
    }
  }
  await walk(root);
  if (!Object.keys(files).length) files['README.md'] = '# Shared project\n';
  return { files, skipped };
}
function delta(before, after) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, length: oldEnd - start, text: after.slice(start, newEnd) };
}
module.exports = { sharedPath, safeTarget, collect, delta };
