# Encrypted Supabase recovery

The primary copy remains local and replicated over peer connections. Recovery uploads occur on a local checkpoint failure or when the current edit has no acknowledged peer copy at the 10-second check. Startup reads reconcile prior cloud-only edits. No recovery URL means the original peer-only behavior.

## This workspace

The recovery function is deployed in the existing Relay Supabase project:
https://xpmgudpoeaggadfaarct.supabase.co/functions/v1/relay-recovery

The URL is prefilled by the Enable Encrypted Recovery command. Your owner setup code is in .tools/recovery-owner-code.txt (POSIX owner-only permissions); copy it into the password prompt. Do not share this code with teammates or place it in project source. A recovery-enabled invitation is sufficient for teammates.

A new project named Superbase recovery could not be created because the account's two-project free limit was reached; the user authorized the existing Relay project instead.

## Deployment

Apply supabase/recovery-schema.sql as the database owner in the chosen Supabase project, then deploy supabase/functions/relay-recovery with verify_jwt=false: it implements custom room-capability authentication. The standard SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY function environment variables must exist. Never put the service-role key in the desktop, invitation or source.

Generate an owner-only random 32-byte setup code. Store only its SHA-256 hex digest in relay_recovery.settings(id=1,setup_hash). Keep the code private outside shared source. This authorizes new room provisioning; teammates use the per-room capability derived from their invite, not this code.

In the editor choose Relay: Enable Encrypted Recovery, enter https://PROJECT.supabase.co/functions/v1/relay-recovery, and supply the owner setup code for a new room. Share the updated invitation. Joined peers can enable already-provisioned rooms without the owner setup code. Existing peer-only invites continue to work without cloud recovery.

## Test

Use a separate test project. With two peers confirming replication, cloud copies should not change. Close one peer, edit on the remaining device, and wait for the encrypted recovery confirmation. Close all peers; join from a third device using the recovery-enabled invite and verify the uploaded source.

Make independent offline edits from two initialized devices; upload both, then reconnect and verify merging. Exercise disk-full/read-only local storage and check that a remote acknowledgement is delayed until a durable store succeeds. If both stores fail, keep the editor open and confirm that the status says the change is not safely saved.

If the CRDT cache is corrupt/missing, existing source is preserved under .relay/recovery-source-TIMESTAMP before recovery. Review those files after recovery. A failure to preserve existing files stops recovery to avoid overwriting newer source.

## Limits

The service stores encrypted source/history, not complete system backups or binary assets. It does not repair syntax or logical merge conflicts. A cloud outage, capacity limit, lost invite token or edit lost before upload can prevent recovery. Failure-only is not a continuous backup.

Turning fallback off retains cloud copies and old invitations. Owner access through Supabase is required for deletion or setup-code rotation. Setup-code rotation prevents new room provisioning; it does not revoke existing room capabilities.
