// Deploy as a Supabase Edge Function. Set RELAY_STORAGE_TOKEN privately.
const storageToken = Deno.env.get('RELAY_STORAGE_TOKEN') || '__PRIVATE_DEPLOYMENT_TOKEN__';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function authorized(value: string) {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(value), digest(storageToken)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return storageToken !== '__PRIVATE_DEPLOYMENT_TOKEN__' && diff === 0;
}
Deno.serve(async (req: Request) => {
  if (!await authorized(req.headers.get('x-relay-storage-token') || '')) return json({ error: 'Unauthorized' }, 401);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const raw = await req.text();
    if (raw.length > 8 * 1024 * 1024) return json({ error: 'Workspace too large' }, 413);
    const body = JSON.parse(raw);
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const base = `${Deno.env.get('SUPABASE_URL')}/rest/v1/relay_rooms`;
    let response;
    if (body.action === 'load' && Number.isSafeInteger(body.offset) && body.offset >= 0) {
      response = await fetch(`${base}?select=data&order=id&limit=100&offset=${body.offset}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Storage failure');
      return json((await response.json()).map((row: { data: unknown }) => row.data));
    }
    if (body.action === 'save') {
      const room = body.room;
      if (!room || !/^[a-f0-9]{16}$/.test(room.id) || !/^[a-f0-9]{48}$/.test(room.token) || typeof room.name !== 'string' || typeof room.state !== 'string' || !Array.isArray(room.history)) return json({ error: 'Invalid room' }, 400);
      headers.Prefer = 'resolution=merge-duplicates,return=minimal';
      response = await fetch(`${base}?on_conflict=id`, { method: 'POST', headers, body: JSON.stringify({ id: room.id, data: room, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Storage failure');
      return json({ ok: true });
    }
    return json({ error: 'Invalid operation' }, 400);
  } catch { return json({ error: 'Storage unavailable' }, 503); }
});
