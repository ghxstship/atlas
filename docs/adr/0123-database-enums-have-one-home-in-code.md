# ADR 0123: Database Enums Have One Home in Code

- Status: Accepted
- Date: 2026-10-28
- Decider: A148 (RRR-211), trace row S3.15-10
- Migrations: none

## Context

Section 3.15 rule 3 says states and kinds come from the generated enums. Many modules still wrote the values out
again: 568 string-literal unions and arrays across 221 files listed exactly the values of a database enum, in
`z.enum([...])` validators, option lists, `label([...])` calls in the API catalog and type aliases. Each copy
drifts when a migration adds or renames a value, and nothing failed when one did.

Three facts shape the fix:

- `Constants` in `@xos/data/database.types` is one object holding all 239 enums, about 6.3 KB gzip. A bundler
  cannot drop the properties a module leaves unused, so one client component that imports it adds the whole table
  to its page. Several key pages are within 3 KB of the 200 KB route budget, and the shell and collection
  components load on every page.
- `@xos/data` depends on `@xos/schemas`, so `@xos/schemas` cannot import `Constants`. `@xos/sdk` and `@xos/mcp`
  are published clients of the API; `@xos/ui`, `@xos/ui-native`, `@xos/ai` and `@xos/platform` sit below
  `@xos/data` as well.
- Some lists equal an enum by coincidence: the moves out of a state in a transition map, or the two group keys of
  an automation's conditions.

## Decisions

### 1. A lint reports a restated enum

`xos/no-restated-enums` (`packages/config/eslint/no-restated-enums.mjs`, on in the shared preset) reports a
string-literal union type, or an array of string literals, whose values are exactly the values of one database
enum, in any order. A subset or a superset is not reported: the states a screen offers, or the terminal states,
are decisions of their own. Enums of one value are never matched. Generated files and tests are exempt. The enum
values come from the Constants block of the generated `database.types.ts`, so the rule follows every regeneration
with no list of its own; turbo's lint and test inputs include that file.

### 2. Where the values come from

- Types read `Database["app"]["Enums"]["…"]`, a type-only import that costs nothing in a bundle.
- The API catalog and handlers, and Compass, read `Constants.app.Enums.…`.
- Code a browser or an Edge Function bundle may load (Atlas, Gateway, the console, `@xos/integrations` and
  `@xos/data` itself, whose modules client components import) reads `@xos/data/enums`: one named export per
  enum (`exportFormat` for `app.export_format`, `xpmsRefusal` for `xpms.refusal`), written by
  `pnpm --filter @xos/data enums:generate` from the Constants of `database.types.ts`. Modules import it as a
  namespace, `import * as enums from "@xos/data/enums"`, so a local name never shadows an enum, and the bundler
  keeps only the lists a module names. `types:generate` runs the generator after it rewrites the types, and the
  data package's tests fail when the file is out of date. Reading `Constants` in `@xos/integrations` put
  integration-inbound 4 KB over its Edge Function boot budget; the per-enum module keeps it inside.

### 3. Packages below `@xos/data` keep a copy that a test holds equal

In `@xos/schemas`, `@xos/ai`, `@xos/platform`, `@xos/sdk` and `@xos/ui-native`, each enum is written
once, at its home in the package, with an `eslint-disable-next-line xos/no-restated-enums` that names the test.
Other code in the package reads that home. Each package's `test/database-enums.test.ts` holds every copy to the
same values as its enum, through `databaseEnums()` from `@xos/config/database-enums`. A copy that is a type is
checked through a `Record` over the type, which must name each member once. `@xos/mcp` reads the SDK's
`FILTER_OPERATORS`.

### 4. Coincidences are named where they occur

A list that equals an enum by coincidence keeps its values and carries an `eslint-disable-next-line` with the
reason on the line above: the change order moves out of Priced in `packages/data/src/finance.ts`, and the automation
group keys in `packages/schemas/src/automations/evaluate.ts`. `"Atlas" | "Gateway"` equals `app.shortcut_shell`, the
keyboard-shortcut shells of migration 1370, but four lists of those two names are other sets: the custom-domain
purposes of `app.org_domain_purpose` that the 0850 and 1355 triggers gate (the Domains panel), the `app_code` check
of feedback (1531), the `web_app` check of push subscriptions (1533, in `@xos/data` and `@xos/platform`) and the
apps with a service worker in `@xos/ui`. Each keeps its literals, so a shell added to `app.shortcut_shell` does not
widen them to values their constraints refuse.

## Consequences

- A migration that adds or renames an enum value reaches every validator, option list and API schema through
  the generated files, and a list written out again fails lint.
- Lists whose order differed from the enum now follow the enum's order, which is the lifecycle order. The API
  document lists those enum values, and their examples, in that order; no value is added or removed.
- Client components that show an enum's values add only those values to their page.
