# ADR 0120: Registry Lints for Capability Codes and Route Paths

- Status: Accepted
- Date: 2026-10-28
- Decider: A147 (RRR-210)
- Migrations: none

## Context

Section 3.15 asks for source lints over capability strings and route paths (trace row S3.15-10). Capability codes
have one source, `packages/schemas/capabilities.yaml`, and routes have one per shell, its `ia/sitemap.yaml`. Code
named both as plain strings: `ctx.capabilities.has("org.members.manage")`, `href={`/${org}/home`}`. A misspelt
code hid a control from everyone, and a misspelt path answered 404, and only a test that happened to reach that line
noticed.

## Decisions

### 1. A generated `CapabilityCode` union

`generate:capabilities` also writes `packages/schemas/src/capabilities/codes.generated.ts`: `CAPABILITY_CODES` in
registry order and `CapabilityCode` over it, exported as `@xos/schemas/capabilities/codes`. `check:capabilities` and
a unit test fail when it is stale. The places that hold or check capabilities take the union: the Atlas membership,
project and Create menu sets, the module access helpers (`can`, `canAll`, `reach`), `listRoleCapabilities`, View as,
import targets, settings definitions, the API's `CapabilityRule`, and Compass's feature and workforce maps. Rows read
from the database are cast once where they are read, because their columns reference `app.capabilities`, which
migration 0203 seeds from the same file. The import is type-only, so no page bundle grows.

### 2. `xos/registered-capability`

The base ESLint preset reports a string shaped like a code (`module.object.verb`) that the registry lacks, when it sits
in a capability position: an argument of `has`, `can`, `canAll`, `canAny`, `rw`, `refusal`, `writableProjects` or any
function whose name says capability; the direct value of a property, variable, class field or JSX attribute whose
name says capability (or `refusal`), through conditionals and arrays; and, inside a capability-named variable or call,
nested objects too. Catalog keys that look alike (`advancing.packets.create`) are in none of these positions. The
union catches what the lint cannot see (a code passed through a variable); the lint catches what the type cannot
(a `ReadonlySet<string>` left untyped, a literal in a map typed `string`).

### 3. `xos/registered-route`

Atlas, Gateway and Console turn on `sitemapRoutes(import.meta.url)`: the routes of `ia/sitemap.generated.ts` and the
shell routes of `ia/routes.config.ts`. The rule checks `href` attributes and properties, `router.push`, `replace`,
`prefetch`, `navigate` and `dismissTo`, `redirect`, `permanentRedirect` and `NextResponse.redirect(new URL(…))`.
A template's `${…}` stands for a parameter value; a whole-segment `${…}` may stand for a fixed segment only at the end
of the path, where code picks a tab, so `/${org}/hom` fails instead of matching `/legal/{document}`. External URLs,
relative paths and templates that start with a variable are not checked.

Compass has no generated sitemap module: Expo Router's `app/` tree is its route table, and holds screens the sitemap
does not list (help, kiosk, workforce). `expoRoutes(import.meta.url)` reads that tree, so the check is against the
routes the app can actually open.

### 4. ESLint reads the generated modules directly

ESLint loads its config with plain Node 22.14, which does not strip TypeScript. `@xos/config` transpiles the generated
modules with the TypeScript compiler, now a runtime dependency, and imports them from a data URL; it refuses a module
with a runtime import. The lint task's Turborepo inputs include the generated capability module, so a registry change
reruns every package's lint.

## Consequences

- A capability or path missing from its registry fails `pnpm lint` (and, for capabilities, usually `pnpm typecheck`).
- Adding a capability means editing `capabilities.yaml` and running `generate:capabilities`; adding a route means the
  sitemap and `generate:routes` or `generate:sitemap`, as before.
- No existing violations were found when the rules were turned on; the rules' tests prove a wrong code or path fails.
