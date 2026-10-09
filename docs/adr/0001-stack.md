# ADR 0001: Stack and Pinned Versions

- Status: Accepted
- Date: 2026-10-08
- Decider: Orchestrator (Wave 0)

## Context

Section 5 fixes the stack and requires every dependency pinned to the latest stable release at build start, recorded here, then kept current by Renovate. Versions were read from the npm registry and GitHub tags on 2026-10-08.

## Decision

### Toolchain

| Tool         | Version                                                          | Note                                                                          |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Node.js      | 22.14.0 (`.nvmrc`), engines `>=22.12.0`                          | Active LTS line installed on the build host; Vitest 5 requires 22.12 or later |
| pnpm         | 10.15.1                                                          | Deviation, see below                                                          |
| Turborepo    | 2.11.7                                                           |                                                                               |
| TypeScript   | 6.0.3                                                            | Deviation, see below                                                          |
| ESLint       | 10.12.0, with `@eslint/js` 10.0.1 and `typescript-eslint` 8.71.1 |                                                                               |
| Prettier     | 3.9.9                                                            |                                                                               |
| Vitest       | 5.0.3, with Vite 8.3.3 and `@vitest/coverage-v8` 5.0.3           |                                                                               |
| Supabase CLI | 2.120.0 in CI                                                    | Local hosts may run older 2.x                                                 |
| Postgres     | 17 (Supabase)                                                    | No native `uuidv7()`; see ADR 0002                                            |

### Runtime libraries (pinned now, installed by the owning wave)

| Area          | Package                                                  | Version |
| ------------- | -------------------------------------------------------- | ------- |
| Web           | `next`, `eslint-config-next`                             | 16.4.0  |
| Web           | `react`, `react-dom`, `@types/react`, `@types/react-dom` | 19.3.0  |
| API           | `hono`                                                   | 4.13.13 |
| API           | `@hono/zod-openapi`                                      | 1.6.3   |
| Validation    | `zod`                                                    | 4.6.5   |
| Data          | `@supabase/supabase-js`                                  | 2.117.3 |
| Data          | `@supabase/ssr`                                          | 0.12.7  |
| Mobile        | `expo`                                                   | 57.0.27 |
| Mobile        | `expo-router`                                            | 57.0.25 |
| Mobile        | `react-native`                                           | 0.87.1  |
| Mobile        | `react-native-reanimated`                                | 4.7.1   |
| Mobile build  | `eas-cli`                                                | 24.12.0 |
| Sync          | `@powersync/react-native`                                | 2.3.1   |
| Sync          | `@powersync/web`                                         | 2.4.2   |
| UI            | `radix-ui`                                               | 1.7.0   |
| UI            | `tailwindcss`, `@tailwindcss/postcss`                    | 4.3.3   |
| UI            | `@tanstack/react-table`                                  | 9.2.6   |
| UI            | `@tanstack/react-virtual`                                | 3.14.13 |
| UI            | `cmdk`                                                   | 1.1.1   |
| Forms         | `react-hook-form`                                        | 7.89.0  |
| Forms         | `@hookform/resolvers`                                    | 5.9.1   |
| Charts        | `@visx/visx`                                             | 4.0.0   |
| Charts        | `victory-native`                                         | 42.0.1  |
| Grid          | `@glideapps/glide-data-grid`                             | 6.0.3   |
| Editor        | `@tiptap/react`                                          | 3.31.4  |
| Editor        | `yjs`                                                    | 13.6.33 |
| Maps          | `maplibre-gl`                                            | 6.13.0  |
| Maps          | `@maplibre/maplibre-react-native`                        | 11.5.0  |
| Email         | `@react-email/components`                                | 1.0.12  |
| Email         | `resend`                                                 | 6.32.1  |
| SMS           | `twilio`                                                 | 6.1.2   |
| Payments      | `stripe`                                                 | 23.0.0  |
| i18n          | `next-intl`                                              | 4.14.9  |
| i18n          | `i18next`                                                | 26.4.2  |
| i18n          | `react-i18next`                                          | 17.0.16 |
| AI            | `@anthropic-ai/sdk`                                      | 0.132.1 |
| Parsing       | `chrono-node`                                            | 2.10.2  |
| Parsing       | `libphonenumber-js`                                      | 1.13.14 |
| Observability | `@sentry/nextjs`                                         | 11.5.0  |
| Observability | `@sentry/react-native`                                   | 8.29.0  |
| Observability | `@opentelemetry/api`                                     | 1.9.1   |
| Tokens        | `style-dictionary`                                       | 5.6.0   |
| Icons         | `lucide-react`, `lucide-react-native`                    | 1.53.0  |
| Docs          | `fumadocs-core`                                          | 16.16.2 |
| Components    | `storybook`                                              | 10.6.1  |
| Testing       | `@playwright/test`                                       | 1.64.0  |
| Testing       | `@axe-core/playwright`                                   | 4.13.0  |
| Codegen       | `openapi-typescript`                                     | 7.13.0  |

