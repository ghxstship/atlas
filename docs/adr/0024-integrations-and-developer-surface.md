# ADR 0024: Integrations and Developer Surface

- Status: Accepted
- Date: 2026-10-16
- Decider: Orchestrator

## Context

A19 built the integration framework and its connectors. A20 built the SDKs, the CLI, the MCP server and the docs site. Each made design choices that later agents and operators rely on. This ADR records them.

## Decision

### Integrations (A19, migrations 0600 to 0639)

1. **Credentials live only in Supabase Vault.** `app.integration_connections` holds non-secret metadata. Only the service role decrypts a credential, through `app.read_integration_credential`. Disconnecting destroys the secret. A connection can be removed only after it is Disconnected.
2. **Sync runs own their retries.** Each attempt is an `integration.sync` job on A18's queue with `max_attempts` 1. Backoff starts at 30 seconds, doubles, and caps at one hour. When attempts run out, the run becomes Failed. A refused credential moves the connection to Error instead of retrying.
3. **Connector settings are a provider payload (JSONB).** Secrets never go in it.
4. **Exports go out whole or not at all.**
   - Accounting exports whole journals only: balanced, in one currency, with every account mapped. Anything else is recorded as an item error.
   - Payroll sends nothing unless every line is mapped.
5. **Inbound changes never delete XOS work.** When a provider deletes something, XOS re-places it or reports it.
6. **Chat acts as the linked person.** Unfurls and slash commands run as that person under RLS. A `clientFor(userId)` port mints the token, the same way `api-token` does.
7. **Ramp is a spend platform.**
   - Ledger Export projects the mapped GL chart into Ramp.
   - Payment Sync brings paid bills in.
   - Pushing payments to Ramp is refused (`direction_unsupported`).
8. **Identity.**
   - SSO and SCIM never grant the Owner role.
   - A just-in-time join needs an SSO session.
   - SCIM deprovisioning ends the membership and opens offboarding.
   - SCIM group IDs are the display name, base64url-encoded.
   - 0638 resolves A30's verification enum and `record_organization_verification` at run time, so it does not depend forward on 0860.

### Developer surface (A20)

1. **One in-repo generator builds both SDKs.** `packages/sdk-ts/codegen` builds one IR from `openapi/v1.json` and emits `@xos/sdk` (TypeScript) and `xos-sdk` (Python, standard library only, Python 3.9 or later). It replaces openapi-typescript and openapi-python-client.
   - Generated output lives in `src/generated` and `src/xos_sdk/_generated`.
   - Every API catalog change must run `pnpm --filter @xos/sdk generate`. The SDK test scripts run `--check` and fail when the output is stale.
2. **The MCP server is a hand-written JSON-RPC 2.0 stdio server.** It speaks protocol 2025-06-18 and also negotiates 2025-03-26 and 2024-11-05.
   - Read tools are always on.
   - Write tools appear only for resources or modules the operator names with `--write`. Delete also needs `--allow-delete`.
   - Every call goes through `/api/v1` with the API key, so an agent can never exceed the key's scopes.
3. **The docs site is built on Next.js and `@xos/ui`, with a small Markdown renderer.**
   - The API reference is built from `v1.json` at build time, and every resource page is prerendered for both locales.
   - The help center reads `apps/atlas/help` where it lives.
4. **SDK, CLI and MCP messages are developer-facing and en-US only**, like API problem details. They are not in the message catalogs.
5. **`@xos/sdk` exports its compiled build.** Packages that depend on it need `^build`.
6. **The CLI takes import and export job bodies from `--data`**, so it never pins a shape the contract may still correct.

## Consequences

The following are still open:

- Live contract checks against provider sandboxes. Agents may not create sandbox accounts (Section 19.8).
- Edge Function wiring has no owner yet:
  - the integration worker schedule
  - the SCIM, Slack and Teams inbound endpoints
  - the chat token minter
  - the verifier schedules
- The OAuth 2.1 authorization and token endpoints. Only the app registry and consent grants exist.
- Publishing to npm and PyPI waits for Wave 7.

## Amendment (2026-10-28): the npm scope (A151)

`@xos` on npm belongs to someone else, so the two npm packages publish under the owner's scope: `@xos/sdk` is `@ghxstship/xos-sdk` and `@xos/cli` is `@ghxstship/xos-cli`. The names in item 1 and item 5 read accordingly, and the generator runs as `pnpm --filter @ghxstship/xos-sdk generate`. The other workspace packages keep `@xos/*`, because they are private and never published. The PyPI package stays `xos-sdk`.

## Amendment (2026-11-14): the design packages publish too

The owner approved publishing the design packages on 2026-11-14 so the Atlas marketing site, built in `ghxstship/atlas-marketing`, installs them at exact versions instead of vendoring an export (`design/MARKETING_LOCKSTEP.md`). Five packages publish with every release tag, at the tag's version:

| Workspace name | npm name                 |
| -------------- | ------------------------ |
| `@xos/tokens`  | `@ghxstship/xos-tokens`  |
| `@xos/icons`   | `@ghxstship/xos-icons`   |
| `@xos/i18n`    | `@ghxstship/xos-i18n`    |
| `@xos/schemas` | `@ghxstship/xos-schemas` |
| `@xos/ui`      | `@ghxstship/xos-ui`      |

`@xos/icons` is on the list because `@xos/ui` depends on it. The workspace keeps the `@xos/*` names, `private: true` and version 0.0.0, so no import in the monorepo changes: `infra/ci/pack-design-packages.mjs` stages each package's tracked files, writes a publish manifest with the npm name and the release version, and packs that. Sibling dependencies become npm aliases (`"@xos/tokens": "npm:@ghxstship/xos-tokens@X.Y.Z"`), so the source in each archive imports `@xos/*` exactly as the tag does, and a consumer installs each package under its workspace name the same way. The archives hold TypeScript source, as the Atlas apps consume it; the consumer transpiles it. Tests, stories, tool configuration, the generator command lines of `@xos/schemas` and the translation pipeline of `@xos/i18n` stay out; everything else git tracks in each package ships. `@xos/icons` carries `THIRD_PARTY_NOTICES` with the lucide license, since its sprite redistributes lucide artwork.

The packages are public on npm, like the SDK and the CLI, under the MIT license each already carries.

The Tailwind preset moved from `packages/config/tailwind/preset.js` to `packages/tokens/tailwind/preset.cjs` (`@xos/tokens/tailwind/preset.cjs`), because the stylesheet `@xos/ui` exports loads it and `@xos/config` does not publish. `@xos/ui` declares `tailwindcss` as a peer dependency for the same reason. The design handoff still names the old path; the port of `export/tailwind.preset.js` lands in the new one.
