import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { startServer } from '../legacy/server/index.js';
import { cloudStore } from '../legacy/server/cloud-store.js';

test('hosted rooms survive a fresh disk, with private bootstrap and durable acknowledgments', async () => {
  const records = new Map();
  let fail = false;
  const storage = process.env.RELAY_TEST_STORAGE_TOKEN ? cloudStore({ url: process.env.RELAY_TEST_STORAGE_URL, token: process.env.RELAY_TEST_STORAGE_TOKEN, delay: 10 }) : {
    loadAll: async () => [...records.values()],
    save: async room => { await new Promise(r => setTimeout(r, 80)); if (fail) throw new Error('Storage unavailable'); records.set(room.id, structuredClone(room)); },
  };
  const dirs = [0, 1].map(() => mkdtempSync(path.join(os.tmpdir(), 'relay-cloud-')));
  let server, ws;
  try {
    server = await startServer({ port: 0, dataDir: dirs[0], hosted: true, storage });
    let origin = `http://127.0.0.1:${server.port}`;
    assert.equal(server.credentials, null);
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 403);
    assert.equal((await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: 'https://other.example' } })).status, 403);
    const response = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, 200);
    const invite = await response.json();
    const connect = async () => {
      const doc = new Y.Doc(), messages = [];
      ws = new WebSocket(`${origin.replace('http', 'ws')}/sync`);
      ws.on('message', raw => {
        const message = JSON.parse(raw); messages.push(message);
        if (message.type === 'init') Y.applyUpdate(doc, Buffer.from(message.state, 'base64'));
      });
      await new Promise(r => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'join', ...invite, name: 'Cloud tester' }));
      await until(() => messages.some(m => m.type === 'init'));
      return { doc, messages };
    };
    let peer = await connect();
    const edit = seq => {
      const before = Y.encodeStateVector(peer.doc);
      peer.doc.getMap('files').get('src/main.js').insert(0, `// Durable test ${seq}\n`);
      ws.send(JSON.stringify({ type: 'update', seq, update: Buffer.from(Y.encodeStateAsUpdate(peer.doc, before)).toString('base64') }));
    };
    edit(1);
    await until(() => peer.messages.some(m => m.type === 'ack' && m.seq === 1));
    ws.close();
    await server.close(); server = null;
    server = await startServer({ port: 0, dataDir: dirs[1], hosted: true, storage });
    origin = `http://127.0.0.1:${server.port}`;
    peer = await connect();
    assert.match(peer.doc.getMap('files').get('src/main.js').toString(), /Durable test 1/);
    assert.ok(peer.messages.find(m => m.type === 'init').history.some(e => e.actor === 'Cloud tester'));
    if (!process.env.RELAY_TEST_STORAGE_TOKEN) {
      fail = true; edit(2);
      await until(() => peer.messages.some(m => m.type === 'error'));
      assert.ok(!peer.messages.some(m => m.type === 'ack' && m.seq === 2));
      fail = false;
    }
  } finally {
    ws?.terminate();
    if (server) await server.close();
    dirs.forEach(dir => rmSync(dir, { recursive: true, force: true }));
  }
});
async function until(condition) {
  for (let n = 0; n < 300; n++) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timed out');
}
