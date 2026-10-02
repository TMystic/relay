import { timingSafeEqual } from 'node:crypto';
import * as Y from 'yjs';

export async function readJson(req, limit = 3 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Workspace is too large to share.');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

export function validToken(room, token) {
  if (!room || typeof token !== 'string') return false;
  const provided = Buffer.from(token), expected = Buffer.from(room.token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function publishRoom(room, origin) {
  const capabilities = await fetch(new URL('/api/config', origin), { signal: AbortSignal.timeout(120000) });
  if (!capabilities.ok || !(await capabilities.json()).acceptsWorkspaceImport)
    throw new Error('The online Relay server needs an update before this workspace can be shared.');
  const response = await fetch(new URL('/api/rooms', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({
      name: room.name,
      state: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64'),
      history: room.history,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('The online server could not share this workspace. Please retry.');
  const config = await response.json();
  if (!/^[a-f0-9]{16}$/.test(config.room) || !/^[a-f0-9]{48}$/.test(config.token))
    throw new Error('The online server returned an invalid invitation.');
  return { ...config, origin };
}
