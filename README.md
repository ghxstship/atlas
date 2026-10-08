# XOS 4.0

The Experiential Operating System turns the XOS 4.0 Production Playbook into software. One backend, one database, one API and one design system serve three surfaces:

| Surface     | Path                         | Who uses it                                                                                                           |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Atlas 4.0   | `apps/atlas`                 | Internal org members: plan, budget, procure, staff, advance and close productions. Hosts the public API at `/api/v1`. |
| Gateway 4.0 | `apps/gateway`               | External parties: vendors, contractors, clients, crew, staff, artists, artist representatives and sponsors.           |
| Compass 4.0 | `apps/compass` (from Wave 4) | Field operations on iOS and Android, offline first, for internal and external users.                                  |

## Requirements

- Node.js 22.12 or later (`.nvmrc` pins the version CI uses)
- pnpm 10.15.1 (`packageManager` in `package.json`)
- Docker and the Supabase CLI for the local database

## Getting started

```bash
pnpm install
supabase db start
pnpm dev
```

Atlas runs on port 3000 and Gateway on port 3001. The local Supabase stack uses the 554xx port block (`supabase/config.toml`).

## Checks

`pnpm verify` runs every check CI runs, in order: format, finish guard, lint, typecheck, unit tests and build. `supabase test db` runs the pgTAP suites in `supabase/tests`.

## Repository map

| Path        | Owner (ADR 0004)               | Contents                                                                                |
| ----------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `apps/`     | Shell agents                   | Atlas, Gateway, Compass, docs site and operator console                                 |
| `packages/` | Contract and platform agents   | Tokens, UI libraries, schemas, data layer, API, SDK, sync, i18n, email, config, testing |
| `canon/`    | A01 Canon                      | Canon inputs, the deterministic importer, the Playbook column map                       |
| `supabase/` | Data agents by migration range | Migrations, seeds, Edge Functions, pgTAP suites                                         |
| `design/`   | A05 Design System              | Claude Design exports                                                                   |
| `legal/`    | A21 Compliance and Legal       | Policies, ACR drafts, subprocessor list                                                 |
| `docs/adr/` | Orchestrator                   | Architecture Decision Records                                                           |

## Licenses

The platform is AGPL-3.0 (`LICENSE`). SDKs, design tokens, UI libraries, schemas, the CLI and the MCP server are MIT, with a `LICENSE` file in each package. Canon data is CC BY 4.0. The XOS name and marks are covered by `TRADEMARKS.md`. See `NOTICE` for the full split.
