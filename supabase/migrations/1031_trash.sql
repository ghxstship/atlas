-- 1031_trash.sql
-- A33 Platform workflow (RRR-77). Trash (Section 4.10 Records: "Delete moves it to Trash, which can be
-- restored for the retention period"; Section 7 Records: "trash_items (view over soft-deleted rows,
-- not a copy)").
--
--   * private.trash_tables lists the tables whose soft-deleted rows appear in Trash: every app table
--     with an id, a deleted_at column, a Soft Deleted retention policy that purges by row, and a
--     column that names the row (title, name, description and so on). Identity, access, credential
--     and setting tables are never listed: ending a membership or revoking a key is not a deletion a
--     person undoes from Trash.
--   * app.trash_items is a security_invoker view over those tables, regenerated whenever the list
--     changes. Each reader sees only the deleted rows their own row level security lets them read.
--     purge_after is the deletion time plus the table's retention period; the nightly purge job
--     (private.purge_expired_rows, 0500) removes rows after it, so Trash and the purge agree.
--   * app.restore_trash_item restores a row as the caller: the table's update policy and guards
--     decide, exactly as for any edit. Rows of tables that reference it and were deleted in the same
--     statement (the same deleted_at) are restored with it.
--   * The retention sweep (private.sweep_default_retention, 0930) is extended, not forked: after it
--     gives new tables their retention policy it registers new trash tables and regenerates the view,
--     so a table added by a later migration reaches Trash the next night.

create table private.trash_tables (
  table_name text primary key,
  title_column text not null,
  has_project boolean not null,
  constraint trash_tables_name_format check (table_name ~ '^[a-z][a-z0-9_]*$'),
  constraint trash_tables_title_format check (title_column ~ '^[a-z][a-z0-9_]*$')
);

comment on table private.trash_tables is 'Tables whose soft-deleted rows appear in Trash (app.trash_items), with the column that names a row. Maintained by private.sync_trash_tables.';
comment on column private.trash_tables.table_name is 'Table in the app schema, without the schema.';
comment on column private.trash_tables.title_column is 'Column shown as the row''s title in Trash.';
comment on column private.trash_tables.has_project is 'True when the table has a project_id column.';

alter table private.trash_tables enable row level security;
revoke all on private.trash_tables from public, anon, authenticated;
grant select on private.trash_tables to service_role;

create table private.trash_excluded_tables (
  table_name text primary key,
  rationale text not null,
  constraint trash_excluded_tables_rationale check (char_length(btrim(rationale)) between 1 and 300)
);

comment on table private.trash_excluded_tables is 'Soft-deletable tables kept out of Trash, with why: access, identity, credentials, settings and per-person state, whose deletion means revocation, not a mistake to undo.';
comment on column private.trash_excluded_tables.table_name is 'Table in the app schema, without the schema.';
comment on column private.trash_excluded_tables.rationale is 'Why its rows never appear in Trash.';

alter table private.trash_excluded_tables enable row level security;
revoke all on private.trash_excluded_tables from public, anon, authenticated;
grant select on private.trash_excluded_tables to service_role;

insert into private.trash_excluded_tables (table_name, rationale)
select t, r from (values
  ('organizations', 'Organizations end through the account lifecycle (Section 14.7).'),
  ('people', 'People end through the account lifecycle (Section 14.7).'),
  ('subscriptions', 'Billing state, managed by the billing service.'),
  ('legal_holds', 'Releasing a hold is recorded, never undone from Trash.'),
  ('consent_records', 'Consent is withdrawn, never restored by someone else.'),
  ('memberships', 'An ended membership is revoked access.'),
  ('membership_roles', 'A removed role is revoked access.'),
  ('roles', 'Roles change through the roles settings.'),
  ('role_capabilities', 'Capabilities change through the roles settings.'),
  ('workspace_members', 'Removing a member is revoked access.'),
  ('team_members', 'Removing a member is revoked access.'),
  ('user_capability_grants', 'A removed grant is revoked access.'),
  ('record_grants', 'A removed grant is revoked access.'),
  ('delegations', 'An ended delegation is revoked authority.'),
  ('account_memberships', 'An ended membership is revoked access.'),
  ('account_membership_roles', 'A removed role is revoked access.'),
  ('spend_authorities', 'A removed limit is revoked authority.'),
  ('api_keys', 'A revoked key never comes back.'),
  ('service_accounts', 'A removed service account is revoked access.'),
  ('oauth_apps', 'A removed app is revoked access.'),
  ('oauth_grants', 'A revoked grant is revoked access.'),
  ('identity_providers', 'Single sign-on changes through the security settings.'),
  ('scim_group_mappings', 'Provisioning changes through the security settings.'),
  ('scim_identities', 'Provisioned identities follow the identity provider.'),
  ('kiosk_pins', 'A replaced PIN is a credential and never comes back.'),
  ('calendar_feeds', 'A revoked feed token never comes back.'),
  ('inbound_addresses', 'A removed address is a revoked credential.'),
  ('webhook_endpoints', 'Webhooks change through the webhook settings.'),
  ('webhook_endpoint_events', 'Webhooks change through the webhook settings.'),
  ('integration_connections', 'Connections are removed through the integration settings.'),
  ('stripe_subscription_links', 'Billing state, managed by the billing service.'),
  ('payout_accounts', 'Restricted banking data; replaced, never restored.'),
  ('vendor_bank_accounts', 'Restricted banking data; replaced, never restored.'),
  ('tax_forms', 'Restricted tax data; replaced, never restored.'),
  ('background_checks', 'Restricted screening data; never restored.'),
  ('medical_encounters', 'Restricted medical data; never restored.'),
  ('setting_values', 'A cleared setting falls back to its default; set it again instead.'),
  ('personal_setting_values', 'A cleared setting falls back to its default; set it again instead.'),
  ('org_domains', 'Domains change through the white label settings.'),
  ('org_module_states', 'Modules change through the modules settings.'),
  ('notification_preferences', 'Per-person preference state.'),
  ('notification_settings', 'Per-person preference state.'),
  ('push_subscriptions', 'Per-device state.'),
  ('suppression_list', 'Deliverability state, managed by the email service.'),
  ('feature_flag_overrides', 'Platform flags, managed by the platform team.'),
  ('tour_progress', 'Per-person state.'),
  ('tip_dismissals', 'Per-person state.'),
  ('favorites', 'Per-person state.'),
  ('thread_reads', 'Per-person state.'),
  ('ai_settings', 'Settings change through the AI settings.'),
  ('approval_instances', 'Approvals are withdrawn through app.cancel_approval, never deleted.')
) as x (t, r);

-- The title column a table offers, in order of preference.
create or replace function private.trash_title_column(p_table regclass)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.name from unnest(array['title', 'name', 'display_name', 'subject', 'label', 'description',
    'justification', 'invoice_number', 'po_number', 'change_order_number', 'body', 'code']) with ordinality as c (name, ord)
  join pg_catalog.pg_attribute a on a.attrelid = p_table and a.attname = c.name and not a.attisdropped
  order by c.ord limit 1;
$$;

comment on function private.trash_title_column(regclass) is 'The column Trash shows as a row''s title: the first of title, name, display_name, subject, label, description, justification, invoice_number, po_number, change_order_number, body or code the table has.';
revoke all on function private.trash_title_column(regclass) from public, anon, authenticated;

-- Regenerates app.trash_items from private.trash_tables.
create or replace function private.rebuild_trash_items_view()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sql text;
begin
  select string_agg(format(
    $f$select 'urn:xpms:%1$s:' || t.id::text as subject_urn, %2$L::text as subject_table, t.id as subject_id,
      t.org_id, %3$s as project_id, left(t.%4$I::text, 200) as title, t.deleted_at, t.updated_by as deleted_by,
      t.deleted_at + %5$L::interval as purge_after
    from app.%1$I t where t.deleted_at is not null$f$,
    tt.table_name, tt.table_name,
    case when tt.has_project then 't.project_id' else 'null::uuid' end,
    tt.title_column, r.retention), E'\nunion all\n' order by tt.table_name)
  into v_sql
  from private.trash_tables tt
  join private.retention_policies r on r.table_name = 'app.' || tt.table_name;

  if v_sql is null then
    v_sql := 'select null::text as subject_urn, null::text as subject_table, null::uuid as subject_id, null::uuid as org_id, '
      || 'null::uuid as project_id, null::text as title, null::timestamptz as deleted_at, null::uuid as deleted_by, '
      || 'null::timestamptz as purge_after where false';
  end if;
  execute 'create or replace view app.trash_items with (security_invoker = true) as ' || v_sql;
  comment on view app.trash_items is 'Trash (Section 4.10): soft-deleted rows of the tables in private.trash_tables, read with the reader''s own row level security. A view over the rows, never a copy. Restore through app.restore_trash_item until purge_after.';
  comment on column app.trash_items.subject_urn is 'urn:xpms:{table}:{id} of the deleted row.';
  comment on column app.trash_items.subject_table is 'Table of the deleted row.';
  comment on column app.trash_items.subject_id is 'Id of the deleted row.';
  comment on column app.trash_items.org_id is 'Org of the deleted row.';
  comment on column app.trash_items.project_id is 'Project of the deleted row, when its table has one.';
  comment on column app.trash_items.title is 'What the row is called, from its title column.';
  comment on column app.trash_items.deleted_at is 'When it was deleted.';
  comment on column app.trash_items.deleted_by is 'Person who deleted it (the last writer).';
  comment on column app.trash_items.purge_after is 'When the retention purge removes it for good; it can be restored until then.';
  revoke all on app.trash_items from public, anon;
  grant select on app.trash_items to authenticated, service_role;
end;
$$;

comment on function private.rebuild_trash_items_view() is 'Regenerates the security_invoker view app.trash_items as the union of the soft-deleted rows of every table in private.trash_tables.';
revoke all on function private.rebuild_trash_items_view() from public, anon, authenticated;

-- Registers new trash tables and regenerates the view when the list changed. Returns the tables added.
create or replace function private.sync_trash_tables()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_added integer;
  v_removed integer;
begin
  with candidates as (
    select c.relname::text as table_name, private.trash_title_column(c.oid::regclass) as title_column,
      exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'project_id' and not a.attisdropped) as has_project
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join private.retention_policies r on r.table_name = 'app.' || c.relname
    where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
      and r.basis = 'Soft Deleted' and r.purge_method = 'Delete'
      and c.relname not in (select e.table_name from private.trash_excluded_tables e)
      and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and not a.attisdropped
                  and a.atttypid = 'uuid'::regtype)
      and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
      and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'updated_by' and not a.attisdropped)
  ), inserted as (
    insert into private.trash_tables (table_name, title_column, has_project)
    select x.table_name, x.title_column, x.has_project from candidates x where x.title_column is not null
    on conflict (table_name) do nothing
    returning 1
  )
  select count(*) into v_added from inserted;
  with gone as (
    delete from private.trash_tables tt
    where to_regclass('app.' || tt.table_name) is null
       or tt.table_name in (select e.table_name from private.trash_excluded_tables e)
    returning 1
  )
  select count(*) into v_removed from gone;
  if v_added > 0 or v_removed > 0 or to_regclass('app.trash_items') is null then
    perform private.rebuild_trash_items_view();
  end if;
  return v_added;
