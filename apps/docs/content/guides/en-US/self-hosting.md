---
title: Self-hosting
summary: Run XOS on your own infrastructure with the Supabase CLI for development and Supabase's Docker Compose stack for production.
section: operate
order: 11
---

XOS is open source under AGPL-3.0. A deployment is a Supabase project (Postgres 17, Auth, Storage and Edge Functions) plus the Next.js apps: Atlas serves the app and the API at `/api/v1`, and Gateway serves external parties.

## Requirements

- Node.js 22.12 or later and pnpm 10.15.1 (the version in `packageManager`; Corepack installs it).
- Docker, for the Supabase stack.
- The Supabase CLI 2.x.
- A clone of the repository.

```bash
git clone https://github.com/ghxstship/atlas.git xos
cd xos
corepack enable
pnpm install
```

## Development with the Supabase CLI

`supabase/config.toml` defines the local stack. Start it, then apply every migration and seed from empty:

```bash
supabase start
supabase db reset
supabase test db
```

`supabase db reset` loads the canon and the demo tenant from `supabase/seeds`. `supabase start` prints the API URL and the anon key.

Configure Atlas by copying `apps/atlas/.env.example` to `apps/atlas/.env.local`:

| Variable            | Value                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| `SUPABASE_URL`      | The Supabase API URL                                                         |
| `SUPABASE_ANON_KEY` | The anon (publishable) key; row-level security guards every row              |
| `ATLAS_SITE_URL`    | The public origin of Atlas, used for sign-in links and the CSRF origin check |

Atlas validates these when it starts and names every missing or malformed variable.

```bash
pnpm --filter @xos/atlas dev
```

## Production with Docker Compose

Run Supabase with its official self-hosting Docker Compose stack (the `docker` directory of the Supabase repository), following Supabase's self-hosting guide to set its secrets: the Postgres password, the JWT secret, and the anon and service role keys generated from it. Then:

1. Apply the XOS migrations to that database: `supabase db push --db-url "postgresql://postgres:PASSWORD@HOST:5432/postgres"`.
2. Load the canon and your first organization with the seed files in `supabase/seeds`, in file name order.
3. Deploy the Edge Functions in `supabase/functions` to the stack's functions service, and set their secrets.
4. Build and start Atlas and Gateway with the variables above.

```bash
pnpm build
pnpm --filter @xos/atlas start
```

## Edge Function secrets

| Secret                                          | Used by                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `XOS_API_JWT_SIGNING_KEY`                       | `api-token`, which exchanges API keys for short-lived tokens; set it to the project's JWT secret |
| `SUPABASE_SERVICE_ROLE_KEY`                     | The worker functions; never give it to Atlas or a browser                                        |
| `XOS_APP_URL` and `XOS_POSTAL_ADDRESS`          | `notification-dispatch`, for links and the postal address in email                               |
| `XOS_INBOUND_SECRET` and `XOS_INBOUND_DOMAIN`   | `inbound-email`                                                                                  |
| `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` | `stripe-webhook`, only if you bill through Stripe                                                |
| `CLAMD_HOST` and `CLAMD_PORT`                   | `upload-scan`, the ClamAV daemon that scans uploads (`infra/scanning`)                           |

`webhook-dispatch`, `notification-dispatch` and `upload-scan` run on a schedule with the service role key; schedule them with your platform's cron. Until `upload-scan` runs, attachments cannot be downloaded and field and onboarding uploads reach only the person who uploaded them.

## Verify the deployment

```bash
curl "$ATLAS_SITE_URL/api/v1/openapi.json" | head -c 200
XOS_BASE_URL="$ATLAS_SITE_URL/api/v1" XOS_API_KEY="xos_live_..." xos auth status
```

## Upgrades

Pull the new release, run `pnpm install`, apply new migrations with `supabase db push`, redeploy the functions, and rebuild the apps. Migrations are forward-only, and `/v1` changes only additively, so existing integrations keep working.
