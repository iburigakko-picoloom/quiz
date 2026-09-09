# Quiz Make dedicated LINE provider

Prepared identifier: `custom:quizmake-line`.
LINE channel: `2011510017`.
Supabase project: `xqknwsjbvczyexfxlgar`.

The existing `custom:line` provider and all existing identities must remain unchanged.
The dedicated provider was created and enabled by the owner on 2026-09-09. A read-only check confirmed its identifier, client ID and enabled state. Its scopes were normalized to `openid` and `profile` after an input artifact was found.

GitHub repository variable `VITE_LINE_AUTH_PROVIDER` is now `custom:quizmake-line`. Deployment was dispatched on 2026-09-09. Local builds without this variable still use the legacy provider; set the same variable locally to test the dedicated flow. End-to-end linking requires the owner's LINE consent and remains to be verified.

While signed in with the existing email account, use LINE linking before trying a standalone LINE login. Verify that the same Supabase user now owns a `custom:quizmake-line` identity. Do not delete, move or merge existing users/identities.

This separates the provider namespace, not database access or app authorization. The Supabase project remains shared. Do not restore the shared provider's old channel without checking the other apps and obtaining the correct original credentials.
