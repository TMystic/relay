# Relay 0.4.5 beta verification — 2026-10-09

The matching implementation source is published with the four beta packages. Monitoring was stopped at the user's request. The user's running Windows editor and live project were left untouched; changes take effect after the tested update is installed.

- 54 automated tests passed with no skipped or cancelled tests.
- 33 checks passed in an isolated native Linux editor using the newly bundled extension. Ordinary local type errors stayed outside Code Checks; teammate function activity and overlap notices remained visible.
- Actual disk rewrites of dirty Java editor buffers reached the editor and a connected peer without restart. Concurrent native typing and an external rewrite preserved both edits on both peers.
- Isolated regressions covered missing saved ancestry, temporary symlink collisions, outside hard-link aliases, durable write failure, executable-mode preservation on supported platforms, and internal temporary-file exclusions.
- Dependency audit reported zero known vulnerabilities across 395 dependencies.
- The earlier rapid-typing, transfer, encrypted recovery, timeline and stress evidence below remains historical coverage; live cloud checks and expensive stress runs were not repeated without a new failure.

All four installer payloads match the native-tested extension. Windows Setup and Portable embed identical application archives; Linux AppImage and Debian metadata are verified. Both packaged launchers match the source and beta metadata. Actual Windows and Linux editor runtimes passed rapid typing, concurrent edits, batching, encrypted restart, mixed line endings, Unicode offsets, binary writes, outside hard-link isolation, disk-full preservation, and occupied temporary-name rejection. Native UI checks in this pass ran on Linux; interactive Windows installation, physical-device networking, the prior WSL crash investigation, and independent security review remain open beta gates. These results do not certify production readiness.

## Final 0.4.5 beta packages

