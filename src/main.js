import "./style.css";
import "./professional.css";
import { tools, defaultPreferences, loadPreferences } from "./tools.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import * as decoding from "lib0/decoding";

self.MonacoEnvironment = {
  getWorker: (_, label) =>
    label === "json" ? new JsonWorker() : new EditorWorker(),
};
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const base64 = (bytes) => {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
};
const bytes = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const languages = {
  js: "javascript",
  ts: "typescript",
  json: "json",
  md: "markdown",
  py: "python",
  css: "css",
  html: "html",
};
const languageOf = (file) => languages[file.split(".").pop()] || "plaintext";
monaco.editor.defineTheme("relay", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "7c986b" },
    { token: "keyword", foreground: "569cd6" },
    { token: "string", foreground: "ce9178" },
  ],
  colors: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "editorLineNumber.foreground": "#858585",
    "editorLineNumber.activeForeground": "#c6c6c6",
    "editor.selectionBackground": "#264f78",
    "editor.lineHighlightBackground": "#242424",
    "editorCursor.foreground": "#aeafad",
    "editorWidget.background": "#252526",
    "editorGutter.background": "#1e1e1e",
  },
});
const editor = monaco.editor.create($("editor"), {
  theme: "relay",
  editContext: false,
  contextmenu: false,
  automaticLayout: true,
  fontFamily: "Cascadia Code, Consolas, monospace",
  fontSize: 14,
  lineHeight: 22,
  padding: { top: 10 },
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: false,
  tabSize: 2,
  renderLineHighlight: "all",
  guides: { bracketPairs: false },
  bracketPairColorization: { enabled: false },
  overviewRulerLanes: 0,
  ariaLabel: "Shared code editor",
  readOnly: true,
});
let session = null,
  binding,
  undoManager,
  activeFile = "",
  openFiles = [],
  members = [],
  history = [],
  diffEditor,
  toastTimer;
let ready = false,
  seq = 0,
  ack = 0;
const peerStyles = document.createElement("style");
document.head.append(peerStyles);
let preferences;
try {
  preferences = loadPreferences(localStorage);
} catch {
  preferences = structuredClone(defaultPreferences);
}

