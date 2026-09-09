# Quiz Make dedicated LINE provider

Prepared identifier: `custom:quizmake-line`.
LINE channel: `2011510017`.
Supabase project: `xqknwsjbvczyexfxlgar`.

The existing `custom:line` provider and all existing identities must remain unchanged.
The dedicated provider is not yet created: its form is prepared in Supabase, pending the owner's client-secret entry and submission.

After creation, verify the provider identifier, enabled state and client ID using a read-only query (never select client_secret). Set GitHub repository variable `VITE_LINE_AUTH_PROVIDER` to `custom:quizmake-line` and redeploy. Until then, the app deliberately retains `custom:line`.

While signed in with the existing email account, use LINE linking before trying a standalone LINE login. Verify that the same Supabase user now owns a `custom:quizmake-line` identity. Do not delete, move or merge existing users/identities.

This separates the provider namespace, not database access or app authorization. The Supabase project remains shared. Do not restore the shared provider's old channel without checking the other apps and obtaining the correct original credentials.
