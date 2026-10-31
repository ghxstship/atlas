# @xos/docs

The XOS developer documentation site: guides, the API reference generated from OpenAPI, the data dictionary, the help
center and the self-hosting guide. Every page is prerendered under a locale prefix (`/en-US/…`, `/es-US/…`), except
the help center index.

```sh
pnpm --filter @xos/docs dev      # http://localhost:3004
pnpm --filter @xos/docs test     # content, links, reference model, brand resolution
pnpm --filter @xos/docs build
```

## An org's docs in its brand (Enterprise)

An Enterprise org with white label in force has its docs in its brand: its logo and name in the header and its accent
(Section 12, ADR 0066). Its docs live at:

- `/o/<org-slug>/…` on the docs host, for example `/o/northwind-live/en-US/guides/quickstart`;
- a host of its own, once the owner has set it up (below).

`proxy.ts` looks the brand up through `api_public.docs_brand_for_slug`, which returns only the name, logos and accent,
and only for such an org. Any other org, a failed lookup, or a deployment without the variables below serves the
platform docs. An accent that fails the contrast gate in any theme is dropped.

| Variable                | Purpose                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `SUPABASE_URL`          | Supabase API origin, for the brand lookup and the public `org-brand` bucket the logos come from. |
| `SUPABASE_ANON_KEY`     | The public anon key the lookup is called with.                                                   |
| `XOS_DOCS_TENANT_HOSTS` | Comma-separated `host=org-slug` pairs: each host serves only that org's docs.                    |

### Owner step: a custom docs domain

The build configures no DNS. For each Enterprise org that wants its docs on its own host:

1. Add the host (for example `docs.northwind-live.com`) to the docs project in Vercel (Project, Settings, Domains).
2. Have the org publish the DNS record Vercel shows (a CNAME to `cname.vercel-dns.com` for a subdomain), and wait for
   Vercel to verify it and issue the certificate.
3. Add `docs.northwind-live.com=northwind-live` to `XOS_DOCS_TENANT_HOSTS` and redeploy.

Until the org is on Enterprise with white label in force, the host serves the platform docs.
