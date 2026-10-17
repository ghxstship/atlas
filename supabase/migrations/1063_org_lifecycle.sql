-- 1063_org_lifecycle.sql
-- A36 Account lifecycle: cancellation (Section 14.7, Section 14.8):
--   * org_cancellations: an Owner cancels the org by typing its name and a reason. The subscription ends,
--     the org is read-only for 30 days with a full export available, and its data is due for deletion at
--     day 90. Within the 30 days the Owner may reactivate it on the Access plan.
--   * read-only: while an org is canceled, a row trigger on every app tenant table refuses any write a
--     person makes to its rows; workers and retention still write, and a short reviewed list of tables
--     (the lifecycle tables, trigger-filled ledgers, notifications) stays writable.
--   * app.org_export_tables lists every tenant table and the columns the caller may select, so Atlas
--     builds the archive with the caller's own row level security; app.record_org_export logs each export.

create table app.org_cancellations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  reason text not null,
  canceled_at timestamptz not null default now(),
  read_only_until timestamptz not null,
  purge_after timestamptz not null,
  reactivated_at timestamptz,
  reactivated_by uuid references app.people (id),
  constraint org_cancellations_reason_length check (char_length(btrim(reason)) between 1 and 1000),
  constraint org_cancellations_windows check (read_only_until = canceled_at + interval '30 days' and purge_after = canceled_at + interval '90 days'),
  constraint org_cancellations_reactivated check ((reactivated_at is null) = (reactivated_by is null)),
  constraint org_cancellations_reactivated_in_window check (reactivated_at is null or reactivated_at <= read_only_until)
);

call private.install_domain_table('app.org_cancellations');
create unique index org_cancellations_one_live on app.org_cancellations (org_id) where reactivated_at is null and deleted_at is null;
create index org_cancellations_reactivated_by_idx on app.org_cancellations (reactivated_by);

call private.describe('app.org_cancellations', 'An org''s cancellation (Section 14.7): read-only for 30 days with the full export available, data deleted at day 90 with a deletion certificate to the Owner. Written only by app.cancel_organization and app.reactivate_organization.', array[
  'reason', 'Why the org was canceled, in the Owner''s words.',
  'canceled_at', 'When the Owner canceled.',
  'read_only_until', 'End of the 30-day read-only window with the full export.',
  'purge_after', 'Day 90: when the org''s data is deleted.',
  'reactivated_at', 'When the Owner reactivated the org inside the 30 days.',
  'reactivated_by', 'Owner who reactivated it.'
]);

call private.install_policies('app.org_cancellations', $$org_id in (select private.my_org_ids())$$);
call private.install_audit_trail('app.org_cancellations');

create or replace function private.org_read_only(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.org_cancellations c
                 where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null);
$$;

comment on function private.org_read_only(uuid) is 'True while an org is canceled and not reactivated: it is read-only (Section 14.7). Takes the org id as an argument (ADR 0016 rule 14).';
revoke all on function private.org_read_only(uuid) from public, anon;
grant execute on function private.org_read_only(uuid) to authenticated, service_role;

-- Read-only enforcement: every person-made write to a canceled org's tenant rows is refused by a row
-- trigger on each app table with an org_id. The platform (workers, retention) still writes. A few tables
-- stay writable because reading, reactivating and exporting write them: the lifecycle tables, the
-- ledgers that triggers fill, and a person's own notifications.
create table private.read_only_exempt_tables (
  table_name text primary key,
  rationale text not null,
  constraint read_only_exempt_tables_name check (table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint read_only_exempt_tables_rationale check (char_length(btrim(rationale)) between 1 and 300)
);

comment on table private.read_only_exempt_tables is 'App tables a person may still write while their org is canceled and read-only (Section 14.7), with why.';
comment on column private.read_only_exempt_tables.table_name is 'Schema-qualified app table.';
comment on column private.read_only_exempt_tables.rationale is 'Why the table stays writable during the read-only window.';

alter table private.read_only_exempt_tables enable row level security;
revoke all on private.read_only_exempt_tables from public, anon, authenticated;
grant select on private.read_only_exempt_tables to service_role;

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.org_cancellations', 'Reactivating the org writes its cancellation.'),
  ('app.org_exports', 'Taking the full export is logged.'),
  ('app.subscriptions', 'Reactivating starts a subscription.'),
  ('app.subscription_state_transitions', 'Reactivating logs the new subscription.'),
  ('app.audit_events', 'The audit trail records every permitted act.'),
  ('app.activity_events', 'Filled by triggers on permitted acts.'),
  ('app.domain_events', 'Filled by triggers on permitted acts.'),
  ('app.notifications', 'A person still marks their notifications read.'),
  ('app.notification_deliveries', 'Deliveries of notifications already sent.'),
  ('app.file_access_log', 'Downloading files for the export is logged.'),
  ('app.usage_events', 'Metering of permitted acts.'),
  ('app.job_queue', 'Jobs of permitted acts, such as rendering an export.'),
  ('app.export_jobs', 'Exports stay available during the read-only window.'),
  ('app.export_job_columns', 'Columns of an export.');

create or replace function private.refuse_read_only_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'org_id')::uuid;
begin
  if private.current_person_id() is not null and v_org is not null and private.org_read_only(v_org) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.refuse_read_only_org() is 'Refuses a person''s write to a row of a canceled, read-only org (Section 14.7). Workers and retention (no person) still write.';
