# Hosted security settings

Some Section 9 controls are settings in the hosted Supabase project, not in the repository, or need a
decision only the owner can make. `supabase/config.toml` holds the local values, and
`infra/security/test/auth-config.test.ts` fails CI if they regress. Apply each item below to staging
and then to production, and record the date and who applied it in the release notes.

## Supabase Auth (A22-010)

| Setting                    | Where in the dashboard                                 | Value                                                                      |
| -------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Leaked password protection | Authentication > Providers > Email (Password security) | On. Checks new passwords against the HaveIBeenPwned breach list (V6.2.12). |
| Minimum password length    | Authentication > Providers > Email                     | 12                                                                         |
| Password requirements      | Authentication > Providers > Email                     | Letters and digits                                                         |
| Secure password change     | Authentication > Providers > Email                     | On: a password change needs a recent sign-in (V6.2.3)                      |
| TOTP MFA                   | Authentication > Multi-Factor                          | Enroll and verify on. Optional per person; orgs enforce it per role        |
| WebAuthn MFA and passkeys  | Authentication > Multi-Factor, and Passkeys            | Enroll and verify on                                                       |
| WebAuthn relying party id  | Authentication > Passkeys (WebAuthn)                   | The production registrable domain, for example the Atlas apex domain       |
| WebAuthn origins           | Authentication > Passkeys (WebAuthn)                   | The https origins of Atlas and Gateway, including custom Gateway domains   |

Notes:

- Leaked password protection is available only on the hosted project. With it on, Supabase refuses a
  breached password with `weak_password`, and Atlas and Gateway show their weak password message,
  which names breach lists.
- Do not run `supabase config push` with the repository's values. They are local (`site_url` is
  127.0.0.1, and the WebAuthn `rp_id` is `localhost`). Set the hosted values in the dashboard.
- Atlas and Gateway also refuse passwords that contain a product name, the email's local part or a
  part of the person's name. That check runs in the sign-up server actions and needs no setting.

## Upload virus scanning (A22-011): owner decision

The `upload-scan` Edge Function scans through the `VirusScanner` port in `@xos/platform`. The
repository ships one adapter, ClamAV over TCP (`clamavScanner`). Until production has a scanner,
attachments stay in Scanning and unscanned field and onboarding files reach only their uploaders, so
the failure is closed, but those features are not usable by others.

Choose one:

1. **Self-hosted ClamAV.** Run clamd (the image pinned in ADR 0001) on a small container host that the
   Edge Functions can reach over a private network or TLS tunnel, and set the function secrets
   `CLAMD_HOST` and `CLAMD_PORT`. No new subprocessor, because files never leave XOS infrastructure.
   Keep signatures updated (freshclam runs inside the image) and alert when clamd is unreachable
   (the worker's `retrying` and `failed` outcomes).
2. **A hosted scanning service.** Add an adapter for it behind `VirusScanner`. Because it receives
   customer files, it is a subprocessor: add it to `legal/subprocessors.md` with 30 days' notice
   (DPA, `legal/OWNER_INPUTS.md` Part C) before it is used. No account has been opened.

Then schedule `upload-scan` every minute with the service key, as for `webhook-dispatch`.
