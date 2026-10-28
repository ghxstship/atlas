import type { NotificationKindRegistry } from "./model.ts";

/**
 * Repository-relative path of the current generated seed migration of the notification kind registry.
 * Applied migrations are never edited (ADR 0004): when notification-kinds.yaml changes after this seed
 * has shipped, move it to the next number in the range of the agent changing it, delete the old seed's
 * drift test (the new seed's test replaces it) and keep the old seed as history. Each seed is a complete
 * idempotent upsert, so the latest one decides the rows. 1360 was the first; 1368 adds the quiet-hours
 * bypass list (ADR 0033 decision 35); 1369 adds A79's org lifecycle kinds (A79's range runs before 1367, which
 * creates the bypass table the seed fills), 1387 the Subprocessor List emails (A82, Section 14.4), 1489 the
 * automations category and kinds (A91, ADR 0047, never applied anywhere: its kinds moved into 1569) and 1569 the
 * account notices of recovery codes and signed-out sessions (A99, ADR 0055), with A89's marketplace match and
 * expiry reminders and A90's marketplace moderation kinds (1473); A89's and A90's own seeds never merged, so 1569
 * carries their kinds. 1620 applies the owner decisions of 2026-10-23: shift.assigned, account.security_changed and
 * access.break_glass_started join the bypass list (ADR 0033 decision 62), and report.delivered reaches only the Inbox and a
 * push (ADR 0033 decision 77). 1639 adds the reported content kinds (ADR 0033 decision 57, 1630) and carries 1620's.
 * 2201 adds offer.sent (A127, ADR 0086), the offer that waits on the applicant, and carries 1639's.
 */
export const NOTIFICATION_KIND_SEED_MIGRATION =
  "supabase/migrations/2201_notification_kind_seed.sql";

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
  readonly bypass: string[][];
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
    bypass: registry.kinds.flatMap((k) =>
      k.quietHoursBypass === null
        ? []
        : [
            [
              literal(k.kind),
              k.quietHoursBypass.startsWithinHours === null
                ? "null::interval"
                : `interval '${k.quietHoursBypass.startsWithinHours} hours'`,
            ],
          ],
    ),
  };
}

/**
 * The channel rows of each kind that names its own channels, for the channels it leaves out: a kind seeded on every
 * channel before it named fewer (report.delivered, ADR 0033 decision 77) would otherwise keep the rows of the others.
 */
function narrowedChannelsSql(registry: NotificationKindRegistry): string {
  const narrowed = registry.kinds.filter((k) => k.channels.length < registry.channels.length);
  if (narrowed.length === 0) return "";
  const where = narrowed
    .map(
      (k) =>
        `(kind = ${literal(k.kind)} and channel not in (${k.channels.map(literal).join(", ")}))`,
    )
    .join("\n   or ");
  return `
-- Channels a kind that names its own channels does not reach ---------------

delete from private.notification_templates
where ${where};
`;
}

/** The bypass list as SQL: replaced as a set, since only the registry writes it. */
function bypassSql(bypass: readonly (readonly string[])[]): string {
  if (bypass.length === 0) return "delete from private.notification_quiet_hours_bypass;\n";
  return `delete from private.notification_quiet_hours_bypass
where kind not in (${bypass.map((b) => b[0]).join(", ")});

insert into private.notification_quiet_hours_bypass (kind, starts_within) values
${valuesBlock(bypass)}
on conflict (kind) do update set starts_within = excluded.starts_within;
`;
}

/**
 * Renders the seed migration: an upsert of every channel default, email template, category and
 * kind-by-channel row. Output is a pure function of the registry. It deletes only what the registry alone
 * writes: the bypass list, replaced as a set, and the rows of a declared kind on a channel it no longer
 * reaches. A row of a kind the registry does not name (for example a kind another branch added in SQL)
 * stays, and the drift test fails on it until the kind is added to notification-kinds.yaml.
 */
export function renderNotificationSeedSql(registry: NotificationKindRegistry): string {
  const r = rows(registry);
  return `-- ${fileName(NOTIFICATION_KIND_SEED_MIGRATION)}
-- Generated from packages/schemas/notification-kinds.yaml by
-- \`pnpm --filter @xos/schemas generate:notifications\`. Never edit by hand: the
-- @xos/schemas unit tests fail when this file differs from the generator output.
--
-- Notification kind registry version ${registry.version} (Section 3.15, A65-021): ${r.channels.length} channel defaults,
-- ${r.templates.length} email templates, ${r.categories.length} categories, ${registry.kinds.length} kinds (${r.kinds.length} kind and channel rows),
-- ${r.bypass.length} kinds that bypass quiet hours (ADR 0033 decision 35).
-- Upserts the reference rows of 0520. Rows of kinds the registry does not name are left in place and fail the
-- drift test (${fileName(NOTIFICATION_KIND_DRIFT_TEST)}); a kind that names its own channels loses the rows of
-- the others, and the quiet-hours bypass list is replaced as a set.

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
${narrowedChannelsSql(registry)}
-- Kinds that bypass quiet hours (replaced as a set) -------------------------

${bypassSql(r.bypass)}
comment on table private.notification_templates is 'Which category each notification kind belongs to and which email template renders it, seeded from packages/schemas/notification-kinds.yaml (Section 3.15). Copy for every channel comes from the i18n catalogs keyed by kind.';
comment on table private.notification_categories is 'Notification categories a person sets preferences for, by channel, seeded from packages/schemas/notification-kinds.yaml. Urgent categories skip the email digest; only the kinds in private.notification_quiet_hours_bypass skip quiet hours (ADR 0033 decision 35). Labels come from the i18n catalogs keyed by code.';
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
-- the channel defaults, email templates, categories, kinds and quiet-hours bypass list the registry declares.
-- A kind added in SQL without the registry, or a registry change without a regenerated seed, fails here.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(5);

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

${
  r.bypass.length === 0
    ? "select is_empty($$select kind from private.notification_quiet_hours_bypass$$, 'no kind bypasses quiet hours');"
    : `select set_eq(
  $$select kind, starts_within from private.notification_quiet_hours_bypass$$,
  $$values
${valuesBlock(r.bypass)}$$,
  'the kinds that bypass quiet hours match notification-kinds.yaml (ADR 0033 decision 35)');`
}

select * from finish();
rollback;
`;
}