revoke all on function private.refuse_read_only_org() from public, anon, authenticated;

create or replace procedure private.install_read_only_guard(p_table regclass)
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from private.read_only_exempt_tables e where e.table_name = p_table::text)
     or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = 'org_id' and not a.attisdropped) then
    return;
  end if;
  execute format('drop trigger if exists t15_refuse_read_only_org on %s', p_table);
  execute format(
    'create trigger t15_refuse_read_only_org before insert or update or delete on %s for each row execute function private.refuse_read_only_org()',
    p_table);
end;
$$;

comment on procedure private.install_read_only_guard(regclass) is 'Attaches the read-only guard of canceled orgs to an app table with an org_id, unless the table is exempt.';
revoke all on procedure private.install_read_only_guard(regclass) from public, anon, authenticated;

-- A03's tenant guard installer, unchanged except that new tenant tables get the read-only guard too.
create or replace procedure private.install_tenant_guards(
  p_table regclass,
  p_parent_table text default null,
  p_parent_column text default null,
  p_references text[] default '{}'
)
language plpgsql
set search_path = ''
as $$
declare
  v_args text;
begin
  if p_parent_table is not null then
    execute format('drop trigger if exists t10_derive_org_id on %s', p_table);
    execute format(
      'create trigger t10_derive_org_id before insert or update of %I on %s for each row execute function private.derive_org_id(%L, %L)',
      p_parent_column, p_table, p_parent_table, p_parent_column);
  end if;
  execute format('drop trigger if exists t20_refuse_org_change on %s', p_table);
  execute format(
    'create trigger t20_refuse_org_change before update on %s for each row execute function private.refuse_org_change()',
    p_table);
  if cardinality(p_references) > 0 then
    select string_agg(format('%L', a), ', ') into v_args from unnest(p_references) as a;
    execute format('drop trigger if exists t30_refuse_cross_org_reference on %s', p_table);
    execute format(
      'create trigger t30_refuse_cross_org_reference before insert or update on %s for each row execute function private.refuse_cross_org_reference(%s)',
      p_table, v_args);
  end if;
  call private.install_read_only_guard(p_table);
end;
$$;

do $$
declare
  v_table regclass;
begin
  for v_table in
    select c.oid::regclass from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
  loop
    call private.install_read_only_guard(v_table);
  end loop;
end
$$;

-- Cancel and reactivate ---------------------------------------------------------------------------------------

