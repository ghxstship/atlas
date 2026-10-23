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

| Area       | Package                                                      | Version | Used by                      | Reason                                                                                                                          |
| ---------- | ------------------------------------------------------------ | ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Parsing    | `yaml`                                                       | 2.9.1   | `@xos/ia`, `@xos/schemas`    | Loads the sitemaps, `capabilities.yaml` and `plans.yaml`                                                                        |
| Testing    | `@seriousme/openapi-schema-validator`                        | 2.11.0  | `@xos/api`                   | Validates the generated document as OpenAPI 3.1                                                                                 |
| Tokens     | `@tailwindcss/node`                                          | 4.3.3   | `@xos/tokens` (dev)          | Compiles the Tailwind preset through `@config` in tests; matches `tailwindcss`                                                  |
| Lint       | `stylelint`                                                  | 16.26.1 | `@xos/config`, `@xos/tokens` | Deviation 4 below                                                                                                               |
| Lint       | `stylelint-use-logical-spec`                                 | 5.0.1   | `@xos/config`                | Provides `liberty/use-logical-spec` (ADR 0010)                                                                                  |
| i18n       | `@formatjs/icu-messageformat-parser`                         | 3.5.21  | `@xos/i18n` (dev)            | Compares ICU arguments between catalogs                                                                                         |
| Components | `qrcode-generator`                                           | 1.4.4   | `@xos/ui`                    | Same library the design reference uses for QRCode and CredentialBadge                                                           |
| Testing    | `@testing-library/react`                                     | 16.3.3  | `@xos/ui` (dev)              | Component render and interaction tests                                                                                          |
| Testing    | `@testing-library/dom`                                       | 10.4.2  | `@xos/ui` (dev)              | Peer of `@testing-library/react`                                                                                                |
| Testing    | `@testing-library/user-event`                                | 14.6.7  | `@xos/ui` (dev)              | Keyboard and pointer interaction tests                                                                                          |
| Testing    | `axe-core`                                                   | 4.14.0  | `@xos/ui` (dev)              | Per-component accessibility checks (Section 18, gate 8)                                                                         |
| Testing    | `jsdom`                                                      | 29.1.1  | `@xos/ui` (dev)              | DOM environment for Vitest component tests                                                                                      |
| Charts     | `@visx/scale`, `@visx/shape`, `@visx/group`, `@visx/pattern` | 4.0.0   | `@xos/ui`                    | Modular Visx packages at the pinned version; the `@visx/visx` umbrella imports `@visx/xychart`, which needs `@react-spring/web` |
| Editor     | `@tiptap/core`, `@tiptap/pm`                                 | 3.31.4  | `@xos/ui`                    | Peers of the pinned `@tiptap/react`                                                                                             |
| Editor     | `@tiptap/starter-kit`, `@tiptap/extension-collaboration`     | 3.31.4  | `@xos/ui`                    | Editor features and the Yjs binding, at the Tiptap pin                                                                          |
| Editor     | `@tiptap/y-tiptap`                                           | 3.0.9   | `@xos/ui`                    | Peer of the collaboration extension                                                                                             |
| Editor     | `y-protocols`                                                | 1.0.7   | `@xos/ui`                    | Peer of `@tiptap/y-tiptap`                                                                                                      |

### CI actions (pinned by commit SHA, Section 9)

| Action                    | Tag     | SHA                                                                                       |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `actions/checkout`        | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1`                                                |
| `actions/setup-node`      | v7.1.0  | `949feb2413d6458794dcd2491c4babbbce0c15c1`                                                |
| `actions/upload-artifact` | v7.0.1  | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`                                                |
| `pnpm/action-setup`       | v6.1.0  | `ea17c68df8912ef543352723c149a84f56e3d413`                                                |
| `supabase/setup-cli`      | v3.0.1  | `45a513f8c64c0bc8e0e3dfe572b5c95be85f6359`                                                |
| gitleaks container        | v8.30.1 | Run as a container; the gitleaks Action needs a paid license on organization repositories |

## Deviations from "latest stable"

