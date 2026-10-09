import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { startServer } from '../legacy/server/index.js';

test('desktop invite imports existing code and history, reuses its public invite, and remembers it on restart', async () => {
  const dirs = [0, 1].map(() => mkdtempSync(path.join(os.tmpdir(), 'relay-share-')));
  const records = new Map();
  const storage = { loadAll: async () => [...records.values()], save: async r => records.set(r.id, structuredClone(r)) };
  let cloud, local, ws;
  const messages = [];
  try {
    cloud = await startServer({ port: 0, dataDir: dirs[0], hosted: true, storage });
    const publicOrigin = `http://127.0.0.1:${cloud.port}`;
    local = await startServer({ port: 0, dataDir: dirs[1], publicOrigin });
    const original = local.credentials;
    let origin = `http://127.0.0.1:${local.port}`;
    ws = new WebSocket(`${origin.replace('http', 'ws')}/sync`);
    const doc = new Y.Doc();
    ws.on('message', raw => {
      const m = JSON.parse(raw); messages.push(m);
      if (m.type === 'init') Y.applyUpdate(doc, Buffer.from(m.state, 'base64'));
    });
    await new Promise(r => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'join', ...original, name: 'Desktop owner' }));
    await until(() => messages.some(m => m.type === 'init'));
    const vector = Y.encodeStateVector(doc);
    doc.getMap('files').get('src/main.js').insert(0, '// Preserve my desktop work\n');
    doc.getMap('files').set('custom.txt', new Y.Text('A real local file'));
    ws.send(JSON.stringify({ type: 'update', seq: 1, update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64') }));
    await until(() => messages.some(m => m.type === 'ack'));
    const share = (headers, token = original.token) => fetch(`${origin}/api/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ room: original.room, token }) });
    assert.equal((await share({ Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await share({ Origin: origin }, '0'.repeat(48))).status, 403);
    const [a, b] = await Promise.all([share({ Origin: origin }), share({ Origin: origin })]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const config = await a.json(); assert.deepEqual(await b.json(), config);
    assert.equal(config.origin, publicOrigin);
    assert.equal(records.size, 1);
    const saved = records.get(config.room), imported = new Y.Doc();
    Y.applyUpdate(imported, Buffer.from(saved.state, 'base64'));
    assert.equal(imported.getMap('files').get('custom.txt').toString(), 'A real local file');
    assert.match(imported.getMap('files').get('src/main.js').toString(), /Preserve my desktop work/);
    assert.ok(saved.history.some(e => e.actor === 'Desktop owner'));
    await until(() => messages.some(m => m.type === 'workspace-shared'));
    ws.terminate(); await local.close(); local = null;
    local = await startServer({ port: 0, dataDir: dirs[1], publicOrigin });
    origin = `http://127.0.0.1:${local.port}`;
    assert.deepEqual(await (await fetch(`${origin}/api/bootstrap`)).json(), config);
    imported.destroy(); doc.destroy();
  } finally {
    ws?.terminate();
    if (local) await local.close();
    if (cloud) await cloud.close();
    dirs.forEach(dir => rmSync(dir, { force: true, recursive: true }));
  }
});

test('sharing failure leaves the local workspace usable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-share-failure-'));
  const server = await startServer({ port: 0, dataDir: dir, publicOrigin: 'http://127.0.0.1:1' });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${origin}/api/share`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(server.credentials) });
    assert.equal(response.status, 503);
    assert.deepEqual(await (await fetch(`${origin}/api/bootstrap`)).json(), server.credentials);
  } finally { await server.close(); rmSync(dir, { force: true, recursive: true }); }
});
async function until(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Timed out');
}