function applyPreferences() {
  editor.updateOptions({
    fontSize: preferences.fontSize,
    lineHeight: Math.round(preferences.fontSize * 1.6),
    lineNumbers: preferences.lineNumbers ? "on" : "off",
    renderLineHighlight: preferences.highlight ? "all" : "none",
  });
  for (const tool of tools)
    editor.updateOptions(
      tool.options(preferences.enabledTools.includes(tool.id)),
    );
  $("font-size").textContent = `${preferences.fontSize} px`;
  $("setting-lines").checked = preferences.lineNumbers;
  $("setting-highlight").checked = preferences.highlight;
  $("font-decrease").disabled = preferences.fontSize <= 11;
  $("font-increase").disabled = preferences.fontSize >= 24;
  renderExtensions();
}
function savePreferences() {
  try {
    localStorage.setItem(
      "relay-editor-preferences",
      JSON.stringify(preferences),
    );
  } catch {
    notify("Settings applied for this session. Device storage is unavailable.");
  }
  applyPreferences();
}
function renderExtensions() {
  $("extensions-list").innerHTML = tools
    .map((tool) => {
      const installed = preferences.enabledTools.includes(tool.id);
      return `<article class="extension-card"><div class="extension-title"><span class="extension-badge">${escape(tool.badge)}</span><h3>${escape(tool.name)}</h3></div><p>${escape(tool.summary)}</p><div class="extension-actions"><button class="${installed ? "quiet" : "primary"}" data-tool="${tool.id}" aria-label="${installed ? "Remove" : "Install"} ${tool.name}">${installed ? "Remove" : "Install"}</button>${tool.id === "json" && installed ? `<button class="quiet" id="format-json" ${languageOf(activeFile) !== "json" ? 'disabled title="Open a JSON file to format it"' : ""}>Format file</button>` : ""}<span class="extension-tag">${installed ? "Installed" : "Built-in"}</span></div></article>`;
    })
    .join("");
}
function setView(id) {
  document
    .querySelectorAll(".sidebar-view")
    .forEach((view) => (view.hidden = view.id !== id));
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === id;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (id === "search-view") {
    renderSearch();
    $("file-search").focus();
  }
}
function renderSearch() {
  const query = $("file-search").value.toLowerCase().trim();
  $("clear-search").hidden = !query;
  const paths = session
    ? [...session.doc.getMap("files").keys()]
        .sort()
        .filter((file) => file.toLowerCase().includes(query))
    : [];
  $("search-results").innerHTML = paths.length
    ? paths
        .map(
          (file) =>
            `<button class="file-item" data-file="${escape(file)}" title="${escape(file)}"><span class="file-icon">${escape(file.split(".").pop().slice(0, 2))}</span><span>${escape(file)}</span></button>`,
        )
        .join("")
    : `<p class="empty-state">${session ? "No matching files." : "Join a workspace to search files."}</p>`;
}
function formatJSON() {
  if (!preferences.enabledTools.includes("json"))
    return notify("Install the JSON formatter from Extensions first.");
  if (languageOf(activeFile) !== "json")
    return notify("Open a JSON file to format it.");
  try {
    const formatted =
      JSON.stringify(JSON.parse(editor.getValue()), null, 2) + "\n";
    if (formatted === editor.getValue())
      return notify("This JSON file is already formatted.");
    undoManager?.stopCapturing();
    editor.executeEdits("relay-json-formatter", [
      { range: editor.getModel().getFullModelRange(), text: formatted },
    ]);
    undoManager?.stopCapturing();
    notify("JSON formatted. Changes sync with your team.");
  } catch {
    notify("Cannot format this file. Fix the JSON syntax and try again.");
  }
}
const commands = [
  { label: "View: Explorer", run: () => setView("explorer-view") },
  { label: "View: Search files", run: () => setView("search-view") },
  { label: "View: Extensions", run: () => setView("extensions-view") },
  {
    label: "Preferences: Editor settings",
    run: () => setView("settings-view"),
  },
  {
    label: "Team: Toggle collaboration panel",
    run: () => $("toggle-team").click(),
  },
  { label: "JSON: Format current file", run: formatJSON },
];
function renderQuick() {
  const query = $("quick-query").value.trim().toLowerCase();
  $("clear-quick").hidden = !query;
  if (query.startsWith(">")) {
    const results = commands
      .map((command, index) => ({ ...command, index }))
      .filter((command) =>
        command.label.toLowerCase().includes(query.slice(1).trim()),
      );
    $("quick-results").innerHTML = results.length
      ? results
          .map(
            (command) =>
              `<button class="quick-result" data-command="${command.index}">${escape(command.label)}<span>Command</span></button>`,
          )
          .join("")
      : '<p class="empty-state">No matching commands.</p>';
  } else {
    const paths = session
      ? [...session.doc.getMap("files").keys()]
          .sort()
          .filter((file) => file.toLowerCase().includes(query))
      : [];
    $("quick-results").innerHTML = paths.length
      ? paths
          .map(
            (file) =>
              `<button class="quick-result" data-quick-file="${escape(file)}">${escape(file)}<span>${escape(languageOf(file))}</span></button>`,
          )
          .join("")
      : '<p class="empty-state">No matching files. Type &gt; to search commands.</p>';
  }
}
function showQuick() {
  $("quick-query").value = "";
  renderQuick();
  $("quick-dialog").showModal();
  $("quick-query").focus();
}
$("quick-open").onclick = showQuick;
document
  .querySelectorAll("[data-view]")
  .forEach((button) => (button.onclick = () => setView(button.dataset.view)));
