import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import { diffLines } from "diff";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const colors = ["#6bbcff", "#f4bb73", "#b7a0ff", "#6fd6bb", "#f08bad"];
const encode = (value) => Buffer.from(value).toString("base64");
const decode = (value) => new Uint8Array(Buffer.from(value, "base64"));
const validPath = (value) =>
  typeof value === "string" &&
  /^[\w.-]+(?:\/[\w.-]+)*$/.test(value) &&
  !value.split("/").some((p) => p === "." || p === "..") &&
  value.length <= 120;
const starters = {
  "src/main.js": `// Welcome to your shared workspace.\n// Invite a teammate. Edit together. Skip the push / pull loop.\n\nimport { createWorkspace } from './workspace.js';\n\nconst workspace = createWorkspace({\n  name: 'Our next big idea',\n  collaboration: true,\n});\n\nexport function welcome(name) {\n  return \`Hello, \${name}. Let's build something together.\`;\n}\n\nconsole.log(welcome('team'));\nconsole.log(workspace);\n`,
  "src/workspace.js": `export function createWorkspace({ name, collaboration }) {\n  return {\n    name,\n    collaboration,\n    members: [],\n    createdAt: new Date().toISOString(),\n  };\n}\n`,
  "README.md": `# Our shared workspace\n\nEvery teammate sees edits live, even before a commit.\n\n1. Invite your teammate using the invite button.\n2. Open the same file and try editing at the same time.\n3. Click a change in the live feed to review its before and after.\n\nRelay does not execute your code or push it to Git.\n`,
  "package.json":
    '{\n  "name": "our-shared-project",\n  "version": "0.1.0",\n  "type": "module"\n}\n',
};

