# Relay Peer Collaboration

Encrypted peer-to-peer source synchronization inside the full Code-OSS editor. Open a folder and choose Relay: Invite Teammate. Teammates paste the complete private relay:// invite into Relay: Join Shared Workspace and choose an empty folder.

Invitations grant editing access and do not work in the legacy browser companion. Without recovery, a device holding the latest edits must remain online for a late joiner to download them. Offline changes and encrypted local caches merge when peers reconnect.

Team shows connected peer key fingerprints with self-declared names. Live Changes contains bounded before/after review previews, not a signed audit log.

Sharing excludes credential paths, metadata, generated dependencies, binaries, symlinks, and Windows reserved names. Limits are 1,000 files, 1 MB source, 512 KB per file, and 8 MB CRDT state. Terminals execute locally. Workspace Trust remains enabled.

Old cloud workspaces require explicit Relay: Migrate to Peer Workspace. Download cloud-only changes with the old app before migration. Supabase is an optional encrypted failure-only recovery layer; Render is not used. Run Relay: Enable Encrypted Recovery and share the updated invitation.

The full editor supports compatible Open VSX and VSIX extensions; Microsoft-exclusive extensions may have restrictions.
