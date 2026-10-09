# Historical classic UI contract (0.2)

The active 0.3 peer design is documented in PEER-ARCHITECTURE.md.

# Relay behavior contract

Product source: the user's October 2, 2026 request for a desktop editor where teammates' fixes reach everyone without pushing/pulling. See README.md for prototype boundaries.

## Canonical UI Map

| Capability | Canonical owner                                             | Source of truth          | Allowed variants            | Verification                         |
| ---------- | ----------------------------------------------------------- | ------------------------ | --------------------------- | ------------------------------------ |
| Form       | index.html forms and submitConnect/file-form in src/main.js | This contract            | join / new file             | browser validation and file creation |
| Scrollbar  | src/style.css global baseline                               | DESIGN.md                | panel geometry              | computed style                       |
| Toast      | notify in src/main.js                                       | This contract            | export / file feedback      | browser live region                  |
| CRUD       | legacy/server/index.js room protocol                               | User brief and README.md | create/read/edit; no delete | tests/sync.test.js                   |

## Flows and recovery

Join requires a name; invite is optional on the hosting computer. A room has an opaque ID and bearer invite token. Anyone holding the token can edit. There are no role controls or account identities in this prototype. Display names are self-declared; activity is not a compliance audit log. Server access follows README.md, not implied public deployment.

Source updates use Yjs, never last-writer-wins replacement. Monaco binds one active file, and undo tracks the user's edits. Per-file awareness prevents a cursor in another file being displayed in this one. Selecting a teammate opens the file they are viewing.

Acknowledgment controls the synced indicator. Offline editing preserves the local Yjs state through IndexedDB, and reconnection merges the cached document. Workspace switch destroys the old connection and binding. Beforeunload warns while updates are unacknowledged. There is no automatic destructive replacement or deletion flow.

Create file validates a relative path, rejects duplicates, disables duplicate submit, stays in the workspace, and opens the new file. Failure retains the path and explains the correction. Export downloads the current file only. Changes are coalesced by actor/file for 700ms and kept as the latest 100 before/after snapshots. Review is read-only.

Dialogs share native showModal focus and Escape behavior; close restores trigger focus. File selection, member selection, and history review are buttons. Errors remain in fields or the connection banner. No browser alert/confirm/prompt product flows. No select, date, table, destructive action, or authentication form is in scope.

## Professional workbench and Relay plugins

The user requested a restrained VS Code-style UI and explicitly chose Relay plugins first. The activity bar switches sidebars without discarding the open document. The team toggle changes visibility only. Neutral charcoal replaces blue prototype surfaces.

src/tools.js owns the bundled allowlisted plugin catalog and default preferences. src/main.js owns install/remove actions and applies options through applyPreferences. Preferences are local to this device with storage failure recovery. No package or external code is downloaded or evaluated. JSON formatting validates before changing the file, uses Monaco edits so collaboration and individual undo apply, and has its own undo boundary. VS Code Marketplace/VSIX compatibility remains unavailable.

File search filters room paths locally, exposes clear and empty states, and refreshes on shared file changes. Queries are transient device state and are not included in room URLs. Quick navigation is a native modal with files and commands; it supports Enter, ArrowDown, Tab, Escape, and Ctrl/Cmd+P and ignores composing keystrokes. Native checkboxes own boolean settings, and buttons with an output own font size.

## Full desktop engine — 0.2.0
The user approved replacing the desktop workbench with Code-OSS. Native commands own folders, terminal and compatible Open VSX/VSIX extensions. The earlier contract applies to the browser companion. Relay's native extension owns invite/join, source mirroring, presence and review. Remote sessions cannot execute terminal commands. Shared deletion moves local files to trash. Verification: extension/engine-tests.cjs.

