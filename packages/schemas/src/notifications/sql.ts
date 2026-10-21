import type { NotificationKindRegistry } from "./model.ts";

/**
 * Repository-relative path of the current generated seed migration of the notification kind registry.
 * Applied migrations are never edited (ADR 0004): when notification-kinds.yaml changes after this seed
 * has shipped, move it to the next number in the range of the agent changing it. Each seed is a complete
 * idempotent upsert, so the latest one decides the rows.
 */
export const NOTIFICATION_KIND_SEED_MIGRATION =
  "supabase/migrations/1360_notification_kind_seed.sql";

/** The pgTAP drift test of the seed, named for its migration. */
export const NOTIFICATION_KIND_DRIFT_TEST = NOTIFICATION_KIND_SEED_MIGRATION.replace(
  "supabase/migrations/",
  "supabase/tests/",
).replace(/\.sql$/, ".test.sql");

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function valuesBlock(rows: readonly (readonly string[])[]): string {
  return rows.map((cols) => `  (${cols.join(", ")})`).join(",\n");
}

interface Rows {
  readonly channels: string[][];
  readonly templates: string[][];
  readonly categories: string[][];
  readonly kinds: string[][];
}

function rows(registry: NotificationKindRegistry): Rows {
  return {
    channels: registry.channels.map((c) => [
      `${literal(c.code)}::app.notification_channel`,
      String(c.enabledByDefault),
    ]),
    templates: registry.emailTemplates.map((t) => [
      literal(t.code),
      literal(t.description),
      String(t.transactional),
    ]),
    categories: registry.categories.map((c) => [
      literal(c.code),
      String(c.urgent),
      String(c.order),
    ]),
    kinds: registry.kinds.flatMap((k) =>
      k.channels.map((channel) => [
        literal(k.kind),
        `${literal(channel)}::app.notification_channel`,
        literal(k.category),
        channel === "Email" ? literal(k.emailTemplate) : "null",
      ]),
    ),
  };
}

/**
 * Renders the seed migration: an upsert of every channel default, email template, category and
 * kind-by-channel row. Output is a pure function of the registry. It never deletes: a row the registry
 * does not name (for example a kind another branch added in SQL) stays, and the drift test fails on it
 * until the kind is added to notification-kinds.yaml.
 */
export function renderNotificationSeedSql(registry: NotificationKindRegistry): string {
  const r = rows(registry);
  return `-- ${fileName(NOTIFICATION_KIND_SEED_MIGRATION)}
-- Generated from packages/schemas/notification-kinds.yaml by
-- \`pnpm --filter @xos/schemas generate:notifications\`. Never edit by hand: the
-- @xos/schemas unit tests fail when this file differs from the generator output.
--
-- Notification kind registry version ${registry.version} (Section 3.15, A65-021): ${r.channels.length} channel defaults,
-- ${r.templates.length} email templates, ${r.categories.length} categories, ${registry.kinds.length} kinds (${r.kinds.length} kind and channel rows).
-- Upserts the reference rows of 0520. Rows the registry does not name are left in place and fail the
-- drift test (${fileName(NOTIFICATION_KIND_DRIFT_TEST)}).

-- Channel defaults ------------------------------------------------------------

insert into private.channel_defaults (channel, enabled_by_default) values
${valuesBlock(r.channels)}
on conflict (channel) do update set enabled_by_default = excluded.enabled_by_default;

-- Email templates -------------------------------------------------------------

insert into private.email_templates (code, description, transactional) values
${valuesBlock(r.templates)}
on conflict (code) do update set description = excluded.description, transactional = excluded.transactional;

-- Categories (orders move aside first, so a reordering never collides) -------

update private.notification_categories set sort_order = -sort_order
where code in (${r.categories.map((c) => c[0]).join(", ")});

insert into private.notification_categories (code, urgent, sort_order) values
${valuesBlock(r.categories)}
on conflict (code) do update set urgent = excluded.urgent, sort_order = excluded.sort_order;

-- Kinds by channel ------------------------------------------------------------

insert into private.notification_templates (kind, channel, category_code, email_template_code) values
${valuesBlock(r.kinds)}
on conflict (kind, channel) do update
  set category_code = excluded.category_code, email_template_code = excluded.email_template_code;

comment on table private.notification_templates is 'Which category each notification kind belongs to and which email template renders it, seeded from packages/schemas/notification-kinds.yaml (Section 3.15). Copy for every channel comes from the i18n catalogs keyed by kind.';
comment on table private.notification_categories is 'Notification categories a person sets preferences for, by channel, seeded from packages/schemas/notification-kinds.yaml. Urgent categories bypass quiet hours and digests. Labels come from the i18n catalogs keyed by code.';
`;
}

/** Renders the pgTAP drift test: the database reference rows equal the registry, both ways. */
export function renderNotificationDriftTest(registry: NotificationKindRegistry): string {
  const r = rows(registry);
  const asText = (rowsIn: string[][]) =>
    rowsIn.map((cols) => cols.map((c) => c.replace("::app.notification_channel", "")));
  return `-- ${fileName(NOTIFICATION_KIND_DRIFT_TEST)}
-- Generated from packages/schemas/notification-kinds.yaml by
-- \`pnpm --filter @xos/schemas generate:notifications\`. Never edit by hand.
--
-- pgTAP drift test of the notification kind registry (Section 3.15, A65-021): the database holds exactly
-- the channel defaults, email templates, categories and kinds the registry declares. A kind added in SQL
-- without the registry, or a registry change without a regenerated seed, fails here.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(4);

select set_eq(
  $$select channel::text, enabled_by_default from private.channel_defaults$$,
  $$values
${valuesBlock(asText(r.channels))}$$,
  'channel defaults match notification-kinds.yaml');

select set_eq(
  $$select code, description, transactional from private.email_templates$$,
  $$values
${valuesBlock(r.templates)}$$,
  'email templates match notification-kinds.yaml');

select set_eq(
  $$select code, urgent, sort_order::integer from private.notification_categories$$,
  $$values
${valuesBlock(r.categories)}$$,
  'notification categories match notification-kinds.yaml');

select set_eq(
  $$select kind, channel::text, category_code, email_template_code from private.notification_templates$$,
  $$values
${valuesBlock(asText(r.kinds).map((cols) => [cols[0] ?? "", cols[1] ?? "", cols[2] ?? "", cols[3] === "null" ? "null::text" : (cols[3] ?? "")]))}$$,
  'notification kinds by channel match notification-kinds.yaml');

select * from finish();
rollback;
`;
}