create or replace function app.cancel_organization(p_org_id uuid, p_confirm_name text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org app.organizations;
  v_sub app.subscriptions;
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.organization.delete') then
    raise exception using errcode = '42501', message = 'org.organization.delete is required';
  end if;
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  if private.org_read_only(p_org_id) then
    perform private.refuse('org_already_canceled', 'This organization is already canceled.');
  end if;
  if p_confirm_name is null or btrim(p_confirm_name) <> v_org.name then
    perform private.refuse('org_name_mismatch', 'Type the organization''s name exactly to confirm.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    perform private.refuse('org_cancel_reason', 'Say why the organization is canceled, in up to 1,000 characters.');
  end if;
  if exists (select 1 from app.organizations c where c.parent_org_id = p_org_id and c.deleted_at is null) then
    perform private.refuse('org_cancel_has_clients', 'A partner with client orgs cannot cancel; move each client to direct billing first.');
  end if;
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null for update;
  if v_sub.id is not null then
    perform private.transition_subscription(v_sub.id, v_sub.subscription_state, 'canceled', 'Canceled by the Owner: ' || left(btrim(p_reason), 400));
  end if;
  insert into app.org_cancellations (org_id, reason, canceled_at, read_only_until, purge_after)
  values (p_org_id, btrim(p_reason), now(), now() + interval '30 days', now() + interval '90 days')
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.cancel_organization(uuid, text, text) is 'Cancels an org (Section 14.7): the Owner (org.organization.delete) types the org name and a reason. The subscription is canceled in the database (the billing service ends any Stripe subscription through its own seam), the org becomes read-only for 30 days with the full export available, and its data is due for deletion at day 90. Refuses a partner that still has client orgs. Returns the cancellation id.';
revoke all on function app.cancel_organization(uuid, text, text) from public, anon;
grant execute on function app.cancel_organization(uuid, text, text) to authenticated, service_role;

create or replace function app.reactivate_organization(p_org_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_cancel app.org_cancellations;
  v_sub uuid;
begin
  if not private.has_capability(p_org_id, 'org.organization.delete') then
    raise exception using errcode = '42501', message = 'org.organization.delete is required';
  end if;
  select * into v_cancel from app.org_cancellations c
  where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null for update;
  if v_cancel.id is null then
    perform private.refuse('org_not_canceled', 'This organization is not canceled.');
  end if;
  if now() > v_cancel.read_only_until then
    perform private.refuse('org_reactivation_window', 'An organization can be reactivated during the 30 days after it was canceled.');
  end if;
  update app.org_cancellations set reactivated_at = now(), reactivated_by = v_person where id = v_cancel.id;
  insert into app.subscriptions (org_id, plan_code, subscription_state) values (p_org_id, 'access', 'active') returning id into v_sub;
  insert into app.subscription_state_transitions (subscription_id, from_state, to_state, reason)
  values (v_sub, null, 'active', 'Reactivated by the Owner after cancellation.');
  return v_cancel.id;
end;
$$;

comment on function app.reactivate_organization(uuid) is 'Reactivates a canceled org within its 30-day read-only window (the Owner, org.organization.delete): writes work again and the org restarts on the Access plan, from which the Owner upgrades through billing. Returns the cancellation id.';
revoke all on function app.reactivate_organization(uuid) from public, anon;
grant execute on function app.reactivate_organization(uuid) to authenticated, service_role;

create or replace function private.guard_org_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id <> old.org_id or new.canceled_at <> old.canceled_at or new.reason <> old.reason
     or (old.reactivated_at is not null and new.reactivated_at is distinct from old.reactivated_at) then
    perform private.refuse('org_cancellation_immutable', 'A cancellation keeps its org, time and reason; it is reactivated once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_org_cancellation() is 'Cancellations keep their org, time and reason, and are reactivated at most once.';
revoke all on function private.guard_org_cancellation() from public, anon, authenticated;

create trigger t40_guard_org_cancellation before update on app.org_cancellations
  for each row execute function private.guard_org_cancellation();

-- Full export ------------------------------------------------------------------------------------------------

create table app.org_exports (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  table_count integer not null,
  row_count bigint not null,
  file_count integer not null,
  manifest_sha256 text not null,
  constraint org_exports_counts check (table_count >= 0 and row_count >= 0 and file_count >= 0),
  constraint org_exports_sha check (manifest_sha256 ~ '^[0-9a-f]{64}$')
);

call private.install_domain_table('app.org_exports', null, null, '{}', true);
call private.describe('app.org_exports', 'Every full export of an org (Section 14.7, Section 14.8): the archive of JSON and CSV for each table, the org''s stored files and a manifest, built with the Owner''s own row level security. Append-only.', array[
  'table_count', 'Tables in the archive.',
  'row_count', 'Rows across every table.',
  'file_count', 'Stored files included.',
  'manifest_sha256', 'SHA-256 of the archive''s manifest.json, so a copy can be checked later.'
]);

call private.install_policies('app.org_exports', $$org_id in (select private.orgs_with_capability('org.organization.delete'))$$);

create or replace function app.can_export_org(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_capability(p_org_id, 'org.organization.delete');
$$;

comment on function app.can_export_org(uuid) is 'True when the signed-in person may take the full export of an org: they hold org.organization.delete there (the Owner).';
revoke all on function app.can_export_org(uuid) from public, anon;
grant execute on function app.can_export_org(uuid) to authenticated, service_role;

create or replace function app.org_export_tables(p_org_id uuid)
returns table (table_name text, columns text[])
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not app.can_export_org(p_org_id) then
    raise exception using errcode = '42501', message = 'org.organization.delete is required';
  end if;
  return query
  select c.relname::text, array_agg(a.attname::text order by a.attnum)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
    and exists (select 1 from pg_catalog.pg_attribute o where o.attrelid = c.oid and o.attname = 'org_id' and not o.attisdropped)
    and has_table_privilege(c.oid, 'SELECT')
    and has_column_privilege(c.oid, a.attnum, 'SELECT')
  group by c.relname
  order by c.relname;
end;
$$;

comment on function app.org_export_tables(uuid) is 'Tables of a full org export (Section 14.7) and, per table, the columns the caller may select (Restricted columns are not), for a holder of org.organization.delete. Atlas reads each table with the caller''s own row level security, filtered to the org.';
revoke all on function app.org_export_tables(uuid) from public, anon;
grant execute on function app.org_export_tables(uuid) to authenticated, service_role;


create or replace function app.record_org_export(p_org_id uuid, p_table_count integer, p_row_count bigint, p_file_count integer, p_manifest_sha256 text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'org.organization.delete') then
    raise exception using errcode = '42501', message = 'org.organization.delete is required';
  end if;
  insert into app.org_exports (org_id, table_count, row_count, file_count, manifest_sha256)
  values (p_org_id, p_table_count, p_row_count, p_file_count, lower(p_manifest_sha256))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_org_export(uuid, integer, bigint, integer, text) is 'Logs a full export the Owner downloaded, with its counts and manifest hash. Returns the export id.';
revoke all on function app.record_org_export(uuid, integer, bigint, integer, text) from public, anon;
grant execute on function app.record_org_export(uuid, integer, bigint, integer, text) to authenticated, service_role;

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.org_cancellations', 'Age', 'created_at', interval '7 years', 'Delete', 'The cancellation and deletion certificate are kept as a compliance record.'),
  ('app.org_exports', 'Age', 'created_at', interval '7 years', 'Delete', 'Exports of tenant data are a compliance record (Section 8.6).');