end;
$$;

comment on function private.sync_trash_tables() is 'Adds every eligible soft-deletable table to private.trash_tables, drops tables that no longer exist or were excluded, and regenerates app.trash_items when the list changed. Returns how many tables it added.';
revoke all on function private.sync_trash_tables() from public, anon, authenticated;

-- The 0930 sweep, extended: retention policies first, then Trash.
create or replace function private.sweep_default_retention()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table regclass;
  v_count integer := 0;
begin
  for v_table in
    select c.oid::regclass
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
      and format('app.%s', c.relname) not in (select r.table_name from private.retention_policies r)
      and (
        exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and t.tgname = 't95_append_only')
        or exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'deleted_at' and not a.attisdropped)
      )
  loop
    call private.install_default_retention(v_table);
    v_count := v_count + 1;
  end loop;
  perform private.sync_trash_tables();
  return v_count;
end;
$$;

comment on function private.sweep_default_retention() is 'Gives every app ledger and soft-deletable table without a retention policy the default policy (ADR 0002), then registers new Trash tables and regenerates app.trash_items (A33). Runs once at migration time and nightly before the retention job, and returns how many policies it added.';

revoke all on function private.sweep_default_retention() from public, anon, authenticated;

-- Restore ----------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('trash.restored', 'trash_items', 'A deleted row was restored from Trash.')
on conflict (code) do nothing;

