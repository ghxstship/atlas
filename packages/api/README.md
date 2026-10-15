# @xos/api

The XOS public API v1: Hono route definitions, the generated OpenAPI 3.1 document
(`openapi/v1.json`, frozen by ADR 0014) and the runtime that serves operation handlers at
`/api/v1` in Atlas.

## Adding handlers

Every module has one handler file in `src/handlers/<module>.ts`, named in kebab-case after its
catalog tag (`Canon` is `canon.ts`). Edit only your module's file; the index
`src/handlers/index.generated.ts` already imports all of them, so parallel branches never
conflict on a shared list (ADR 0021, item 4).

```ts
import type { Components } from "../contract/operations.generated.ts";
import { notFound } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";

export const handlers = defineHandlers("Canon", {
  "canonDepartments.get": async ({ params, query }, { db }) => {
    const { data, error } = await db
      .schema("xpms")
      .from("dim_department")
      .select("dept_code,department,source,note")
      .eq("dept_code", String(params.dept_code))
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) throw notFound();
    return ok(data as Components["CanonDepartment"]);
  },
});
```

- **Keys** are operationIds of your module. A key from another module, or one that is not in
  the contract, fails to compile, and fails again at startup.
- **The request** (`params`, `query`, `body`) is already validated by the route's zod schemas
  and typed from the contract (`src/contract/operations.generated.ts`). `query.filter` holds the
  parsed `filter[field][op]=value` grammar. `idempotencyKey` is present on every POST and
  `ifMatch` on every PATCH; the runtime answers 400 and 428 when they are missing.
- **The response** is one of the operation's documented success statuses, built with `ok`,
  `created`, `accepted` or `noContent`. The body type is the contract's response schema.
- **The context** (second argument) carries `user`, `personId`, `org` (bound to the credential),
  `locale`, `requestId`, `credential`, `scopes` (API keys) and `db`, a Supabase client acting as
  the caller. RLS decides access; never use a service-role client for a user request. Use
  `requireOrg(context)` and `requirePerson(context)` when an operation needs them.
- **Errors.** Throw a problem from `src/problem.ts` (`notFound`, `conflict`, `refused`,
  `preconditionFailed`, `badRequest`) or throw the supabase-js `error` as is: SQLSTATE `XR001`
  becomes a 422 refusal carrying its rule, `42501` and `PGRST116` become 404, `23505` becomes 409. Anything else is reported and answered with a 500 problem that names the request id.
- **Lists.** `listPage(db.from("table"), query, { columns, key, defaultOrder })` from
  `src/runtime/listing.ts` applies the filter grammar, `sort`, sparse fieldsets and keyset cursor
  pagination, and returns the `{ data, next_cursor }` page.
- **Updates.** The runtime adds `ETag` wherever the contract declares it. For a row with
  `updated_at`, `versionFromIfMatch(ifMatch)` (`src/runtime/etag.ts`) returns the version to
  compare and set in the same statement: `.eq("id", id).eq("updated_at", version)`. No row back
  means stale (`preconditionFailed()`) or missing (`notFound()`); read once to tell them apart.
- **Restricted fields.** `maskRestricted(row, restricted, canRead, capabilityFor)` keeps each
  unreadable field present as `{ masked: true, reason }`.

An operation without a handler is never added to the router: it stays in the document and the
API answers 404 for it, never a stub.

## What the runtime does for every request

1. Authenticates: a bearer Supabase session JWT, the Atlas `xos-auth` cookie (same-origin only on
   writes) or an `xos_live_` API key, which the `api-token` Edge Function exchanges for a
   5-minute JWT acting as the key's service account. The org comes from the token's `org_id`
   claim (set by the context switcher through `app.set_active_org`), then the org Atlas last
   opened, then the person's only membership. 401 without a valid credential.
2. Limits an API key to the capability groups in its scopes.
3. Applies the rate limit: `RateLimit-*` headers on every response, 429 with `Retry-After`.
4. Validates params, query and body (422 with JSON Pointers), `Idempotency-Key` on POST (400
   when absent) and `If-Match` on PATCH (428 when absent).
5. Claims, replays or refuses the Idempotency-Key in A18's per-tenant ledger
   (`app.begin_idempotent_request`); a replay carries `Idempotent-Replayed: true`.
6. Runs the handler and maps problems and database errors to RFC 9457 responses.

## Contract tests

Test every handler through `test/support/contract.ts`:

```ts
import { handlers } from "../src/handlers/canon.ts";
import { contractApp, expectContract } from "./support/contract.ts";

const app = contractApp({ handlers: [handlers], db });
const page = await expectContract(await app.request("/canon/departments"), "canonDepartments.list");
```

