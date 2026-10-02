# Relay — collaborative desktop editor

Relay 0.2.0 uses the full Code-OSS engine through VSCodium. It includes real local folders, an integrated terminal, Git tools, language support and compatible Open VSX / VSIX extensions. Relay collaboration is a bundled native extension; the browser companion retains its earlier interface.

Use **File → Open Folder**, or **Relay: Create Folder** from the command palette. Use **Terminal → New Terminal** for a local shell. Install compatible extensions through the Extensions view or **Extensions: Install from VSIX**. Microsoft-exclusive extensions and Marketplace access are not guaranteed.

In the Relay sidebar, select **Invite teammates** to share the current source workspace. Teammates select **Join workspace** and choose an empty local folder. Changes synchronize into that folder. Generated files, dependency folders, binary files and environment files are excluded. Sharing supports up to 1,000 files and 1 MB of text, with 512 KB per file. Invite holders have full editing access; names are self-declared. Terminals run locally and cannot be controlled by remote teammates.

Use **Relay: Import Previous Workspace** to copy older desktop workspaces into a local project folder. Original data is retained.

## Run and build

Requires Node.js 22 and a graphical desktop. Run `npm ci`, then `npm start`. The first build downloads and verifies the pinned upstream engine. Packaged users do not need Node.js.

Windows: `npm run package:win`. Linux: `npm run package:linux`. Packages appear in `release/`: `Relay-Setup-0.2.0-x64.exe`, `Relay-Portable-0.2.0-x64.exe`, and `Relay-0.2.0-x64.deb`. Windows packages are unsigned. Ubuntu: `sudo apt install ./Relay-0.2.0-x64.deb`.

`npm test` checks collaboration and persistence. After `npm run build:desktop`, `npm run test:engine` checks the actual editor extension host, folders, terminal and third-party extensions. Headless Linux: `xvfb-run -a npm run test:engine`. GitHub Actions runs native checks on Linux and builds both platforms.

Browser companion: `npm run build`, then `npm run server` and open http://localhost:4317. `npm run start:classic` opens the previous desktop interface.

See [FULL-EDITOR.md](FULL-EDITOR.md) for migration, storage, server settings and compatibility. Verified identities, role permissions, invite revocation, automatic updates and large-team load guarantees remain future work.
