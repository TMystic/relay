import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2] || process.platform;
const release = JSON.parse(fs.readFileSync(path.join(root, 'scripts/engine-release.json')));
const asset = release[platform];
if (!asset) throw new Error('Relay engine supports Windows x64 and Linux x64.');
const target = path.join(root, 'engine-runtime');
const stamp = path.join(target, '.relay-engine-version');
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${release.version}:${platform}`) process.exit(0);
const cache = path.join(root, '.engine-cache'); fs.mkdirSync(cache, { recursive: true });
const archive = path.join(cache, asset.file);
const hash = async file => { const h = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) h.update(chunk); return h.digest('hex'); };
if (!fs.existsSync(archive) || await hash(archive) !== asset.sha256) {
  console.log(`Downloading official VSCodium ${release.version} (${platform})…`);
  const response = await fetch(`https://github.com/VSCodium/vscodium/releases/download/${release.version}/${asset.file}`);
  if (!response.ok) throw new Error(`Engine download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive + '.part'));
  if (await hash(archive + '.part') !== asset.sha256) throw new Error('Engine checksum mismatch.');
  fs.renameSync(archive + '.part', archive);
}
if (!target.startsWith(root + path.sep)) throw new Error('Invalid engine destination.');
fs.mkdirSync(target, { recursive: true });
execFileSync('tar', platform === 'win32' ? ['-xf', archive, '-C', target] : ['-xzf', archive, '-C', target], { stdio: 'inherit' });
const productPath = path.join(target, 'resources/app/product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
Object.assign(product, { nameShort: 'Relay', nameLong: 'Relay Collaborative Editor', applicationName: 'relay-code', dataFolderName: '.relay-code', urlProtocol: 'relay-code', win32AppUserModelId: 'io.github.tmystic.relay.editor' });
// Retain upstream licenses and the Open VSX gallery. Updates ship through Relay installers.
delete product.updateUrl;
fs.writeFileSync(productPath, JSON.stringify(product, null, 2));
fs.writeFileSync(stamp, `${release.version}:${platform}`);
console.log('Verified and prepared the Relay Code-OSS engine.');
