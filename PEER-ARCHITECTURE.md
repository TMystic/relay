# Peer backend architecture

The editor extension maintains one Yjs document per workspace and sends incremental changes over Hyperswarm/HyperDHT Noise streams. A random 256-bit workspace capability derives the discovery topic and an HMAC proof over a random challenge plus the Noise handshake hash. No source is sent before capability authentication.

Each initialized peer stores a full CRDT replica. Reconnection merges state rather than selecting timestamps or replacing another participant's work. An optional local seed process maintains a replica while the editor is closed. There is no authoritative project database. Optional Supabase recovery retains one encrypted CRDT snapshot per device, with independent versions and compare-and-swap updates.

## Infrastructure and availability

Discovery uses the public DHT by default. Bootstrap/routing nodes participate in networking and can observe addresses/discovery metadata. Hyperswarm may use network routing assistance; end-to-end encryption protects project traffic. The design does not guarantee every connection takes a direct route or succeeds behind every NAT.

No reachable device holding a change means no download until a holder returns. Acknowledgements prove receipt only at that time. A participant with the invite can dishonestly acknowledge or discard its copy. Empty joining peers cannot become initialized by restarting.

## Local recovery

AES-256-GCM encrypts the cache with a domain-separated capability-derived key. Cache writes use temporary files, fsync, and replacement before remote acknowledgement. The editor invite lives in SecretStorage. Hashes of the last materialized files distinguish newer cached edits from stale disk contents after a crash.

The seed CLI stores an owner-only invitation file beside its encrypted cache. On Windows protect the directory with an ACL; POSIX modes do not provide Windows ACL protection. Source files remain plaintext, and secrets embedded in ordinary source cannot be automatically detected.

## Security boundaries

Invites grant shared-source write access. This version does not implement signed member enrollment, per-person roles, or cryptographic revocation. Noise authenticates a connection key, not a human identity. Names and inherited activity records are self-declared; reviews are bounded previews rather than signed audit records.

Validate incoming changes on a temporary Yjs document before persisting/applying. Limit source size, file size/count, CRDT state, frame size, peer count, authentication time, and message rate. Reject unsafe paths, symlinks, credential paths, Windows reserved names, and case-insensitive filename collisions. An authorized writer can still consume decoding resources; parsing runs inside the extension process.

Transport never executes remote terminal commands. Shared code, package scripts, and installed extensions remain untrusted until the user elects to run them under Workspace Trust. Creating a new invitation cannot erase previously shared copies.

## Migration

Migration uses current local source to create a new peer workspace. Obtain newer cloud-only source through the old version first. The old Render/Supabase services were not modified or deleted. Rollback source, Git history, installers, and checksums are in .backups/20261003T065836Z/.

## Verification

Tests use real Noise connections and isolated HyperDHT routing nodes. Coverage includes simultaneous edits, late joining after the original peer closes, all-offline waiting, restart and offline convergence, actual failed capability authentication, cache integrity, unsafe/oversized state, and checkpoint failure without acknowledgement or mutation.

Native editor fixtures test the actual extension host, document updates, real file creation, terminal startup, and a third-party extension. Public-network reachability and final Windows UI behavior need separate device testing.

## Failure-only cloud recovery (0.3.1)

Local checkpointing is attempted first. A failed checkpoint retains local edits in memory and starts encrypted recovery asynchronously. Incoming remote edits remain staged and unacknowledged until either the local checkpoint or cloud write succeeds. If local edits occur during an upload, the staged merge is revalidated and saved with the newer edits before acknowledgement.

A 10-second check invokes recovery when uninitialized, local storage has failed, or no authenticated peer has acknowledged the current sequence. A startup read reconciles previous cloud-only edits even when peers are healthy; it does not upload healthy replicated source. Losing the last holder before this check/upload completes can still lose the edit.

Cloud encryption uses AES-256-GCM with a separate capability-derived key and a room-bound associated-data value. The service sees a separately derived bearer capability, hashed authorization credentials, room/device IDs, timing and ciphertext size; it does not receive the invitation token or plaintext source. Owner-only setup authorization is required to create recovery rooms. Anyone holding a recovery invite has read/write recovery access.

Each device slot is merged with its previous snapshot before CAS replacement. All slots are merged with Yjs on recovery, never selected by newest wall-clock timestamp. The service refuses capacity overflow rather than evicting the last copy silently. Bounds: 100 rooms, 64 device slots/room, 128 MiB encoded ciphertext/room, 512 MiB total, 1,000 authenticated operations/room/minute. Desktop cloud writes are serialized, coalesced and throttled.

The server-only service key is confined to the Supabase function environment. Recovery tables live in a private schema with RLS enabled, no anon/authenticated table grants, and no public RPC execution. A custom room capability is verified before every operation, so the function disables the unrelated Supabase user-JWT gateway check.

Unreadable/missing local CRDT caches trigger preservation of current shared source under the project's ignored .relay directory before cloud materialization. If that rescue write cannot succeed, recovery stops instead of overwriting potentially newer source. Compare preserved files after recovery; independent source files do not retain CRDT ancestry.

Disabling fallback stops cloud use on this device; it does not delete existing cloud copies or revoke old invitations. Rotating compromised invites requires a new room. Recovery needs a configured live service and a valid updated invitation.
