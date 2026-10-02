# Relay 0.2 — full desktop editor

The desktop app now runs a full Code-OSS editor engine from the official VSCodium distribution. It includes the native project explorer, file/folder operations, integrated local terminals, language services, Git interface and extension host. Relay collaboration is bundled as a real VS Code API extension. The classic browser companion remains available for invite links.

## Work on a project

- Use **File → Open Folder** or **Relay: Open Project Folder** to select a real folder.
- In the Relay activity bar, choose **Create Folder**, or run **Relay: Create Project Folder** from the Command Palette.
- Open a shell with **Terminal → New Terminal**, or **Relay: Open Terminal**. Commands run locally in your project; teammates cannot execute commands in your terminal.
- Use the Extensions activity bar (Ctrl+Shift+X) to browse Open VSX. To install a compatible downloaded package, use **Extensions: Install from VSIX**.
- Open the Relay activity bar to invite or join teammates and review Live Changes.

The engine supports compatible VS Code extensions. It does not promise every extension: Microsoft Marketplace access and some proprietary Microsoft extensions are restricted to Microsoft's products. Relay uses Open VSX, the distribution's configured registry. Extension dependencies, native runtimes and API-version requirements still apply. [Microsoft FAQ](https://code.visualstudio.com/Docs/supporting/faq), [VSCodium](https://vscodium.com/).

## Share and join

Open your project, run **Relay: Invite Teammate**, enter your name, and review the source-file sharing prompt. The public invite is copied to your clipboard. Edits synchronize with the same Relay cloud service used by previous versions. Team and Live Changes show presence and before/after reviews.

Joining requires a full invite and an empty local destination folder. Relay downloads source into that folder and opens it in the editor. Existing unrelated files are never overwritten during a join. Saved workspaces reconnect when the same folder reopens. Tokens use the editor's SecretStorage API; incremental collaboration state is cached in the extension's private storage.

The preview shares up to 1 MB of UTF-8 source across 1,000 files, with a 512 KB limit per file. Dependency/generated directories, Git/editor metadata, `.env` files, binaries and symlinks are excluded. Installed extensions, terminal sessions and machine-specific settings are local. Shared file deletions use the local trash where the file provider supports it. Workspace Trust remains enabled in the delivered app. Review unfamiliar projects before trusting them or running commands.

## Previous Relay workspaces

Run **Relay: Import Previous Relay Workspace**, select a saved room and an empty folder. Local source is copied into that folder. If the room was already shared online, the saved online invitation is reused. Otherwise invite again from the imported folder. Existing local room files are retained in the old Relay data directory. Launch the app with `--classic` to use the previous workbench when needed.

## Build

`npm ci`, then `npm run start` for the full desktop editor. `npm run package:win` builds installer/portable packages and `npm run package:linux` builds a Debian package. The first desktop build downloads the pinned engine and verifies its SHA-256 checksum. Generated binaries are excluded from Git. `npm run server` runs only the browser/server companion, and `npm run start:classic` opens the original desktop workbench.

`npm test` checks the native collaboration client, simultaneous and cached offline edits, real folder collection and path isolation, sharing, durable storage and the existing browser protocol. `npm run test:engine` runs a real editor extension-host test for folder creation, editing in both directions, file watching, a real shell process and a third-party extension. On Linux run it under `xvfb-run -a`. Its isolated fixture profile disables Workspace Trust only for testing; the production launcher does not.

Upstream engine licenses and notices are retained in the bundled runtime. Relay Collaboration is MIT-licensed with its dependency notices; the previous app's licensing is unchanged.