### Added during Wave 1 (2026-10-09)

Dependencies the Wave 1 agents needed that the original table did not list, each pinned to the latest stable release compatible with the pins above.

| Area       | Package                               | Version | Used by                      | Reason                                                                         |
| ---------- | ------------------------------------- | ------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Parsing    | `yaml`                                | 2.9.1   | `@xos/ia`, `@xos/schemas`    | Loads the sitemaps, `capabilities.yaml` and `plans.yaml`                       |
| Testing    | `@seriousme/openapi-schema-validator` | 2.11.0  | `@xos/api`                   | Validates the generated document as OpenAPI 3.1                                |
| Tokens     | `@tailwindcss/node`                   | 4.3.3   | `@xos/tokens` (dev)          | Compiles the Tailwind preset through `@config` in tests; matches `tailwindcss` |
| Lint       | `stylelint`                           | 16.26.1 | `@xos/config`, `@xos/tokens` | Deviation 4 below                                                              |
| Lint       | `stylelint-use-logical-spec`          | 5.0.1   | `@xos/config`                | Provides `liberty/use-logical-spec` (ADR 0010)                                 |
| i18n       | `@formatjs/icu-messageformat-parser`  | 3.5.21  | `@xos/i18n` (dev)            | Compares ICU arguments between catalogs                                        |
| Components | `qrcode-generator`                    | 1.4.4   | `@xos/ui` (Wave 2)           | Same library the design reference uses for QRCode and CredentialBadge          |

### CI actions (pinned by commit SHA, Section 9)

| Action               | Tag     | SHA                                                                                       |
| -------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `actions/checkout`   | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1`                                                |
| `actions/setup-node` | v7.1.0  | `949feb2413d6458794dcd2491c4babbbce0c15c1`                                                |
| `pnpm/action-setup`  | v6.1.0  | `ea17c68df8912ef543352723c149a84f56e3d413`                                                |
| `supabase/setup-cli` | v3.0.1  | `45a513f8c64c0bc8e0e3dfe572b5c95be85f6359`                                                |
| gitleaks container   | v8.30.1 | Run as a container; the gitleaks Action needs a paid license on organization repositories |

## Deviations from "latest stable"

1. **TypeScript 6.0.3, not 7.0.2.** `typescript-eslint` 8.71.1 declares a peer range of `>=4.8.4 <6.1.0`. TypeScript 7 (the native compiler) would break type-aware lint across the monorepo. Renovate holds TypeScript below 6.1 until `typescript-eslint` widens its range; this ADR is superseded then.
2. **pnpm 10.15.1, not 12.10.1.** Corepack bundled with Node 22.14 cannot launch the pnpm 12 package layout. Upgrade together with the Node runtime.
3. **Local Supabase port block 554xx and project id `xos4`.** The build host already runs an unrelated Supabase stack named `xos` on the default and 544xx ports. Moving this project avoids touching that stack.
4. **stylelint 16.26.1, not 17.16.0.** `stylelint-use-logical-spec` 5.0.1, the plugin ADR 0010 relies on, declares `stylelint >=11 <17` and has not been updated since 2024. 16.26.1 is the newest release inside that range. Renovate holds stylelint below 17 until the plugin widens its range or is replaced through a new ADR.

## Alternatives considered

- TypeScript 7 with type-aware lint turned off: rejected, because Section 18 requires typed lint rules and the consistent-type-imports rule.
- Installing pnpm 12 globally outside Corepack: rejected, because CI and contributors would diverge from `packageManager`.

## Consequences

Renovate opens pinned upgrade pull requests weekly. Every runtime library above is installed only when its owning wave starts, at the version listed here unless a newer ADR supersedes it.
