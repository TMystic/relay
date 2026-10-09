import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { startServer } from "../legacy/server/index.js";
const encode = (b) => Buffer.from(b).toString("base64");
const waitUntil = async (condition) => {
  for (let n = 0; n < 100; n++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Timed out waiting for synchronization");
};
async function client(server, name, token = server.credentials.token) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/sync`);
  const doc = new Y.Doc();
  const messages = [];
  let initialized = false;
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw);
    messages.push(msg);
    if (msg.type === "init") {
      Y.applyUpdate(doc, Buffer.from(msg.state, "base64"), "remote");
      initialized = true;
    }
    if (msg.type === "update")
      Y.applyUpdate(doc, Buffer.from(msg.update, "base64"), "remote");
  });
  await new Promise((r) => socket.on("open", r));
  socket.send(
    JSON.stringify({ type: "join", ...server.credentials, name, token }),
  );
  await waitUntil(
    () => initialized || messages.some((m) => m.type === "error"),
  );
  return {
    socket,
    doc,
    messages,
    send: (msg) => socket.send(JSON.stringify(msg)),
    edit: (text) => {
      const state = Y.encodeStateVector(doc);
      doc.getMap("files").get("src/main.js").insert(0, text);
      return Y.encodeStateAsUpdate(doc, state);
    },
  };
}
test("two teammates converge, history names the actor, room credentials protect access, and state survives restart", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-sync-"));
  let server;
  const peers = [];
  try {
    server = await startServer({ port: 0, dataDir: dir });
    const alice = await client(server, "Alice"),
      bob = await client(server, "Bob");
    peers.push(alice, bob);
    // Both edits are based on the same initial state and arrive concurrently.
    const a = alice.edit("// Alice fixed validation\n"),
      b = bob.edit("// Bob fixed the response\n");
    alice.send({ type: "update", update: encode(a), seq: 1 });
    bob.send({ type: "update", update: encode(b), seq: 1 });
    await waitUntil(
      () =>
        alice.doc.getMap("files").get("src/main.js").toString() ===
        bob.doc.getMap("files").get("src/main.js").toString(),
    );
    const merged = alice.doc.getMap("files").get("src/main.js").toString();
    assert.match(merged, /Alice fixed/);
    assert.match(merged, /Bob fixed/);
    await waitUntil(
      () => bob.messages.filter((m) => m.type === "activity").length >= 2,
    );
    const activities = bob.messages
      .filter((m) => m.type === "activity")
      .map((m) => m.entry);
    assert.deepEqual(
      new Set(activities.map((e) => e.actor)),
      new Set(["Alice", "Bob"]),
    );
    assert.ok(activities.every((e) => e.before !== e.after));
    // An edit made while a client is disconnected is sent as a full document on rejoin.
    bob.socket.close();
    await waitUntil(() => bob.socket.readyState === WebSocket.CLOSED);
    bob.edit("// Bob worked offline\n");
    const reconnected = await client(server, "Bob");
    peers.push(reconnected);
    reconnected.send({
      type: "update",
      update: encode(Y.encodeStateAsUpdate(bob.doc)),
      seq: 2,
    });
    await waitUntil(() =>
      alice.doc
        .getMap("files")
        .get("src/main.js")
        .toString()
        .includes("Bob worked offline"),
    );
    alice.send({ type: "create-file", path: "src/new.js" });
    await waitUntil(
      () =>
        reconnected.doc.getMap("files").has("src/new.js") &&
        alice.doc.getMap("files").has("src/new.js"),
    );
    alice.send({ type: "create-file", path: "../private.js" });
    await waitUntil(() => alice.messages.some((m) => m.type === "error"));
    assert.equal(alice.doc.getMap("files").has("../private.js"), false);
    const rejected = await client(server, "Intruder", "wrong");
    peers.push(rejected);
    assert.ok(rejected.messages.some((m) => m.type === "error"));
    const other = await fetch(`http://127.0.0.1:${server.port}/api/rooms`, {
      method: "POST",
    }).then((r) => r.json());
    const isolated = await client(
      { port: server.port, credentials: other },
      "Other room",
    );
    peers.push(isolated);
    assert.equal(isolated.doc.getMap("files").has("src/new.js"), false);
    for (const peer of peers) peer.socket.terminate();
    await server.close();
    server = await startServer({ port: 0, dataDir: dir });
    const restored = await client(server, "Restored");
    peers.push(restored);
    assert.match(
      restored.doc.getMap("files").get("src/main.js").toString(),
      /Bob worked offline/,
    );
    assert.ok(restored.doc.getMap("files").has("src/new.js"));
    assert.ok(
      restored.messages.find((m) => m.type === "init").history.length >= 3,
    );
  } finally {
    for (const peer of peers) {
      peer.socket.terminate();
      peer.doc.destroy();
    }
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
