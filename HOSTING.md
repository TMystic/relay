# Public collaboration hosting

Relay supports a Render Free Node web service with private durable workspace storage in a dedicated Supabase project. Browser users create a private room; invite links work from other networks and can be pasted into the installed Relay desktop app.

## Deploy this configured project

1. In Render, create a Blueprint from `https://github.com/TMystic/relay` using `render.yaml` on `main`.
2. Keep the `free` service plan. Supply `RELAY_STORAGE_TOKEN` privately in Render's environment form. The template contains the storage endpoint, never the token.
3. After the deployment succeeds, open the Render HTTPS address, enter your name, and create a workspace.
4. Use **Invite teammate**. Teammates open the full link in a browser or paste it into Relay's join dialog. They do not need to run a server.

Storage project: `xpmgudpoeaggadfaarct` (Relay, TMystic's Org). Room data is inaccessible to Supabase anonymous and authenticated clients. The `relay-store` Edge Function authenticates a separate, narrowly scoped server token before reading or saving room snapshots. Its database administration credential remains inside Supabase.

To redeploy the storage function, use `server/relay-store.ts` and configure `RELAY_STORAGE_TOKEN` as a private Edge Function secret; the placeholder deliberately rejects requests. The active deployment uses a privately supplied token. Rotate that token in both the function and Render together. Do not put it in Git, renderer code, URLs, or invite links.

Hosted mode (`RELAY_HOSTED=1`) refuses to start without durable storage and waits for the database to load before serving clients. Saving is coalesced per room and serialized. Acknowledgments follow successful durable writes; live broadcasts can arrive before a save completes. During an outage the interface continues to show unsynced changes. The desktop's existing local storage behavior remains available.

## Free-plan behavior

Render Free services sleep after 15 minutes without inbound activity and can take about a minute to wake. Reconnect or retry while the service wakes. Its filesystem is disposable; workspace snapshots and invite credentials are stored in Supabase instead. Free plans have provider quotas and are suitable for an initial team deployment. Supabase free projects can also pause after inactivity; resume the project in its dashboard if necessary.

Sources: [Render Free](https://render.com/docs/free), [Render WebSockets](https://render.com/docs/websocket), [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase).

Anyone holding an invite has editing access to that room. Relay currently uses invite tokens and self-chosen display names, without user accounts or roles. Do not publish an invite for a private project. Run a single Render service instance; multiple instances would need shared live messaging as well as storage.

## Verification

`npm test` exercises simultaneous edits, access protection, actor history, local restart, hosted creation, a fresh-disk restart, and storage failure acknowledgment behavior. The hosted test can use the real storage service by providing `RELAY_TEST_STORAGE_URL` and `RELAY_TEST_STORAGE_TOKEN` privately. Test rooms created by that test remain in the dedicated database for inspection.
