# Verification — October 2, 2026

## Passed

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
- The GitHub packaging workflow is included in source. GitHub authentication in this session did not permit pushing the changes; apply the included packaging patch and push from your authenticated Ubuntu checkout to enable it.

- Electron binary downloaded and launch attempted, but its graphics process failed with Windows exit code `0xC0000135` in this execution environment. A second launch with software rendering also failed. Desktop runtime verification remains incomplete; the launch script and Electron shell are included.
- No multi-computer LAN, internet-hosted, large-team, screen-reader, or native Windows installer testing was performed.

This is a functional collaboration prototype with a desktop shell, not a production release.
