# Relay networking and recovery

The primary desktop backend is encrypted peer collaboration. No hosted storage is needed for peer-only use.

Optional failure-only cloud recovery uses a Supabase Edge Function and private encrypted recovery tables. See RECOVERY.md for deployment, access controls and limits. Legacy Render/Supabase project tables remain separate and are not modified by this schema.

Old cloud setup remains in legacy/HOSTING-0.2.md for reference.