[Release and downloads](https://github.com/TMystic/relay/releases/tag/beta-0.4.5). The embedded tested extension SHA-256 is b591723d2dfc20e5ec5ff0f3d3e065380f69d53ecd8efa0d8ed2faa9137fbd73. Private recovery capability scanning passed for the source tree and extension archive.

| Package | SHA-256 |
| --- | --- |
| Relay-Beta-Tester-Setup-0.4.5-beta.1-x64.exe | 191ba16d53e1303a8710c18f5ccb3c1e463d4b11ebbfae96c5cc2de6d89c0bf6 |
| Relay-Beta-Tester-Portable-0.4.5-beta.1-x64.exe | 1dace463d2e78345dda0fe87802483fb4c7474bc1683027178b2cd5d2be3e401 |
| Relay-Beta-Tester-0.4.5-beta.1-x86_64.AppImage | 52df302303b3a4b5140a550d3a344b01aee7f4b8194b0ffe0ba03afa3ebe725c |
| Relay-Beta-Tester-0.4.5-beta.1-amd64.deb | afd1cde9e66ded86e370c005889ee48a07c349997da7b537e9f4834e39231dee |

---

# Relay 0.4.4 regression verification — 2026-10-07

This campaign tested the final WSL source, the installed collaboration VSIX in the native Linux editor, and packaged collaboration code under the actual Windows and Linux editor runtimes. This historical campaign preceded source publication with the 0.4.5 beta. The source backup and prior beta installers are retained.

## Result

- All 43 automated scenarios passed with no skipped or cancelled tests.
- All 28 installed native-editor checks passed in two consecutive final runs, including replacements after invisible shared rewrites.
- 6,000 seeded editing operations across four independent projections in both collaboration protocols passed against a separate string model. Duplicate and reordered updates converged against a separate Yjs reference document.
- Six real encrypted peers survived 240 concurrent editing batches, retained every unique edit exactly once, and served a late joiner after two original devices closed.
- Live encrypted recovery passed six checks against an isolated synthetic room. Its copies and room were deleted afterward; SQL confirmed both counts were zero.
- Packaged native networking dependencies loaded under Windows and Linux VSCodium Node 24.18.1. Both runtimes passed rapid typing, coalesced writes, concurrent inserts, encrypted restart, mixed line endings, and Unicode offset checks.
- Full dependency audit: zero reported known vulnerabilities across production and development dependencies. The retained browser build and source syntax/whitespace checks passed.

## Defects reproduced and fixed

| Failure | Regression and fix |
| --- | --- |
| A checkpoint inside the 32 ms typing window omitted final keystrokes | Native reproduction failed before the fix. Checkpoint, proposal generation, and proposal application now flush pending editor edits. |
| Restore guards inspected stale state while newer local typing was pending | Native restore review now rejects the pending newer version and preserves it. |
| CRLF native documents repeatedly echoed LF teammate updates | Native test reproduced incoming-line duplication. Native offsets and line endings now map onto original shared character identities; the incoming line appears once. Changing editor line endings also passes. |
| Typing through an open symlink could publish outside source | Native edit and flush paths now check safe targets. The native test types through a synthetic symlink and confirms no shared file is created. |
| Rapid multi-peer updates invalidated advertised immutable file versions | Six-peer stress reproduced Unknown file transfer errors. Advertised references stay available during transfers within a bounded retention budget. Small merged updates propagate per file. |
| Concatenated frames started later work before asynchronous durable receive finished | A deferred-write test failed before the fix. Receives now process in order; waiting input counts toward per-peer and aggregate memory limits. |
| Base64 length allowed binary content slightly over 2 MB | Exact decoded-size regression failed before the fix. Validation now checks actual bytes. |
| Incoming peer files overwrote excluded local paths | Native reproduction overwrote a synthetic private note. Incoming writes, removals, and code checks now respect local exclusions. |
| The next edit after an invisible rewrite retained old text | A native test reproduced the issue inside the affected range after CRLF/LF normalization. The editor now adopts current shared character identities even when rendered text looks unchanged. Identical visible rewrites and peer-chain forwarding also pass. |
| Background file downloads temporarily disabled existing-file edits | A held-binary native test reproduced dropped typing in an already verified Java file. Loaded files remain editable; large updates wait for complete offers. Readiness and peer acknowledgements wait for all files, and initial complete replicas announce their saved state. |

Additional hardening rejects negative editor ranges before mutation, suppresses redundant writes for identical already-durable updates, cleans interrupted transfer state, and uses unique exclusive temporary files for atomic cache writes. Launcher metadata and source are checked independently; native networking dependencies are checked in the collaboration extension.

## Coverage

Editor: real keystrokes during rejected teammate edits, continuous Java typing, backspace, paste, multi-cursor edits, local undo/redo, unsaved buffers, final edits at disconnect, typing while new binary files download, pending checkpoint and restore guards, CRLF/LF and Unicode, persistent apply failure with later recovery, Live Changes counts and review diffs, TypeScript diagnostics, same-function warnings, deleted-file diagnostic cleanup, folder creation, terminal process and third-party extension loading.

Peer and filesystem: both invitation protocols, authentication failures, simultaneous and offline edits, late join, encrypted restart including empty projects, text and binary synchronization, exact file/project limits, 10,000-file manifest boundary, Unicode/case filename collisions, traversal and credential-path rejection, symlink and nested-symlink isolation, selective globs, interrupted/resumed transfers, pinned historical offers, storage failures with no premature ACK, damaged/missing caches and blocks, truncation, authenticated decompression limits, malformed JSON, invalid frame sizes, 240-message flood boundary, 32-peer admission limit, and 48 MB aggregate frame buffering.

Recovery: healthy-peer failure-only behavior, disk-full fallback, both storage layers failing, cloud acknowledgement timing, multipart interruption preserving the previous bank, offline merge, deletion during asynchronous persistence, wrong capability, malicious documents, malformed and streamed oversized requests, generic database error responses, and no-store successful responses.

Retained legacy fixtures also run. Their passing status does not imply the old cloud backend is used by the beta.

## Measured performance

These are synthetic peers on one WSL machine, not independent devices or a WAN.

| Workload | Final run |
| --- | --- |
| Initial 2,000-file / 4,150,890-byte project | 54,552 ms |
| One-file update after initial sync | 59 ms; 548 application message bytes |
| Six-peer burst | 240 batches; 20 subsequent latency samples |
| Six-peer latency | p50 74 ms; p95 1,172 ms |
| Six-peer observed process RSS change | +6 MiB in this run; allocator and prior test activity affect this number |

Six-peer tail latency and initial sync duration remain optimization targets. No larger-team capacity or instantaneous WAN performance claim is supported.

## Recovery access controls

Read-only SQL verified all three private recovery tables have RLS enabled. The anon and authenticated roles lack schema usage, table access, and RPC execution; service_role can execute the recovery RPC. The security advisor returned INFO-only [RLS enabled without policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) on these default-deny tables and the retained legacy table. No schema changes were made.

## Production release gates still open

- Triage the observed local Relay/WSL editor crash diagnostic. Its cause is not established by these passing regression checks.
- Interactive Windows installation, uninstall/upgrade behavior, and editing between two physical computers.
- Real internet/NAT/relay reachability, packet loss and latency across networks.
- Sustained multi-hour sessions, power-loss filesystem testing, and representative larger-team workloads.
- Collaboration-aware undo when local and remote edits interleave, and broader language-server/extension compatibility.
- Interactive repair-review dialogs, complete Git branch/commit/PR flows, and cache locking across multiple editor windows.
- Independent security review, capability rotation/revocation and participant permissions, release signing, and an update strategy.
- Text merging can yield logically incorrect code. Language diagnostics and review suggestions do not prove program correctness.
- Failure-only recovery protects the last successfully uploaded copy; it cannot guarantee newest unuploaded edits survive loss of the last device. Working source files remain plaintext on disk.

Passing this campaign makes the beta better verified. It does not certify production readiness or guarantee absence of defects.

## Evidence

Local logs remain in .tools/regression-0.4.4-final-suite.log, regression-0.4.4-native-1.log, regression-0.4.4-native-2.log, regression-native-repeat-2.log, regression-stress.log, regression-sharing-red.log, regression-native-expanded.log, regression-durable-order-red.log, regression-0.4.4-live-recovery.log, regression-audit.json, and regression-0.4.4-runtime-{linux,win32}.json. Isolated fixtures do not inspect or modify the user's open project.

Installer payload verification compares embedded VSIX hashes against the tested extension; launcher checks verify beta metadata and source matching. Final asset hashes are recorded with the beta release.

Original source/installer backups remain, including .backups/beta-0.4.2-source/source.tar.gz. The regression source snapshot is .backups/regression-0.4.4-source/source.tar.gz.

The preceding 0.4.3 beta remains available with a known-issue note. Use 0.4.4 for the invisible-rewrite fix.

## Packaging environment

Windows packaging initially failed because the system drive was full. A 4.98 GB Relay/WSL crash diagnostic was preserved in a separate verified backup before its temporary duplicate was removed. Source backups and prior installers were retained. The diagnostic still requires investigation before production approval.

## Published beta

[Relay Beta Tester 0.4.4-beta.1](https://github.com/TMystic/relay/releases/tag/beta-0.4.4) contains four verified Windows/Linux packages. GitHub asset digests matched local SHA-256 values. README-only commit: 1731a1043c16de50a62d8fd8deed85c59f6a4c21. No source implementation files were published. The embedded tested extension SHA-256 is ffb55a133383b9c2ae9e6ada47c200ed21bdb840c77c21d1aee70e7d4608cec4.