create or replace function app.trash_restore_terms(p_subject_table text)
returns table (table_name text, has_project boolean, retention interval)
language sql
stable
security definer
set search_path = ''
as $$
  select tt.table_name, tt.has_project, r.retention
  from private.trash_tables tt
  join private.retention_policies r on r.table_name = 'app.' || tt.table_name
  where tt.table_name = p_subject_table;
$$;

comment on function app.trash_restore_terms(text) is 'Whether a table''s rows are restored from Trash, whether it has a project column, and how long its deleted rows stay restorable. No row when the table is not in Trash.';
revoke all on function app.trash_restore_terms(text) from public, anon;
grant execute on function app.trash_restore_terms(text) to authenticated, service_role;

create or replace function app.record_trash_restore(p_subject_table text, p_subject_id uuid, p_restored integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_has_project boolean := (select tt.has_project from private.trash_tables tt where tt.table_name = p_subject_table);
  v_org uuid;
  v_project uuid;
  v_by uuid;
  v_deleted timestamptz;
  v_updated timestamptz;
begin
  if v_has_project is null then
    perform private.refuse('trash_not_restorable', 'Rows of this table are not restored from Trash.');
  end if;
  execute format('select org_id, %s, updated_by, deleted_at, updated_at from app.%I where id = $1',
    case when v_has_project then 'project_id' else 'null::uuid' end, p_subject_table)
    into v_org, v_project, v_by, v_deleted, v_updated using p_subject_id;
  if v_org is null or v_deleted is not null or v_by is distinct from private.current_person_id()
     or v_updated is distinct from now() then
    perform private.refuse('trash_restore_unconfirmed', 'A restore is recorded only by the person who restored the row, in the same transaction.');
  end if;
  perform private.emit_event(v_org, 'trash.restored', p_subject_table, p_subject_id, v_project,
    jsonb_build_object('subject_table', p_subject_table, 'rows_restored', p_restored));
end;
$$;

comment on function app.record_trash_restore(text, uuid, integer) is 'Emits trash.restored for a row the signed-in person restored in this transaction (the row is live, they are its last writer and it changed now). Called by app.restore_trash_item.';
revoke all on function app.record_trash_restore(text, uuid, integer) from public, anon;
grant execute on function app.record_trash_restore(text, uuid, integer) to authenticated, service_role;

create or replace function app.restore_trash_item(p_subject_table text, p_subject_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_terms record;
  v_deleted timestamptz;
  v_restored integer;
  v_queue_tables text[];
  v_queue_ids uuid[];
  v_depths integer[];
  v_table text;
  v_id uuid;
  v_depth integer;
  v_fk record;
  v_child uuid;
  v_total integer := 1;
  i integer := 1;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_terms from app.trash_restore_terms(p_subject_table);
  if v_terms.table_name is null then
    raise exception using errcode = 'XR001', hint = 'trash_not_restorable',
      message = format('trash_not_restorable: Rows of %s are not restored from Trash.', coalesce(p_subject_table, 'that table'));
  end if;
  execute format('select deleted_at from app.%I where id = $1', v_terms.table_name) into v_deleted using p_subject_id;
  get diagnostics v_restored = row_count;
  if v_restored = 0 then
    raise exception using errcode = '42501', message = 'the row is not visible to you';
  end if;
  if v_deleted is null then
    raise exception using errcode = 'XR001', hint = 'trash_not_deleted', message = 'trash_not_deleted: This row is not in Trash.';
  end if;
  if v_deleted + v_terms.retention < now() then
    raise exception using errcode = 'XR001', hint = 'trash_restore_expired',
      message = 'trash_restore_expired: Its retention period has ended; it is about to be purged and cannot be restored.';
  end if;
  execute format('update app.%I set deleted_at = null where id = $1 and deleted_at is not null', v_terms.table_name)
    using p_subject_id;
  get diagnostics v_restored = row_count;
  if v_restored = 0 then
    raise exception using errcode = '42501', message = 'you cannot edit this row, so you cannot restore it';
  end if;

  -- Rows that reference it and were deleted in the same statement come back with it, three levels deep.
  v_queue_tables := array[v_terms.table_name];
  v_queue_ids := array[p_subject_id];
  v_depths := array[1];
  while i <= cardinality(v_queue_ids) loop
    v_table := v_queue_tables[i];
    v_id := v_queue_ids[i];
    v_depth := v_depths[i];
    i := i + 1;
    continue when v_depth > 3;
    for v_fk in
      select cl.relname::text as child_table, a.attname::text as child_column
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class cl on cl.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
      where k.contype = 'f' and k.confrelid = format('app.%I', v_table)::regclass and cardinality(k.conkey) = 1
        and n.nspname = 'app' and a.attname not in ('created_by', 'updated_by')
        and exists (select 1 from pg_catalog.pg_attribute d where d.attrelid = k.conrelid and d.attname = 'deleted_at' and not d.attisdropped)
        and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = k.conrelid and x.attname = 'id' and not x.attisdropped)
    loop
      for v_child in execute format('update app.%I set deleted_at = null where %I = $1 and deleted_at = $2 returning id',
        v_fk.child_table, v_fk.child_column) using v_id, v_deleted
      loop
        v_total := v_total + 1;
        v_queue_tables := v_queue_tables || v_fk.child_table;
        v_queue_ids := v_queue_ids || v_child;
        v_depths := v_depths || (v_depth + 1);
      end loop;
    end loop;
  end loop;

  perform app.record_trash_restore(v_terms.table_name, p_subject_id, v_total);
  return v_total;
end;
$$;

comment on function app.restore_trash_item(text, uuid) is 'Restores a soft-deleted row from Trash as the caller, so the table''s update policy and guards decide; refuses a table not in Trash, a live row and a row past its retention period. Rows that reference it and were deleted with it (the same deleted_at) are restored too, three levels deep. Emits trash.restored. Returns how many rows were restored.';
revoke all on function app.restore_trash_item(text, uuid) from public, anon;
grant execute on function app.restore_trash_item(text, uuid) to authenticated, service_role;

-- Register today's tables and build the view.
select private.sync_trash_tables();
