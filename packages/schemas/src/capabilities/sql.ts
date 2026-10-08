import { deriveRoleGrants } from "./grants.ts";
import type { CapabilityRegistry } from "./model.ts";

/** Repository-relative path of the generated capability seed migration (ADR 0004 range 0200 to 0299). */
export const CAPABILITY_SEED_MIGRATION = "supabase/migrations/0203_capability_seed.sql";

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function valuesBlock(rows: readonly (readonly string[])[]): string {
  return rows.map((cols) => `  (${cols.join(", ")})`).join(",\n");
}

/**
 * Renders the capability seed migration. Output is a pure function of the registry, so the
 * same YAML always yields byte-identical SQL. Re-running the migration is idempotent: modules,
 * capabilities and system roles are upserted, and system role grants are replaced as a set.
 */
export function renderCapabilitySeedSql(registry: CapabilityRegistry): string {
  const modules = registry.modules.map((m, i) => [
    sqlLiteral(m.code),
    `${sqlLiteral(m.group)}::app.nav_group`,
    String(m.projectScoped),
    String(i + 1),
  ]);

  let order = 0;
  const capabilities = registry.modules.flatMap((m) =>
    m.capabilities.map((c) => {
      order += 1;
      return [
        sqlLiteral(c.code),
        sqlLiteral(m.code),
        `${sqlLiteral(c.class)}::app.capability_class`,
        sqlLiteral(c.description),
        String(order),
      ];
    }),
  );

  const roles = registry.roles.map((r) => [
    sqlLiteral(r.code),
    String(r.band),
    sqlLiteral(r.description),
  ]);

  const grants = deriveRoleGrants(registry).map((g) => [
    sqlLiteral(g.role),
    sqlLiteral(g.capability),
    `${sqlLiteral(g.reach)}::app.capability_reach`,
  ]);

  return `-- 0203_capability_seed.sql
-- Generated from packages/schemas/capabilities.yaml by
-- \`pnpm --filter @xos/schemas generate:capabilities\`. Never edit by hand: the
-- @xos/schemas unit tests fail when this file differs from the generator output.
--
-- Registry version ${registry.version}: ${registry.modules.length} modules, ${capabilities.length} capabilities,
-- ${roles.length} system roles, ${grants.length} system role grants.

-- Modules ---------------------------------------------------------------------

insert into app.capability_modules (code, nav_group, project_scoped, sort_order) values
${valuesBlock(modules)}
on conflict (code) do update set
  nav_group = excluded.nav_group,
  project_scoped = excluded.project_scoped,
  sort_order = excluded.sort_order;

-- Capabilities ----------------------------------------------------------------

insert into app.capabilities (code, module_code, capability_class, description, sort_order) values
${valuesBlock(capabilities)}
on conflict (code) do update set
  module_code = excluded.module_code,
  capability_class = excluded.capability_class,
  description = excluded.description,
  sort_order = excluded.sort_order;

-- System roles ----------------------------------------------------------------

insert into app.roles (org_id, code, band, description)
select null, v.code, v.band, v.description
from (values
${valuesBlock(roles)}
) as v (code, band, description)
on conflict (code) where org_id is null do update set
  band = excluded.band,
  description = excluded.description;

-- System role grants ----------------------------------------------------------

delete from app.role_capabilities rc
using app.roles r
where rc.role_id = r.id and r.org_id is null;

insert into app.role_capabilities (role_id, capability_code, reach)
select r.id, v.capability_code, v.reach
from (values
${valuesBlock(grants)}
) as v (role_code, capability_code, reach)
join app.roles r on r.code = v.role_code and r.org_id is null;
`;
}
