// Only the Node server receives this restricted storage credential.
export function cloudStore({ url, token, delay = 750 }) {
  if (!url || !token || new URL(url).protocol !== 'https:')
    throw new Error('Hosted Relay requires HTTPS durable storage and a storage token.');
  const pending = new Map();
  let healthy = true;
  async function request(body) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-storage-token': token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('Cloud storage is temporarily unavailable.');
      const result = await response.json();
      healthy = true;
      return result;
    } catch (error) { healthy = false; throw error; }
  }
  async function drain(id, item) {
    if (item.running) return;
    clearTimeout(item.timer);
    item.timer = null;
    item.running = true;
    const room = item.room, waiters = item.waiters.splice(0);
    item.room = null;
    try { await request({ action: 'save', room }); waiters.forEach(w => w.resolve()); }
    catch (error) { waiters.forEach(w => w.reject(error)); }
    item.running = false;
    if (item.room) item.timer = setTimeout(() => drain(id, item), delay);
    else pending.delete(id);
  }
  return {
    get healthy() { return healthy; },
    async loadAll() {
      const rooms = [];
      for (let offset = 0; ; offset += 100) {
        const page = await request({ action: 'load', offset });
        rooms.push(...page);
        if (page.length < 100) return rooms;
      }
    },
    save(room) {
      let item = pending.get(room.id);
      if (!item) { item = { running: false, room: null, waiters: [], timer: null }; pending.set(room.id, item); }
      item.room = room;
      return new Promise((resolve, reject) => {
        item.waiters.push({ resolve, reject });
        if (!item.running && !item.timer) item.timer = setTimeout(() => { item.timer = null; drain(room.id, item); }, delay);
      });
    },
  };
}