`expectContract` checks the status, media type and body against `openapi/v1.json` itself, not
the zod schemas. `contractApp` fixes the caller (`context`), turns response validation on and
keeps idempotency in memory. Section 18 gate 5: `test/operation-coverage.test.ts` fails when a
handled operation is never named in an `expectContract(response, "<operationId>")` call.
`pnpm --filter @xos/api coverage:operations` prints handled operations by module (`--json`
lists the missing ones).

## Adding operations

The v1 catalog is frozen (ADR 0014), and changes within `/v1` are additive only, apart from the
draft corrections below. To add an
operation beyond it, such as `aurora.ask` or `assetScans.resolve`, edit only your module's file
in `src/catalog/modules/<module>.ts`:

```ts
import { assets } from "@xos/schemas";
import { collectionQuery, itemAction, resource } from "../define.ts";
import { defineAdditions } from "../additions.ts";

export const additions = defineAdditions("Assets", {
  // New resources, tagged with this module.
  resources: [
    resource("Assets", "/asset-scans", assets.AssetScan, {
      verbs: ["list", "get"],
      actions: [collectionQuery("resolve", { summary: "...", description: "..." })],
    }),
  ],
  // New actions on existing resources of this module, keyed by the resource's `op`.
  actions: { assetUnits: [itemAction("retire", { summary: "...", description: "..." })] },
  // The capability of each new resource, and of each action added to an existing resource.
  capabilities: {
    assetScans: { read: "assets.asset.read", write: "assets.asset.write" },
    assetUnits: { actions: { retire: "assets.asset.write" } },
  },
});
```

`applyAdditions` refuses an addition that reuses an existing resource, path or operationId, or
touches another module's resource. The contract tests confirm that every frozen operation and
component is unchanged in the regenerated document (Section 18, gate 20). Capabilities must name
codes in `packages/schemas/capabilities.yaml`.

## Correcting the frozen contract

While v1 is a draft (`API_VERSION` is `1.0.0-draft.N`), a frozen operation or component may be
corrected to match the implemented schema (ADR 0023). Once 1.0.0 is released, no correction is
possible and `/v1` changes are additive only. Propose a correction when your table cannot fill a
frozen shape faithfully: a required field whose column is nullable, a field the schema does not
have, a create body missing a NOT NULL column, a count the schema stores as rows, and so on.

1. In your branch, add an entry to `corrections` in your module file,
   `src/catalog/modules/<module>.ts`. Edit only your module's resources.

   ```ts
   import { fields } from "@xos/schemas";
   import { defineAdditions } from "../additions.ts";
   import { editShape, orNull } from "../correct.ts";

   export const additions = defineAdditions("Projects", {
     corrections: [
       {
         id: "gate-evidence-uri",
         since: "1.0.0-draft.2", // the current API_VERSION, or the next draft if you bump it
         resources: ["gateEvidence"],
         change: "Replaces evidence_document_id with evidence_uri and adds note.",
         reason: "app.gate_evidence (0301) stores an evidence URI and a note, not a document id.",
         apply: editShape({
           remove: ["evidence_document_id"],
           add: {
             evidence_uri: { schema: fields.url("Where the evidence lives."), create: "required" },
             note: { schema: orNull(fields.longText("Note.", "Signed copy.")), create: "optional" },
           },
         }),
       },
     ],
   });
   ```

   `src/catalog/correct.ts` has the edits: `editShape` (`nullable`, `remove`, `rename`, `add`,
   `serverSet`, `requireOnCreate`, `optionalOnCreate`, `immutable`, `description`),
   `removeVerbs`, `removeActions`, `putActions` (with capabilities) and `setOrder`; compose them
   with `all(...)`. Use `orNull` for a nullable field, never `.nullable()` on a shared component.

2. Name every resource the entry changes in `resources`, and any other component it changes in
   `components`. The reason names the table, view or migration that makes the frozen shape wrong.
3. Regenerate (`pnpm --filter @xos/api generate:handlers`) and update the contract tests of your
   handlers where the shape changed.
4. List the correction in your completion report. The orchestrator reviews it at merge and records
   it in ADR 0023's register.

`test/corrections.test.ts` (Section 18, gate 20) fails when the uncorrected catalog drifts from
the Wave 1 freeze (`src/catalog/frozen-v1.digest.json`, never regenerated while v1 is a draft),
when the corrected document changes a frozen operation or component that no entry lists, and when
an entry changes nothing it lists. `CORRECTIONS` (exported from `@xos/api`) is the resolved,
machine-readable list.

## Generated files

After adding handlers or operations, regenerate and commit the generated files:

```sh
pnpm --filter @xos/api generate:handlers   # indexes, openapi/v1.json, then operation types
pnpm --filter @xos/api check:handlers      # fails when any of them is stale (the tests check too)
```

Never edit `index.generated.ts`, `openapi/v1.json` or `operations.generated.ts` by hand. On a
merge conflict, take either side and rerun the generator.