$("toggle-team").onclick = () => {
  const hidden = document.querySelector(".app").classList.toggle("team-hidden");
  $("toggle-team").setAttribute("aria-pressed", String(!hidden));
  editor.layout();
};
$("file-search").oninput = renderSearch;
$("clear-search").onclick = () => {
  $("file-search").value = "";
  renderSearch();
  $("file-search").focus();
};
$("search-results").onclick = (event) => {
  const button = event.target.closest("[data-file]");
  if (button) openFile(button.dataset.file);
};
$("extensions-list").onclick = (event) => {
  const button = event.target.closest("[data-tool]");
  if (button) {
    const id = button.dataset.tool;
    const installed = preferences.enabledTools.includes(id);
    preferences.enabledTools = installed
      ? preferences.enabledTools.filter((value) => value !== id)
      : [...preferences.enabledTools, id];
    savePreferences();
    notify(
      `${tools.find((tool) => tool.id === id).name} ${installed ? "removed" : "installed"}.`,
    );
    $("extensions-list").querySelector(`[data-tool="${id}"]`)?.focus();
  } else if (event.target.closest("#format-json")) formatJSON();
};
$("extension-info").onclick = () => $("extension-dialog").showModal();
$("font-decrease").onclick = () => {
  preferences.fontSize = Math.max(11, preferences.fontSize - 1);
  savePreferences();
};
$("font-increase").onclick = () => {
  preferences.fontSize = Math.min(24, preferences.fontSize + 1);
  savePreferences();
};
$("setting-lines").onchange = (event) => {
  preferences.lineNumbers = event.target.checked;
  savePreferences();
};
$("setting-highlight").onchange = (event) => {
  preferences.highlight = event.target.checked;
  savePreferences();
};
$("reset-settings").onclick = () => {
  preferences = {
    ...structuredClone(defaultPreferences),
    enabledTools: [...preferences.enabledTools],
  };
  savePreferences();
  notify("Editor settings reset.");
};
$("quick-query").oninput = renderQuick;
$("clear-quick").onclick = () => {
  $("quick-query").value = "";
  renderQuick();
  $("quick-query").focus();
};
$("quick-results").onclick = (event) => {
  const file = event.target.closest("[data-quick-file]");
  const command = event.target.closest("[data-command]");
  if (file) {
    $("quick-dialog").close();
    openFile(file.dataset.quickFile);
    editor.focus();
  } else if (command) {
    $("quick-dialog").close();
    commands[Number(command.dataset.command)].run();
  }
};
$("quick-query").onkeydown = (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    $("quick-results").querySelector("button")?.click();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    $("quick-results").querySelector("button")?.focus();
  }
};
document.addEventListener("keydown", (event) => {
  if (event.isComposing || document.querySelector("dialog[open]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
    event.preventDefault();
    showQuick();
  }
});
applyPreferences();
function notify(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
}
function status(message, mode = "connected") {
  $("sync-status").textContent = message;
  $("status-dot").dataset.mode = mode;
}
function syncStatus() {
  if (!ready) return;
  status(
    seq > ack ? "Syncing changes…" : "All changes synced",
    seq > ack ? "pending" : "connected",
  );
}
function send(message) {
  if (session?.socket?.readyState === WebSocket.OPEN)
    session.socket.send(JSON.stringify(message));
}
function setBanner(message) {
  $("connection-banner").textContent = message;
  $("connection-banner").hidden = !message;
}
function invitation() {
  const url = new URL(session.origin);
  url.hash = new URLSearchParams({
    room: session.room,
    token: session.token,
  }).toString();
  return url.href;
}
function parseInvite(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Use a full http or https Relay invite link.");
  const hash = new URLSearchParams(url.hash.slice(1));
  if (
    !/^[a-f0-9]{16}$/.test(hash.get("room") || "") ||
    !/^[a-f0-9]{48}$/.test(hash.get("token") || "")
  )
    throw new Error("The invite is incomplete. Copy the whole invite link.");
  return {
    origin: url.origin,
    room: hash.get("room"),
    token: hash.get("token"),
  };
}
function renderFiles() {
  if (!session) return;
  const files = [...session.doc.getMap("files").keys()].sort();
  $("files").innerHTML = files
    .map(
      (file) =>
        `<button class="file-item ${activeFile === file ? "selected" : ""}" data-file="${escape(file)}" title="${escape(file)}"><span class="file-icon ${file.split(".").pop()}">${escape(file.split(".").pop().slice(0, 2))}</span><span>${escape(file)}</span>${members.some((m) => m.id !== session.id && m.file === file) ? '<span class="file-live" aria-label="Teammate viewing this file"></span>' : ""}</button>`,
    )
    .join("");
  $("file-tabs").innerHTML = openFiles
    .map(
      (file) =>
        `<button class="file-tab ${activeFile === file ? "selected" : ""}" data-file="${escape(file)}" aria-pressed="${activeFile === file}"><span class="file-icon">${escape(file.split(".").pop().slice(0, 2))}</span>${escape(file.split("/").pop())}</button>`,
    )
    .join("");
  if (!activeFile && files.length)
    openFile(files.includes("src/main.js") ? "src/main.js" : files[0]);
  renderSearch();
}
function openFile(file) {
  const text = session?.doc.getMap("files").get(file);
  if (!(text instanceof Y.Text)) return;
  undoManager?.destroy();
  binding?.destroy();
  const old = editor.getModel();
  const model = monaco.editor.createModel(text.toString(), languageOf(file));
  editor.setModel(model);
  editor.setPosition({ lineNumber: 1, column: 1 });
  editor.revealLine(1);
  $("position").textContent = "Ln 1, Col 1";
  old?.dispose();
  activeFile = file;
  if (!openFiles.includes(file)) openFiles.push(file);
  // Awareness is per-file: binding states are isolated to prevent cursors from other files being rendered here.
  binding = new MonacoBinding(
    text,
    model,
    new Set([editor]),
    session.fileAwareness(file),
  );
  undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([binding]) });
  session.awareness.setLocalStateField("file", file);
  send({ type: "presence", file });
  $("file-path").textContent = file.replaceAll("/", "  /  ");
  $("language").textContent = languageOf(file);
  renderExtensions();
  renderFiles();
  renderMembers();
}
function renderMembers() {
  $("member-count").textContent = members.length;
  $("status-members").textContent = `${members.length} online`;
  $("avatars").innerHTML = members
    .slice(0, 5)
    .map(
      (m) =>
        `<span class="avatar" style="--member:${m.color}" title="${escape(m.name)}">${escape(m.name.slice(0, 1).toUpperCase())}</span>`,
    )
    .join("");
  $("members").innerHTML =
    members
      .map(
        (m) =>
          `<button class="member" data-file="${escape(m.file)}" ${m.file ? "" : "disabled"}><span class="avatar" style="--member:${m.color}">${escape(m.name.slice(0, 1).toUpperCase())}</span><span class="member-info"><strong>${escape(m.name)}${m.id === session?.id ? ' <span class="you">you</span>' : ""}</strong><small>${escape(m.file || "Choosing a file")}</small></span><span class="member-dot" style="--member:${m.color}"></span></button>`,
      )
      .join("") || '<p class="empty-state">No teammates connected.</p>';
  const viewing = members.filter(
    (m) => m.file === activeFile && m.id !== session?.id,
  );
  $("file-presence").textContent = viewing.length
    ? `${viewing.map((m) => m.name).join(", ")} here`
    : "Shared file";
  renderFiles();
}
function renderHistory() {
  $("activity").innerHTML = history.length
    ? history
        .map(
          (entry) =>
            `<button class="activity-item" data-entry="${escape(entry.id)}"><span class="timeline-dot" style="--member:${entry.color}"></span><span><strong>${escape(entry.actor)}</strong><span class="activity-action">${entry.kind === "created" ? " created a file" : " edited"}</span><span class="activity-file">${escape(entry.file)}</span><span class="activity-meta"><time datetime="${entry.time}" title="${escape(new Date(entry.time).toLocaleString())}">${new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span class="added">+${entry.added}</span><span class="removed">−${entry.removed}</span></span></span><span class="review-label">Review</span></button>`,
        )
        .join("")
    : '<div class="empty-state">No changes yet.<br>Shared edits will appear here.</div>';
}
function review(id) {
  const entry = history.find((e) => e.id === id);
  if (!entry) return;
  $("diff-title").textContent = entry.file;
  $("diff-meta").textContent =
    `${entry.actor} · ${new Date(entry.time).toLocaleString()} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  $("diff-dialog").showModal();
  if (!diffEditor)
    diffEditor = monaco.editor.createDiffEditor($("diff-editor"), {
      theme: "relay",
      readOnly: true,
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      renderSideBySide: true,
      originalEditable: false,
    });
  const previous = diffEditor.getModel();
  previous?.original.dispose();
  previous?.modified.dispose();
  diffEditor.setModel({
    original: monaco.editor.createModel(entry.before, languageOf(entry.file)),
    modified: monaco.editor.createModel(entry.after, languageOf(entry.file)),
  });
  diffEditor.layout();
}
async function join(config, name) {
  if (session) {
    undoManager?.destroy();
    binding?.destroy();
    ready = false;
    clearTimeout(session.retryTimer);
    session.closed = true;
    session.socket?.close();
    session.awareness.destroy();
    session.fileAwarenessInstance?.destroy();
    await session.persistence.destroy();
    session.doc.destroy();
  }
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const current = (session = {
    ...config,
    name,
    doc,
    awareness,
    closed: false,
    socket: null,
    retryTimer: null,
    id: "",
    color: "#6bbcff",
  });
  ready = false;
  editor.updateOptions({ readOnly: true });
  seq = 0;
  ack = 0;
  activeFile = "";
  openFiles = [];
  members = [];
  history = [];
  renderHistory();
  current.persistence = new IndexeddbPersistence(
    `relay:${config.origin}:${config.room}`,
    doc,
  );
  await current.persistence.whenSynced;
  if (current.closed) return;
  const files = doc.getMap("files");
  files.observe(renderFiles);
  current.fileAwareness = (file) => {
    current.fileAwarenessInstance?.destroy();
    const filtered = new Awareness(doc);
    current.fileAwarenessInstance = filtered;
    // Binding writes selection through this proxy; the shared awareness transmits it.
    filtered.setLocalStateField = (key, value) =>
      awareness.setLocalStateField(key, value);
    filtered.getLocalState = () => awareness.getLocalState();
    filtered.getStates = () =>
      new Map(
        [...awareness.getStates()].filter(
          ([id, state]) => id === doc.clientID || state.file === file,
        ),
      );
    return filtered;
  };
  awareness.on("change", (changes) => {
    current.fileAwarenessInstance?.emit("change", [changes, "remote"]);
  });
  doc.on("update", (update, origin) => {
    if (origin === "remote") return;
    seq++;
    if (ready) send({ type: "update", update: base64(update), seq });
    syncStatus();
  });
  awareness.on("update", ({ added, updated, removed }, origin) => {
    if (origin !== "remote" && ready)
      send({
        type: "awareness",
        update: base64(
          encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
        ),
      });
    peerStyles.textContent = [...awareness.getStates()]
      .filter(([id]) => id !== doc.clientID)
      .map(([id, state]) => {
        const color = /^#[a-f0-9]{6}$/i.test(state.user?.color || "")
          ? state.user.color
          : "#6bbcff";
        return `.yRemoteSelection-${id}{background:${color}30}.yRemoteSelectionHead-${id}{border-left:2px solid ${color}!important}.yRemoteSelectionHead-${id}::after{content:${JSON.stringify(String(state.user?.name || "Teammate").replace(/[\n\r]/g, " "))};background:${color};color:#101923;position:absolute;top:-19px;left:-2px;font:12px sans-serif;padding:2px 5px;white-space:nowrap;border-radius:3px}`;
      })
      .join("");
  });
  function connect() {
    if (current.closed) return;
    ready = false;
    status("Connecting…", "pending");
    const url = new URL("/sync", current.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = (current.socket = new WebSocket(url));
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "join",
          room: current.room,
          token: current.token,
          name,
        }),
      );
    socket.onmessage = (event) => {
      if (current !== session || current.closed) return;
      const message = JSON.parse(event.data);
      if (message.type === "init") {
        Y.applyUpdate(doc, bytes(message.state), "remote");
        current.id = message.id;
        current.color = message.color;
        history = message.history;
        ready = true;
        // Send the entire cached document so disconnected changes also merge after reconnect.
        seq++;
        send({
          type: "update",
          update: base64(Y.encodeStateAsUpdate(doc)),
          seq,
        });
        awareness.setLocalStateField("user", { name, color: message.color });
        $("room-title").textContent = message.name;
        $("workspace-title").textContent = message.name;
        $("folder-name").textContent = message.name.toLowerCase();
        $("room-code").textContent = `Room ${current.room.slice(0, 8)}`;
        document.title = `${message.name} — Relay`;
        setBanner("");
        editor.updateOptions({ readOnly: false });
        renderFiles();
        renderHistory();
        if (activeFile) {
          send({ type: "presence", file: activeFile });
          awareness.setLocalStateField("file", activeFile);
        }
        syncStatus();
      } else if (message.type === "update") {
        Y.applyUpdate(doc, bytes(message.update), "remote");
      } else if (message.type === "ack") {
        ack = Math.max(ack, message.seq || 0);
        syncStatus();
      } else if (message.type === "members") {
        members = message.members;
        renderMembers();
      } else if (message.type === "activity") {
        history = [
          message.entry,
          ...history.filter((e) => e.id !== message.entry.id),
        ].slice(0, 100);
        renderHistory();
      } else if (message.type === "awareness") {
        applyAwarenessUpdate(awareness, bytes(message.update), "remote");
      } else if (message.type === "peer-left" && message.awareness) {
        const decoder = decoding.createDecoder(bytes(message.awareness));
        const length = decoding.readVarUint(decoder);
        const ids = [];
        for (let i = 0; i < length; i++) {
          ids.push(decoding.readVarUint(decoder));
          decoding.readVarUint(decoder);
          decoding.readVarString(decoder);
        }
        removeAwarenessStates(awareness, ids, "remote");
      } else if (message.type === "file-created") {
        $("file-dialog").close();
        $("file-form").querySelector("button.primary").disabled = false;
        openFile(message.file);
        notify("File created for everyone.");
      } else if (message.type === "error") {
        setBanner(message.message);
        $("file-error").textContent = message.message;
        $("file-form").querySelector("button.primary").disabled = false;
      }
    };
    socket.onclose = (event) => {
      if (current.closed) return;
      ready = false;
      $("file-form").querySelector("button.primary").disabled = false;
      status("Offline · edits saved on this device", "offline");
      members = [];
      renderMembers();
      if (event.code === 4003) {
        editor.updateOptions({ readOnly: true });
        setBanner("Invite rejected. Switch workspace and check the invite.");
        return;
      }
      setBanner(
        "Connection lost. You can keep editing; changes will merge when the connection returns.",
      );
      current.retryTimer = setTimeout(connect, 2000);
    };
    socket.onerror = () => {};
  }
  renderFiles();
  connect();
  const localUrl = new URL(location.href);
  localUrl.hash = new URLSearchParams({
    room: current.room,
    token: current.token,
    server: current.origin,
  }).toString();
  window.history.replaceState(null, "", localUrl);
  sessionStorage.setItem("relay-name", name);
}

