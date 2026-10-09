# Relay

**A desktop coding editor where your teammates’ changes reach you live.**

Open a project, invite your team, and work together in the same source files. When someone fixes a bug, connected teammates receive the change without waiting for a Git push and pull. Relay’s activity feed shows who changed a file and lets you review its before-and-after contents.

Relay 0.2.0 runs the full **Code-OSS editor engine through VSCodium**, with Relay collaboration built in as a native extension.

[Download](#download-and-install) · [Start collaborating](#your-first-shared-project) · [Run from source](#run-from-source) · [Build packages](#build-installers) · [Troubleshooting](#troubleshooting)

## What you can do

| Feature | How it works |
| --- | --- |
| Real project folders | Open existing code or create a new folder, then work in the native Explorer. |
| Live collaboration | Source edits merge through Yjs and WebSockets, with cached offline changes and reconnection. |
| Team presence | See connected teammates and the files they are viewing. |
| Change review | Open read-only before-and-after comparisons from Live Changes. |
| Integrated terminal | Run a local shell in your project folder. |
| Extensions | Install compatible extensions from Open VSX or a local VSIX package. |
| Git tools | Use the engine’s Git interface with Git installed locally. |
| Browser companion | Teammates can open an invite in a browser; desktop users get the full editor engine. |
| Previous workspaces | Import saved classic Relay workspaces into real folders. |

Live synchronization handles shared working files. Git remains useful for commits, branches, backups, and releasing your project.

## Download and install

You do **not** need Node.js to use a packaged desktop download.

The verified **0.2.0** packages are available from this [successful build](https://github.com/TMystic/relay/actions/runs/37042609246):

| Platform | Download | Files inside the ZIP |
| --- | --- | --- |
| Windows x64 | [Windows packages](https://github.com/TMystic/relay/actions/runs/37042609246/artifacts/11243430314) | `Relay-Setup-0.2.0-x64.exe` and `Relay-Portable-0.2.0-x64.exe` |
| Debian / Ubuntu amd64 | [Linux package](https://github.com/TMystic/relay/actions/runs/37042609246/artifacts/11242854601) | `Relay-0.2.0-amd64.deb` |

GitHub Actions artifact downloads require signing in to GitHub. These artifacts are retained for 30 days, through approximately **November 1, 2026**. If a link has expired, open [Actions](https://github.com/TMystic/relay/actions), select a newer successful **Build downloadable packages** run, and download its matching artifact—or build from source below.

### Windows

1. Download and extract the Windows ZIP.
2. Open `Relay-Setup-0.2.0-x64.exe`.
3. Choose the installation location and complete the installer.
4. Launch **Relay** from the Start menu or desktop shortcut.

Choose the **installer** for a regular installed app with shortcuts and an uninstall entry. Choose `Relay-Portable-0.2.0-x64.exe` to launch without running the installer; editor settings and workspace state still use local user storage.

Relay’s Windows packages are unsigned, so Windows may show an unrecognized-app warning.

### Debian / Ubuntu

Download and extract the Linux ZIP. From the folder containing the package, run:

```bash
sudo apt install ./Relay-0.2.0-amd64.deb
```

Then open **Relay** from Applications, or run:

```bash
relay
```

Use a graphical Linux desktop or WSLg. Language tools such as Python, Node.js, compilers, and Git are installed separately on your computer.

### Upgrade from an older Relay version

Close Relay before installing the new package. Version 0.2.0 opens the full editor interface. To bring in code saved in the older desktop workbench, open the Command Palette and run **Relay: Import Previous Relay Workspace**, then select an empty destination folder. The original workspace data is retained.

Desktop updates currently use a new installer; automatic updates are not implemented.

## Your first shared project

### Create or open a project

1. Launch Relay.
2. Select **File → Open Folder** for an existing project.
3. For a new project, open the **Relay** sidebar and click **Create Folder**, or run **Relay: Create Project Folder** from the Command Palette.
4. Create and edit files through the Explorer.

The Command Palette opens with **Ctrl+Shift+P**. Relay commands begin with `Relay:`.

### Invite teammates

1. Open the project folder you want to share.
2. In the Relay sidebar, click **Invite Teammate**, or run **Relay: Invite Teammate**.
3. Enter your display name.
4. Review and accept the source-file sharing prompt.
5. Send the copied invite link to your teammates.

The default collaboration service is [relay-bf93.onrender.com](https://relay-bf93.onrender.com). Teammates can connect from different networks. Its free hosting may take about a minute to wake after being idle.

### Join a shared project

**Desktop:** run **Relay: Join Shared Workspace**, paste the complete invite, enter your name, and choose an **empty local folder**. Relay opens that folder and downloads the shared source into it.

**Browser:** open the invite link and enter your name. The browser companion provides the earlier collaborative workbench; local folders, native extensions, and the terminal belong to the desktop app.

Open the same file on two clients and edit it. Changes should reach both clients without a manual refresh. Use **Team** for presence and **Live Changes** to review edits.

### Run code and add extensions

- **Terminal → New Terminal** opens a shell in the project folder. You can also run **Relay: Open Terminal**.
- **Ctrl+Shift+X** opens Extensions. Search Open VSX and choose **Install**.
- For a compatible downloaded extension, run **Extensions: Install from VSIX**.
- Install the project’s language runtimes and dependencies locally before running it.

Terminals and installed extensions are local to each computer. Collaboration does not let teammates execute commands in another person’s terminal.

## Sharing limits and storage

The current collaboration preview supports **1,000 source files**, **1 MB of UTF-8 text in total**, and **512 KB per file**. Dependency and generated directories, Git/editor metadata, environment files, binary files, and symlinks are excluded from source sharing.

Invite links are bearer credentials: **anyone holding an invite can edit that workspace**. Display names are self-declared. Verified accounts, roles, and invite revocation are not implemented.

Invites use the editor’s SecretStorage API. Cached collaboration state is stored in the extension’s local storage, and saved projects reconnect when reopened. The hosted service uses durable workspace storage. Shared file deletions use the local trash when the file provider supports it.

Keep normal project backups and Git history. This is a collaboration preview, with no unlimited-team or large-project guarantee.

## Extension compatibility

Relay uses the real VS Code extension API through its Code-OSS engine. It supports **compatible Open VSX and VSIX extensions**, including third-party extensions verified in the native engine.

Not every VS Code extension is available or compatible. Microsoft Marketplace access and some proprietary Microsoft extensions are restricted to Microsoft’s products. Extension API versions, dependencies, platform support, and required language tools still apply.

See the [VSCodium documentation](https://vscodium.com/) and [Microsoft FAQ](https://code.visualstudio.com/Docs/supporting/faq) for upstream details.

## Run from source

Requires **Git**, **Node.js 22**, npm, an internet connection for the initial engine download, and a graphical desktop.

```bash
git clone https://github.com/TMystic/relay.git
cd relay
npm ci
npm start
```

The first desktop build downloads the pinned official VSCodium engine, verifies its SHA-256 checksum, and bundles the Relay extension. Later starts reuse the prepared engine.

To update an existing checkout:

```bash
git pull
npm ci
npm start
```

Install dependencies separately on Windows and Linux; do not copy `node_modules` between operating systems.

### Browser companion

```bash
npm run build
npm run server
```

Open **http://localhost:4317**. This starts the local browser/server companion, rather than the full desktop editor. A localhost invite is reachable only on the hosting computer.

To open the classic desktop workbench:

```bash
npm run start:classic
```

For server configuration and hosting, see [HOSTING-0.2.md](HOSTING-0.2.md). The desktop server address is configurable through the `relay.serverUrl` setting. Keep private storage credentials on the server.

## Build installers

Build each package on its target operating system after `npm ci`:

| Platform | Command | Output |
| --- | --- | --- |
| Windows x64 | `npm run package:win` | Installer and portable executables in `release/` |
| Debian / Ubuntu amd64 | `npm run package:linux` | Debian package in `release/` |

The [packaging workflow](.github/workflows/packages.yml) builds both platforms on pushes to `main` and can be started manually through Actions. Version tags matching `package.json`, such as `v0.2.0`, create a **draft** release with package attachments after successful builds.

Engine binaries, generated packages, dependencies, and private workspace data are excluded from Git. Source builds reproduce the downloads without checking large runtime binaries into the repository.

## Verification

```bash
npm test
npm run build:desktop
npm run test:engine
```

On a headless Linux machine, use `xvfb-run -a npm run test:engine` with the engine’s sandbox configured as shown in the packaging workflow.

The [verified build](https://github.com/TMystic/relay/actions/runs/37042609246) passed Windows and Linux packaging, protocol/storage tests, and real Linux extension-host checks for folder creation, edits in both directions, file watching, a terminal shell process, and a third-party extension.

See [VERIFICATION.md](VERIFICATION.md) for test evidence and environment limits. Native Windows graphical launch could not be tested in the build environment; desktop operation was subsequently reported working by the project owner.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Connecting takes a while | Allow the free hosted server time to wake. Check your connection and the full invite link. |
| An invite contains `127.0.0.1` or `localhost` | That address points to the recipient’s own computer. Use the public invite created by the current desktop Relay extension for internet collaboration. |
| Join refuses a folder | Choose an empty destination folder. Open an existing project with **File → Open Folder** instead. |
| Relay commands are unavailable | Check Workspace Trust and that **Relay Collaboration** is enabled. Trust projects you recognize. |
| An extension cannot be found | Search Open VSX, or install a compatible VSIX. Microsoft-only extensions may be unavailable. |
| A terminal command is missing | Install its runtime/tool locally; Relay provides the shell, not every compiler or interpreter. |
| Files are missing from the shared project | Check the source-sharing exclusions and size limits. Dependencies and binary files are not shared. |
| An old workspace does not appear | Run **Relay: Import Previous Relay Workspace** from the desktop app. |

## Repository map

```text
electron/       Desktop launcher and classic shell
extension/      Native Relay collaboration extension and engine tests
scripts/        Engine download, VSIX bundling, and native verification
server/         Room protocol, persistence, and invite publishing
src/            Browser companion interface
tests/          Collaboration, storage, and project-file tests
.github/        Windows/Linux packaging workflow
```

## Project status and licenses

Relay is a working collaboration preview. Accounts and role permissions, invite revocation, automatic desktop updates, and large-team load guarantees remain future work.

The editor engine comes from [VSCodium](https://vscodium.com/), built from Microsoft’s Code-OSS sources. Upstream licenses and notices are retained in the bundled runtime. The [Relay Collaboration extension](extension/LICENSE) is MIT-licensed with dependency notices. The root application currently declares `UNLICENSED`; do not assume the entire repository has the extension’s MIT license.

For more details, read [FULL-EDITOR.md](FULL-EDITOR.md), [HOSTING-0.2.md](HOSTING-0.2.md), and [VERIFICATION.md](VERIFICATION.md).