1. **TypeScript 6.0.3, not 7.0.2.** `typescript-eslint` 8.71.1 declares a peer range of `>=4.8.4 <6.1.0`. TypeScript 7 (the native compiler) would break type-aware lint across the monorepo. Renovate holds TypeScript below 6.1 until `typescript-eslint` widens its range; this ADR is superseded then.
2. **pnpm 10.15.1, not 12.10.1.** Corepack bundled with Node 22.14 cannot launch the pnpm 12 package layout. Upgrade together with the Node runtime.
3. **Local Supabase port block 554xx and project id `xos4`.** The build host already runs an unrelated Supabase stack named `xos` on the default and 544xx ports. Moving this project avoids touching that stack.
4. **stylelint 16.26.1, not 17.16.0.** `stylelint-use-logical-spec` 5.0.1, the plugin ADR 0010 relies on, declares `stylelint >=11 <17` and has not been updated since 2024. 16.26.1 is the newest release inside that range. Renovate holds stylelint below 17 until the plugin widens its range or is replaced through a new ADR.
5. **Glide Data Grid not installed.** `@glideapps/glide-data-grid` 6.0.3 declares peers `react` and `react-dom` 16 to 18 (the repo pins 19.3.0) plus `lodash`, `marked` and `react-responsive-carousel`. SpreadsheetGrid, BudgetGrid and BidSheet ship on the accessible ARIA grid model from the design reference (keyboard editing, Excel paste, NULL-aware cells and totals). Glide is adopted when a release supports React 19, behind the same component props.
6. **Compass pins react-native 0.86.3 and react 19.2.3, not 0.87.1 and 19.3.0.** Expo SDK 57, the pinned SDK, bundles react-native 0.86.3 and react 19.2.3, and Metro cannot bundle react-native 0.87 (`@expo/metro-config` 57 needs `react-native/rn-get-polyfills`, which 0.87 removed). The renderer needs an exact React match, so `apps/compass` alone pins Expo's bundled set: react-native 0.86.3, react 19.2.3, react-native-reanimated 4.5.1, react-native-worklets 0.10.1, react-native-screens 4.26.2, react-native-safe-area-context 5.7.0 and react-native-svg 15.15.4. `apps/compass/metro.config.js` resolves one React. `@xos/ui-native` accepts React `19.2.3 || 19.3.0`. The web apps stay on React 19.3.0. React Native 0.87 and React 19.3 move into Compass with the Expo SDK that supports them.

## Alternatives considered

- TypeScript 7 with type-aware lint turned off: rejected, because Section 18 requires typed lint rules and the consistent-type-imports rule.
- Installing pnpm 12 globally outside Corepack: rejected, because CI and contributors would diverge from `packageManager`.

## Consequences

Renovate opens pinned upgrade pull requests weekly. Every runtime library above is installed only when its owning wave starts, at the version listed here unless a newer ADR supersedes it.

## Amendment (2026-10-16): testing tools (A24)

| Area    | Tool                                                                                                                   | Version       |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| Testing | `@lhci/cli` (devDependency of `packages/testing`)                                                                      | 0.15.1        |
| Testing | Lighthouse, bundled by `@lhci/cli`; not a direct dependency, because 13.x needs Node 22.19 and the repo floor is 22.12 | 12.6.1        |
| Testing | k6, run only as the official Docker image `grafana/k6` against local stacks                                            | 2.3.0         |
| Testing | Playwright image for the Storybook visual job, `mcr.microsoft.com/playwright`                                          | v1.64.0-noble |

## Amendment (2026-10-17): Compass launch dependencies (A42)

| Area    | Package                                                                 | Version |
| ------- | ----------------------------------------------------------------------- | ------- |
| Compass | `expo-audio` (voice notes; published 2026-09-11, sdk-57 tag)            | 57.0.5  |
| Compass | `@bacons/apple-targets` (widget extension target; published 2026-07-17) | 5.0.0   |

## Amendment (2026-10-17): report rendering (A43)

| Area          | Package                                                      | Version |
| ------------- | ------------------------------------------------------------ | ------- |
| Data and Edge | `pdfkit` (server-only report PDFs; Edge `npm:pdfkit@0.20.2`) | 0.20.2  |
| Data          | `@types/pdfkit` (dev)                                        | 0.17.6  |
| Edge          | `exceljs` added to the Edge import map (`npm:exceljs@4.4.0`) | 4.4.0   |

## Amendment (2026-10-18): Continue on another device (A45)

| Area    | Package                                                                                    | Version |
| ------- | ------------------------------------------------------------------------------------------ | ------- |
| Compass | `expo-notifications` (actionable approval pushes; Expo SDK 57's bundled `~57.0.22`)        | 57.0.22 |
| Testing | `jsqr` (devDependency of `apps/atlas`; decodes the handoff QR code in a45-handoff.spec.ts) | 1.4.0   |

## Amendment (2026-10-19): generated documents (A49)

| Area    | Package or image                                                                                       | Version |
| ------- | ------------------------------------------------------------------------------------------------------ | ------- |
| Data    | `qrcode-generator` (QR code on generated documents; the version `@xos/ui` already pins)                | 1.4.4   |
| Data    | `@fontsource/inter` (dev; source of the Inter fonts embedded in generated documents, ADR 0031)         | 5.3.0   |
| Testing | veraPDF, run only as the official Docker image `verapdf/cli` for the gate 19 PDF/UA-1 check (ADR 0031) | v1.30.2 |

pdfkit 0.20.2 (A43 amendment) is also the generated document renderer, listed in `serverExternalPackages` in Atlas and Gateway.

## Amendment (2026-10-19): upload scanning and the buffers removal (A57, ADR 0034)

| Area     | Package or image                                                                                                         | Version |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| Security | ClamAV daemon, run only as the official Docker image `clamav/clamav` (linux/amd64) for upload scanning                   | 1.5.4   |
| Data     | `unzipper`, pinned through a pnpm override under `exceljs` (replaces 0.10.14, which pulled in `buffers` with no license) | 0.12.3  |

## Amendment (2026-10-23): Next.js security release (RRR-139)

| Area | Package                                                                                                                                                    | Version |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Web  | `next`, `eslint-config-next` (replaces 16.4.0; 16.4.1 fixes GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr and GHSA-p3m5-59mp-jv5r, 16.4.2 is the current patch) | 16.4.2  |
