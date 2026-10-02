// Explicit manual smoke test for the deployed server. Creates one test workspace.
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
const origin = process.env.RELAY_PUBLIC_URL;
if (!origin || new URL(origin).protocol !== 'https:') throw new Error('Set RELAY_PUBLIC_URL to the public HTTPS editor.');
assert.equal((await fetch(`${origin}/health`)).status, 200);
assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 403);
const response = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin } });
assert.equal(response.status, 200);
const invite = await response.json();
const peers = [];
async function connect(name, token = invite.token) {
  const socket = new WebSocket(`${origin.replace('https:', 'wss:')}/sync`);
  const doc = new Y.Doc(), messages = [];
  const peer = { socket, doc, messages }; peers.push(peer);
  socket.on('message', raw => {
    const message = JSON.parse(raw); messages.push(message);
    if (message.type === 'init' || message.type === 'update') Y.applyUpdate(doc, Buffer.from(message.state || message.update, 'base64'));
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'join', ...invite, token, name }));
  await until(() => messages.some(m => ['init', 'error'].includes(m.type)));
  return peer;
}
try {
  const a = await connect('Internet tester A'), b = await connect('Internet tester B');
  const wrong = await connect('Invalid invite', '0'.repeat(48));
  assert.ok(wrong.messages.some(m => m.type === 'error'));
  const vector = Y.encodeStateVector(a.doc);
  a.doc.getMap('files').get('src/main.js').insert(0, '// Verified internet collaboration\n');
  a.socket.send(JSON.stringify({ type: 'update', seq: 1, update: Buffer.from(Y.encodeStateAsUpdate(a.doc, vector)).toString('base64') }));
  await until(() => a.messages.some(m => m.type === 'ack' && m.seq === 1));
  await until(() => b.doc.getMap('files').get('src/main.js').toString().startsWith('// Verified internet collaboration'));
  await until(() => b.messages.some(m => m.type === 'activity' && m.entry.actor === 'Internet tester A'));
  const c = await connect('Rejoining tester');
  assert.match(c.doc.getMap('files').get('src/main.js').toString(), /Verified internet collaboration/);
  console.log('PASS: HTTPS health, private bootstrap, room creation, WSS invite authentication, two-peer edits, durable acknowledgment, actor history, and rejoin.');
} finally { for (const peer of peers) { peer.socket.terminate(); peer.doc.destroy(); } }
async function until(condition) {
  for (let n = 0; n < 300; n++) { if (condition()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out waiting for public collaboration');
}
