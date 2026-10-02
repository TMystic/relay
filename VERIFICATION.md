# Verification — October 2, 2026

## Passed

- 0.1.1 startup flow: close the initial join dialog, click Invite teammate, enter a name, join the local workspace, and open the invitation dialog. Verified in the browser. Unjoined startup now says Not connected instead of Connecting.

- Production renderer build.
- Professional redesign visually inspected at 1440 × 900 and 390 × 844; no horizontal page overflow observed. Temporary viewport overrides were reset.
- File search, empty results, clear search, quick file navigation, keyboard command selection, team panel toggle, font controls, and saved plugin state after reload checked in the browser.
- Relay tools: minimap install/remove changes the actual editor, bracket guides install/remove works, JSON formatting succeeds for valid JSON and leaves invalid JSON unchanged. Formatting has an independent undo step.
- Real WebSocket integration: simultaneous edits converge, disconnected edits merge on rejoin, workspaces remain isolated, invalid invites are rejected, new files reach the creator and other peers, actor attribution is recorded, state/history survive restart.
- Browser UI with two sessions: actual source typing syncs without a reload; Sam's undo preserves Alex's change; redo restores Sam's change; before/after review opens; new file opens for the creator and appears for the other session; sessions reconnect after server restart.
- Join validation, native modal behavior, contributor presence, per-file selection, and narrow layout observed through the browser UI.
- Strict premium UI static audit: no findings.
- DESIGN.md lint: zero errors. Informational unused component-reference warnings remain for tokens owned by the runtime stylesheet.

## Unverified or limited

- Packaging: Windows x64 NSIS installer and portable executable built successfully with electron-builder 26.15.3 and Electron 40.10.2. Packaged renderer/server/dependencies were checked. Packaged Windows smoke launch still fails in this environment with graphics-process code `0xC0000135`; an installer build is not proof of successful runtime launch.
- Linux x64 directory built from the official Electron archive with its SHA256 checked against the vendor's checksum file. The downloadable amd64 `.deb` was assembled on Windows with Debian archive structure, desktop entry, dependencies, root-owned files, and sandbox permissions. Ubuntu installation/runtime and native GitHub Actions builds have not been executed here.
- The GitHub packaging workflow is included in source and has been pushed through the connected GitHub account. Native package build results must be checked in Actions; local installer generation does not establish native runtime success.

- Electron binary downloaded and launch attempted, but its graphics process failed with Windows exit code `0xC0000135` in this execution environment. A second launch with software rendering also failed. Desktop runtime verification remains incomplete; the launch script and Electron shell are included.
- No multi-computer LAN, internet-hosted, large-team, screen-reader, or native Windows installer testing was performed.

This is a functional collaboration prototype with a desktop shell, not a production release.

## Relay 0.2.0 — full desktop engine verification

The desktop now includes official VSCodium 1.135.06055 with pinned SHA-256 verification, a real VS Code extension host, local folders and terminals. The earlier browser-specific limitations above describe historical versions.

Verified on October 2, 2026:
- All six protocol/storage/project-collection tests passed locally and on native Windows/Linux CI.
- Real Linux editor extension-host checks passed: create a filesystem folder; native TextDocument changes reach another client; remote edits update the native document while retaining local edits; file creation with folders/spaces synchronizes; a terminal starts a local shell process; installed Prettier is visible in the extension host.
- Windows installer and portable downloads built locally. Their packaged manifests, engine and bundled Relay VSIX were checked. The engine CLI successfully installed Relay and Prettier through Open VSX.
- Public server reports version 0.2.0 and accepts workspace imports.

Windows graphical runtime remains unverified in this restricted environment: launching the engine hits graphics/registry failures. Native Linux runtime checks pass. Full project execution depends on locally installed language runtimes. Compatible extensions use Open VSX/VSIX; Microsoft-only extension restrictions apply.

Native build/check run: https://github.com/TMystic/relay/actions/runs/37042609246
