# Relay 0.4.5 â€” code-aware peer collaboration

A desktop editor built on VSCodium/Code-OSS. Edits travel between teammates over encrypted peer connections. Local encrypted checkpoints and peer replicas are primary. Optional Supabase recovery stores end-to-end encrypted copies only when local saving or peer replication fails.

This is a development version. Existing 0.2 installers remain unchanged in the verified rollback backup and do not contain these changes.

## Beta testing â€” Relay Beta Tester 0.4.5-beta.1

Try code checks, a recoverable project timeline, and independent resumable file synchronization with optional encrypted cloud recovery. The Windows and Linux beta packages are built from the source published in this repository.

| Platform | Download |
| --- | --- |
| Windows x64 â€” portable | [Portable EXE](https://github.com/TMystic/relay/releases/download/beta-0.4.5/Relay-Beta-Tester-Portable-0.4.5-beta.1-x64.exe) |
| Windows x64 â€” installer | [Setup EXE](https://github.com/TMystic/relay/releases/download/beta-0.4.5/Relay-Beta-Tester-Setup-0.4.5-beta.1-x64.exe) |
| Linux x64 â€” standalone | [AppImage](https://github.com/TMystic/relay/releases/download/beta-0.4.5/Relay-Beta-Tester-0.4.5-beta.1-x86_64.AppImage) |
| Ubuntu / Debian amd64 | [Debian package](https://github.com/TMystic/relay/releases/download/beta-0.4.5/Relay-Beta-Tester-0.4.5-beta.1-amd64.deb) |

[Beta release](https://github.com/TMystic/relay/releases/tag/beta-0.4.5)


Use a separate test project. The beta uses its own application identity/settings profile. Windows executables are unsigned. On Linux, make the AppImage executable; if FUSE is unavailable, run it with --appimage-extract-and-run, or install the .deb package.

Test live edits on two devices, offline edits and reconnection, and late joining after the original author closes their device. Enable **Relay: Enable Encrypted Recovery** for cloud-fallback testing, have the workspace owner provision recovery, and use the updated invitation. Recovery uploads on local-save failure or when the current edit lacks peer acknowledgement at the 10-second check; wait for a confirmed save before closing the last device.

The beta does not use the legacy browser companion or old HTTPS invitations. Full Windows UI and real-device network testing remain pending. [Report beta issues](https://github.com/TMystic/relay/issues/new) with the beta version, operating system, reproduction steps and logs with private invitations/credentials removed.

### Changed in this beta

- **Code Checks focuses on collaboration:** teammate function changes and overlapping edits appear here. Ordinary compiler errors stay in the editor's Problems panel. If a language extension cannot identify functions, Relay shows a teammate file-change notice instead.
- **External tool changes refresh without restart:** edits made on disk by tools such as OpenCode now merge into dirty editor buffers and reach teammates. Concurrent unsaved typing is preserved; changes without reliable saved ancestry require review rather than overwriting either copy.
- **Safer incoming writes:** text and binary updates use exclusive atomic temporary files, preserve supported file permissions, and retain the previous contents if a durable write fails. Pre-existing temporary symlinks and outside hard-link aliases cannot redirect incoming writes.

Verified with 54 automated scenarios, 33 installed native-editor checks in an isolated Linux editor, and a dependency audit with zero known vulnerabilities. The previous rapid-typing, Live Changes, offline merge, timeline, selective-sharing and resumable-transfer fixes are retained. Final installer payload and Windows/Linux runtime checks are recorded in [VERIFICATION.md](VERIFICATION.md). Interactive Windows installation and separate-device internet testing remain beta release gates.

## What to test in this beta

- **Code Checks:** teammate function changes appear as review notices; recent edits by different actors inside the same function produce an overlap warning when the language extension supplies document symbols. Without symbols, teammate file changes are shown. Ordinary syntax/type errors remain in Problems and are not listed here. These notices do not prove the code is logically correct.
- **Review Suggested Repairs:** choose an error and a language extension's text-only quick fix, inspect the comparison, then explicitly apply it. Relay stops if the file changes while you review.
- **Project Timeline:** save named checkpoints with Git branch/commit references, inspect full saved file versions, and use **Review Safe Restore** to undo a selected change. Unrelated newer text edits survive; overlapping changes stop for manual review. File creation/deletion and binary restores require an exact current-version match.
- **Git:** create branches and commits through the editor's Git controls. **Open GitHub Pull Request** opens the current branch's comparison page; push and submit the reviewed pull request yourself.
- **Choose Shared Files:** before creating an invite, select exclusion patterns and explicitly opt into binary sharing. Secrets, generated directories and symlinks stay excluded. Binary files transfer as whole-file replacements and do not merge as text.
- **Transfers:** independent file documents, encrypted blocks and 128 KB resumable chunks replace whole-project downloads. Restart an interrupted receiver and verify it reuses saved chunks.
- **Recovery:** the failure-only fallback publishes an encrypted multipart index last and keeps the preceding bank intact during an interrupted upload. It retains current project content; historical timeline versions remain local. Existing service quotas (64 slots, 128 MB per room) apply across devices and parts, so they can limit large-room cloud recovery. A refused save is reported.
- **Compatibility:** existing rooms continue to use their original protocol. Start a separate new-format test room to exercise these features and issue new invitations to every tester.

Measured locally in an isolated encrypted peer test: 2,000 files / 4,150,890 bytes initialized in approximately 0.9 seconds and first synchronized in approximately 51 seconds; one subsequent file edit transferred 500 bytes and arrived in approximately 69 ms. This is a local test, not a WAN or large-team performance guarantee. Windows interactive and separate-device testing remain for beta testers.

Only the four Windows/Linux beta packages are attached to this release. The matching implementation source is now published in this repository.

## Run from WSL

Use Linux Node.js 22.12+ and npm in this folder, not Windows npm against WSL.

~~~bash
npm ci
npm start
~~~

Desktop startup requires WSLg or a graphical Linux desktop. The first desktop build downloads the checksum-pinned VSCodium engine.

Open/create a project folder, choose Relay: Invite Teammate, and share the complete private relay://workspace-v2/â€¦#key=â€¦ invitation. Existing workspace invitations remain compatible with their original protocol; use Relay: Migrate to Peer Workspace to create a new-format room while retaining the old cache. Teammates choose Relay: Join Shared Workspace and an empty folder.

To migrate an existing local cloud workspace, run Relay: Migrate to Peer Workspace. This creates a new invite from local source and does not delete old cloud data. Download newer cloud-only source using the old app before migration. Old HTTPS invites are not automatically connected.

## Late joining and availability

Every initialized peer stores a local replica. A late joiner can receive the latest edits from any online peer that received them, even after the original author leaves.

Without cloud recovery, if every device holding an edit is powered off, that edit becomes available only when one returns. With recovery enabled, a joiner can recover the last successfully uploaded copy. The status bar distinguishes local saves from copies acknowledged by peers. An acknowledgement means receipt at that time, not a promise that a peer stays online.

Keep a trusted local device seeding without the editor:

~~~bash
npm run seed -- /path/to/private-replica
~~~

Paste the invite at the first-use prompt. The process keeps an encrypted local replica available while running; it does not start an HTTP project-storage service. Its directory also stores the private invitation and must remain private. Stopping the process or device makes its copy unavailable.

## Security and limits

Noise encrypts peer streams; an invite-capability proof bound to the encrypted handshake gates project access. Random 256-bit invite secrets derive discovery topics. Local CRDT caches use authenticated encryption, atomic replacement, and a disk flush before acknowledging changes.

Shared paths are confined to the project. Credential files/directories, metadata, dependencies, generated folders, symlinks, and Windows reserved names are excluded. Incoming state, message sizes/rates, and Windows filename collisions are validated.

New beta workspaces: 10,000 files, 16 MB current content, 2 MB per text/binary file, 8 MB history per file and 32 MB aggregate CRDT history. Existing invites retain the previous 1 MB protocol. Terminal commands remain local. Production Workspace Trust stays enabled.

Anyone with an invite is a writer. Names are self-declared. New workspaces retain up to 200 complete local change versions and 20 named checkpoints, bounded to 128 MB of historical blocks; oldest versions expire when the bound is reached. Existing workspaces retain preview history. These are not verified audit evidence. To rotate a leaked invite, create a new workspace and invite trusted teammates again; previously downloaded copies cannot be erased.

Project files on disk remain plaintext. Cache encryption is not full-disk encryption. DHT participants see network addresses and discovery metadata. Restrictive networks can prevent connections; zero external network infrastructure, unlimited teams, and always-online availability are not promised.

See [PEER-ARCHITECTURE.md](PEER-ARCHITECTURE.md) and [RECOVERY.md](RECOVERY.md).

## Enable the fallback

Run Relay: Enable Encrypted Recovery after inviting/joining a workspace. Enter the deployed Supabase recovery URL and the owner setup code when provisioning a new room. Share the updated invitation with teammates; previous peer-only invitations remain peer-only until explicitly enabled. The setup code never goes into invitations or packaged executables.

Healthy, acknowledged peers do not trigger project uploads. Each session checks for previous cloud recovery copies on startup, then checks again when fallback is needed. If the newest edit has no peer acknowledgement after the 10-second fallback check, Relay uploads an encrypted recovery snapshot. Local checkpoint failures trigger an immediate attempt. Cloud saves can take time; read the status bar before closing a device.

Failure-only recovery cannot recover edits that never reached any durable copy. If local storage, peers, and cloud all fail, keep the editor open until a save is confirmed.

## Verify and package

~~~bash
npm test
npm run build:desktop
npm run test:engine
npm run package:linux
~~~

A headless Linux environment needs Xvfb. Final Windows verification requires Windows Node.js and a Windows checkout:

~~~powershell
npm ci
npm run package:win
~~~

Peer networking includes native dependencies. Build each platform with its own dependency installation; do not reuse Linux node_modules on Windows.

Open VSX and compatible VSIX extensions remain supported. Some Microsoft-exclusive extensions have restrictions.

## Rollback

Verified backup: .backups/20261003T065836Z/. It contains source plus Git history, eight existing installer/package files, and a checksum manifest. Extract its source archive into a separate folder; preserve current work before restoring.

The old deployment was not remotely changed. Cloud code and deployment configuration now live under legacy/. Explicit npm run server:legacy uses the former cloud architecture. It is not shipped in the 0.3 desktop package. The browser companion is legacy and cannot join native peer invites.

Existing Relay/upstream licensing remains applicable. The collaboration extension is MIT-licensed. Peer dependency packages retain their notices in the VSIX.