export async function startServer({
  port = 4317,
  host = "127.0.0.1",
  dataDir = path.join(root, "data"),
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rooms = new Map();
  const atomic = (filename, content) => {
    fs.writeFileSync(filename + ".tmp", content);
    fs.renameSync(filename + ".tmp", filename);
  };
  const send = (ws, message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const broadcast = (room, message, except) => {
    for (const peer of room.peers) if (peer !== except) send(peer, message);
  };
  function persist(room) {
    atomic(
      path.join(dataDir, `${room.id}.json`),
      JSON.stringify({
        id: room.id,
        token: room.token,
        name: room.name,
        state: encode(Y.encodeStateAsUpdate(room.doc)),
        history: room.history,
      }),
    );
  }
  function finishActivity(room) {
    clearTimeout(room.activityTimer);
    const entry = room.pending;
    room.pending = null;
    if (!entry || entry.before === entry.after) return;
    const diff = diffLines(entry.before, entry.after);
    entry.added = diff
      .filter((p) => p.added)
      .reduce((sum, p) => sum + p.count, 0);
    entry.removed = diff
      .filter((p) => p.removed)
      .reduce((sum, p) => sum + p.count, 0);
    room.history.unshift(entry);
    room.history.length = Math.min(room.history.length, 100);
    persist(room);
    broadcast(room, { type: "activity", entry });
  }
  function loadRoom(id) {
    if (rooms.has(id)) return rooms.get(id);
    if (!/^[a-f0-9]{16}$/.test(id)) return null;
    const filename = path.join(dataDir, `${id}.json`);
    if (!fs.existsSync(filename)) return null;
    const stored = JSON.parse(fs.readFileSync(filename, "utf8"));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decode(stored.state));
    const room = {
      ...stored,
      doc,
      peers: new Set(),
      pending: null,
      activityTimer: null,
    };
    doc.on("update", (update, origin) => {
      persist(room);
      broadcast(room, { type: "update", update: encode(update) }, origin);
    });
    rooms.set(id, room);
    return room;
  }
  function createRoom(name = "Team workspace") {
    const room = {
      id: randomBytes(8).toString("hex"),
      token: randomBytes(24).toString("hex"),
      name,
      doc: new Y.Doc(),
      history: [],
    };
    const files = room.doc.getMap("files");
    room.doc.transact(() => {
      for (const [filename, text] of Object.entries(starters))
        files.set(filename, new Y.Text(text));
    });
    persist(room);
    room.doc.destroy();
    return loadRoom(room.id);
  }
  const defaultPath = path.join(dataDir, "default.json");
  let localRoom;
  if (fs.existsSync(defaultPath))
    localRoom = loadRoom(JSON.parse(fs.readFileSync(defaultPath)).id);
  if (!localRoom) {
    localRoom = createRoom("Launchpad");
    atomic(defaultPath, JSON.stringify({ id: localRoom.id }));
  }
  const credentials = (room) => ({
    room: room.id,
    token: room.token,
    name: room.name,
  });
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".ttf": "font/ttf",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      );
      if (!loopback) {
        res.writeHead(403);
        return res.end("An invite is required.");
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify(credentials(localRoom)));
    }
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) {
        res.writeHead(403);
        return res.end();
      }
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        )
      ) {
        res.writeHead(403);
        return res.end("Only the host can create workspaces.");
      }
      const room = createRoom();
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(credentials(room)));
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      return res.end();
    }
    const dist = path.join(root, "dist");
    let filename;
    try {
      filename = path.resolve(dist, "." + decodeURIComponent(url.pathname));
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (!filename.startsWith(dist + path.sep) && filename !== dist) {
      res.writeHead(403);
      return res.end();
    }
    if (url.pathname === "/") filename = path.join(dist, "index.html");
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      res.writeHead(404);
      return res.end("File not found. Build Relay first.");
    }
    res.setHeader(
      "Content-Type",
      mime[path.extname(filename)] || "application/octet-stream",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' ws: wss: http: https:; img-src 'self' data:; font-src 'self' data:",
    );
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filename).pipe(res);
  });
  const wss = new WebSocketServer({
    server,
    path: "/sync",
    maxPayload: 2 * 1024 * 1024,
  });
  function roster(room) {
    broadcast(room, {
      type: "members",
      members: [...room.peers].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        file: p.file,
      })),
    });
  }
  wss.on("connection", (ws) => {
    ws.alive = true;
    ws.on("pong", () => {
      ws.alive = true;
    });
    const joinTimeout = setTimeout(() => {
      if (!ws.room) ws.close(4001, "Join required");
    }, 10000);
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (!ws.room) {
          if (
            message.type !== "join" ||
            typeof message.room !== "string" ||
            typeof message.token !== "string"
          )
            throw new Error("Invalid invite.");
          const room = loadRoom(message.room);
          const token = Buffer.from(message.token);
          if (
            !room ||
            token.length !== Buffer.byteLength(room.token) ||
            !timingSafeEqual(token, Buffer.from(room.token))
          ) {
            send(ws, {
              type: "error",
              message:
                "This invite is invalid. Check the full link and try again.",
            });
            return ws.close(4003);
          }
          clearTimeout(joinTimeout);
          ws.room = room;
          ws.id = randomUUID();
          ws.name = String(message.name || "Teammate").slice(0, 40);
          ws.color = colors[room.peers.size % colors.length];
          ws.file = "";
          room.peers.add(ws);
          send(ws, {
            type: "init",
            id: ws.id,
            color: ws.color,
            name: room.name,
            state: encode(Y.encodeStateAsUpdate(room.doc)),
            history: room.history,
          });
          for (const peer of room.peers)
            if (peer.awareness)
              send(ws, { type: "awareness", update: peer.awareness });
          roster(room);
          return;
        }
        const room = ws.room;
        if (message.type === "update") {
          if (typeof message.update !== "string")
            throw new Error("Invalid update.");
          const files = room.doc.getMap("files");
          const before = new Map(
            [...files].map(([key, text]) => [key, text.toString()]),
          );
          Y.applyUpdate(room.doc, decode(message.update), ws);
          for (const [filename, text] of files) {
            const prior = before.get(filename) || "";
            const after = text.toString();
            if (prior === after) continue;
            if (
              room.pending &&
              (room.pending.actorId !== ws.id || room.pending.file !== filename)
            )
              finishActivity(room);
            if (!room.pending)
              room.pending = {
                id: randomUUID(),
                actorId: ws.id,
                actor: ws.name,
                color: ws.color,
                file: filename,
                before: prior,
                after,
                time: new Date().toISOString(),
              };
            else {
              room.pending.after = after;
              room.pending.time = new Date().toISOString();
            }
            clearTimeout(room.activityTimer);
            room.activityTimer = setTimeout(() => finishActivity(room), 700);
          }
          send(ws, { type: "ack", seq: message.seq });
        } else if (message.type === "presence") {
          ws.file = validPath(message.file) ? message.file : "";
          roster(room);
        } else if (
          message.type === "awareness" &&
          typeof message.update === "string" &&
          message.update.length < 30000
        ) {
          ws.awareness = message.update;
          broadcast(room, { type: "awareness", update: message.update }, ws);
        } else if (message.type === "create-file") {
          if (!validPath(message.path))
            throw new Error("Use a relative file path, such as src/utils.js.");
          if (room.doc.getMap("files").has(message.path))
            throw new Error("A file with this path already exists.");
          room.doc.transact(
            () => room.doc.getMap("files").set(message.path, new Y.Text("")),
            "server-create",
          );
          const entry = {
            id: randomUUID(),
            actor: ws.name,
            color: ws.color,
            file: message.path,
            before: "",
            after: "",
            added: 0,
            removed: 0,
            kind: "created",
            time: new Date().toISOString(),
          };
          room.history.unshift(entry);
          room.history.length = Math.min(room.history.length, 100);
          persist(room);
          broadcast(room, { type: "activity", entry });
          send(ws, { type: "file-created", file: message.path });
        }
      } catch (error) {
        send(ws, {
          type: "error",
          message: "The operation could not be completed. " + error.message,
        });
      }
    });
    ws.on("close", () => {
      clearTimeout(joinTimeout);
      if (ws.room) {
        finishActivity(ws.room);
        ws.room.peers.delete(ws);
        broadcast(ws.room, {
          type: "peer-left",
          awareness: ws.awareness || null,
        });
        roster(ws.room);
      }
    });
    ws.on("error", () => {});
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const flush = () => {
    for (const room of rooms.values()) {
      finishActivity(room);
      persist(room);
    }
  };
  return {
    server,
    port: server.address().port,
    credentials: credentials(localRoom),
    flush,
    close: async () => {
      clearInterval(heartbeat);
      flush();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      for (const room of rooms.values()) room.doc.destroy();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const instance = await startServer({
    port: Number(process.env.PORT || 4317),
    host: process.env.RELAY_HOST || "127.0.0.1",
    dataDir: process.env.RELAY_DATA_DIR || path.join(root, "data"),
  });
  console.log(
    `Relay listening on http://${process.env.RELAY_HOST || "127.0.0.1"}:${instance.port}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await instance.close();
      process.exit(0);
    });
}