editor.onDidChangeCursorPosition((event) => {
  $("position").textContent =
    `Ln ${event.position.lineNumber}, Col ${event.position.column}`;
});
$("undo").onclick = () => undoManager?.undo();
$("redo").onclick = () => undoManager?.redo();
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () =>
  undoManager?.undo(),
);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () =>
  undoManager?.redo(),
);
editor.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
  () => undoManager?.redo(),
);
for (const container of ["files", "file-tabs", "members"])
  $(container).addEventListener("click", (event) => {
    const button = event.target.closest("button[data-file]");
    if (button?.dataset.file) openFile(button.dataset.file);
  });
$("activity").addEventListener("click", (event) => {
  const button = event.target.closest("[data-entry]");
  if (button) review(button.dataset.entry);
});
document
  .querySelectorAll(".close-dialog")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
$("connect").onclick = () => {
  $("connect-error").textContent = "";
  $("invite-link").value = "";
  $("connect-dialog").showModal();
};
$("new-file").onclick = () => {
  if (!ready) return notify("Reconnect before creating a file.");
  $("file-error").textContent = "";
  $("new-path").value = "";
  $("file-dialog").showModal();
  $("new-path").focus();
};
$("file-form").onsubmit = (event) => {
  event.preventDefault();
  const filename = $("new-path").value.trim();
  if (
    !/^[\w.-]+(?:\/[\w.-]+)*$/.test(filename) ||
    filename.split("/").some((p) => p === ".." || p === ".")
  ) {
    $("file-error").textContent = "Use a relative path, such as src/utils.js.";
    $("new-path").setAttribute("aria-invalid", "true");
    return $("new-path").focus();
  }
  if (!ready) {
    $("file-error").textContent = "Reconnect before creating a file.";
    return;
  }
  $("new-path").removeAttribute("aria-invalid");
  $("file-form").querySelector("button.primary").disabled = true;
  send({ type: "create-file", path: filename });
};
$("invite").onclick = () => {
  if (!session) {
    $("connect-error").textContent =
      "Open a workspace first, then invite your teammates.";
    $("connect-dialog").showModal();
    $("display-name").focus();
    return;
  }
  $("share-link").value = invitation();
  $("copy-status").textContent = "";
  $("invite-dialog").showModal();
};
$("copy-invite").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("share-link").value);
    $("copy-status").textContent = "Invite copied.";
  } catch {
    $("share-link").select();
    $("copy-status").textContent =
      "Select the invite and press Ctrl+C to copy.";
  }
};
$("download").onclick = () => {
  if (!activeFile) return;
  const blob = new Blob([editor.getValue()], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = activeFile.split("/").pop();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
async function submitConnect(create) {
  const name = $("display-name").value.trim();
  if (!name) {
    $("connect-error").textContent =
      "Enter your name so teammates know who is editing.";
    $("display-name").setAttribute("aria-invalid", "true");
    return $("display-name").focus();
  }
  $("display-name").removeAttribute("aria-invalid");
  const buttons = [...$("connect-form").querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    let config;
    if (!create && $("invite-link").value.trim())
      config = parseInvite($("invite-link").value.trim());
    else {
      const response = await fetch(create ? "/api/rooms" : "/api/bootstrap", {
        method: create ? "POST" : "GET",
      });
      if (!response.ok)
        throw new Error("An invite is required to join this server.");
      config = { ...(await response.json()), origin: location.origin };
    }
    await join(config, name);
    $("connect-dialog").close();
  } catch (error) {
    $("connect-error").textContent = error.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$("connect-form").onsubmit = (event) => {
  event.preventDefault();
  submitConnect(false);
};
$("create-room").onclick = () => submitConnect(true);
$("display-name").value = sessionStorage.getItem("relay-name") || "";
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has("room")) {
  const origin = hash.get("server") || location.origin;
  const url = new URL(origin);
  url.hash = new URLSearchParams({
    room: hash.get("room"),
    token: hash.get("token"),
  }).toString();
  $("invite-link").value = url.href;
}
$("connect-dialog").showModal();
window.addEventListener("beforeunload", (event) => {
  if (seq > ack) {
    event.preventDefault();
    event.returnValue = "";
  }
});
