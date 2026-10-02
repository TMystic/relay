# Relay — a shared desktop coding editor

Relay is a working first prototype of a team editor: Monaco source editing, real Yjs synchronization over WebSockets, contributor cursors, project rooms, a live activity feed, and read-only before/after change review. The desktop shell is Electron, with the same renderer available through the room server.

## Start the desktop editor

On Windows, double-click **Launch Relay.cmd**, or use the commands below. The source and desktop shell are included. Desktop launch verification in this environment is incomplete; see VERIFICATION.md. The working browser companion can be started with `npm run build` followed by `npm run server` and opened at http://localhost:4317.

Requires Node.js 20.19+ (Node.js 22 LTS recommended).

## Build Windows and Linux downloads

Packaged downloads bundle the editor, its local room server, and the Electron runtime. End users do not need Node.js.

On Windows, run `npm ci` followed by `npm run package:win`. On Linux, run `npm ci` followed by `npm run package:linux`.

Files appear in `release/`: `Relay-Setup-0.1.0-x64.exe`, `Relay-Portable-0.1.0-x64.exe`, and `Relay-0.1.0-x64.deb`. Double-click the Windows installer; the portable executable runs without installation. On Ubuntu, install the downloaded package with `sudo apt install ./Relay-0.1.0-x64.deb`, then launch Relay from Applications or run `relay`.

Linux requires a graphical desktop or WSLg. Install dependencies separately on each operating system; do not reuse Windows `node_modules` on Linux. Windows packages are unsigned. Native desktop runtime testing remains incomplete; see VERIFICATION.md.

The included **Build downloadable packages** GitHub Actions workflow builds both platforms on a push to `main`, pull requests, or manual dispatch. Download the Windows and Linux artifacts from a successful workflow run. A version tag such as `v0.1.0` creates a draft GitHub release with installers attached after both builds succeed. Review and publish that draft to make release downloads public. The tag should match the version in `package.json`.

```powershell
cd path/to/relay
npm install
npm start
```

Enter your name and join the local workspace. Click **Invite teammate**, copy the invite, and open it in another browser window on this computer. Use a different name and edit the same file to watch edits merge live. Teammates using the desktop editor can paste the invite into **Switch workspace**.

## Connect different computers

Every editor must connect to the same room server. For a trusted local network, start the standalone room server on the host computer:

```powershell
npm run build
$env:RELAY_HOST = '0.0.0.0'
npm run server
```

Open http://localhost:4317 on the host, join, and copy the invite. Replace only `localhost` with the host's LAN address (for example `192.168.1.20`) and send that full invite to teammates. They can paste it into their desktop editor or open it in a browser. The host may need to allow the chosen port through their firewall. LAN connections use unencrypted HTTP; use this only on a trusted network. For internet collaboration, deploy the server behind HTTPS/WSS with account authentication and access controls before sharing sensitive code. This task has not deployed a public service.

## What works

- Neutral VS Code-style workbench, activity bar, file search, and Ctrl/Cmd+P quick navigation.
- Relay plugin catalog: install/remove minimap, word wrap, bracket guides, and JSON formatter.
- Device-local editor settings for font size, line numbers, and line highlighting.

- Concurrent edits converge rather than overwrite one another.
- Member presence, file following, and per-file selection/cursor colors.
- File creation synchronizes across all connected members.
- Activity names the editor and file, with timestamp and before/after diff.
- Reconnection merges offline edits. IndexedDB stores local room document drafts.
- Server state and the latest 100 activity snapshots survive restart.
- Export the current file as a download.

Desktop data is stored in Electron's per-user Relay data directory. Standalone server data is in `data/` (override with `RELAY_DATA_DIR`). Copy the whole directory for a backup. Invite tokens are secrets; anyone with one has full edit access. Keep invites private. Names are self-declared, not verified identities.

## Boundaries and next milestones

This is not yet a full VS Code replacement. It has no local-folder/Git import, Git commit/push, VS Code Marketplace/VSIX extensions, language servers, debugging, terminal execution, role-based permissions, verified accounts, invite revocation, encrypted internet hosting, automatic updates, or large-team load testing. There is no configured member cap, but there is no unlimited-scale guarantee. Shared live files are the collaboration workspace; exporting a file does not keep an existing local repository in sync.

Next: add project-folder import/export and Git checkpoints; then accounts with owner/editor/viewer roles and invite revocation; then authenticated hosted rooms and a packaged desktop installer. Run project code only in an explicitly designed isolated execution environment.

## Verification

```powershell
npm test
npm run build
```

The sync integration test uses actual WebSocket clients to verify simultaneous editing, offline merge, room isolation, invalid-invite rejection, file creation, history attribution, and restart persistence.
