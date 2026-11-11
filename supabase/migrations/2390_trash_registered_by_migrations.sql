-- 2390_trash_registered_by_migrations.sql
--
-- Trash is registered by the migrations, not by the nightly sweep (ADR 0022, 2390-2399; ADR 0110), RRR-193; a fix of
-- A33's 1031. private.sync_trash_tables registers every eligible soft-deletable app table in private.trash_tables, and
-- private.rebuild_trash_items_view regenerates app.trash_items from that list. Migrations called the sync only in
-- 1031, 1032 and 1033; after that it ran only inside private.sweep_default_retention, which pg_cron runs at 03:07 UTC
-- (0930). Thirteen tables made eligible by later migrations therefore reached Trash on production the first night
-- after 4.0 and on a fresh database never, so the catalog after the migrations was not the catalog after a night. One
-- of them, app.osha_cases, put its Confidential description (1385) in app.trash_items as title with no row in
-- private.view_column_sources, so an export of Trash classified it Internal and pgTAP 2030's check of that registry
-- failed whenever the sweep ran during the suite.
--
-- Each of the thirteen, decided from its migration, its retention policy and its delete path:
--   Trash (a deleted row is a mistake a person can undo, and the table's own update policy restores it):
--   * shipments (0351; titled by description since 1180): a project's logistics record, 7 years.
--   * price_books (1170): an org's price book, deleted through the v1 contract's delete, 7 years.
--   * emergency_codes and enumerations (1612): the org's editable copies of the Standard Library. Adopting the
--     library again never brings back a copy the org removed, so Trash is the only way to undo a removal.
--   * earned_media_items (1551): a project's coverage figures, 7 years.
--   Kept out, in private.trash_excluded_tables (their soft-deleted rows are purged by retention exactly as before):
--   * osha_cases (1385): OSHA recordkeeping with health information. Every column is Confidential, only holders of
--     data.restricted.read.medical read it, and 29 CFR 1904.33 sets its retention. Like medical_encounters (1031), a
--     case is corrected by the recordkeeper in the audit trail and never comes back from Trash.
--   * osha_establishments and osha_annual_summaries (1385): the rest of the OSHA record, kept for the same reason;
--     restoring an establishment would also restore the cases deleted with it. The summaries have no title column
--     today and are listed so that adding one never puts them in Trash.
--   * access_review_campaigns (1202): deleting a campaign cancels it, and its guard refuses any change to a deleted
--     campaign, so a restore could never succeed. A new campaign is opened instead.
--   * warehouse_destinations (1401): deleting one destroys its bucket credential in Vault (t91), so a restored
--     destination could not deliver. It is added again with a new credential, as integration connections are.
--   * automations (1480): written only through app.save_automation and app.delete_automation, which keep the owner
--     and plan rules; no one may update the table directly, so Trash could never restore one.
--   * org_ip_allowlist (1201): a removed network is revoked access, changed through the security settings.
--   * chat_message_translations (1363, 1392): derived, cached text; an edit or delete of the message retires it and
--     the next reader translates again.
--   * personal_access_tokens (1432): a revoked token never comes back, as api_keys.
--
-- This migration also makes the registry final and the view safe whatever a later migration adds:
--   * private.trash_title_column (from 1031) never offers a Restricted column (Section 8.3: Restricted values are
--     masked in views), so a table whose only naming columns are Restricted stays out of Trash.
--   * private.trash_table_candidates names the eligible tables (1031's rule, now one function), and
--     private.sync_trash_tables (from 1031) makes private.trash_tables exactly those instead of only adding: a table
--     that is no longer eligible leaves, and a changed title column is updated. It still returns the tables it added.
--   * private.rebuild_trash_items_view (from 1031) registers each Confidential or Restricted title column in
--     private.view_column_sources as the source of app.trash_items.title, so an export of Trash classifies the title
--     as its highest source (2030), and keeps SELECT on the view away from xos_backup (1650).
--   * The sync runs here, so the state after the migrations is the state after the sweep. pgTAP 2390 fails whenever
--     the sync would add, change or remove anything after all migrations: a later migration that makes a table
--     eligible lists it in private.trash_excluded_tables or registers it with the sync itself (ADR 0110).

-- 1. The tables kept out ------------------------------------------------------------------------------------------------

insert into private.trash_excluded_tables (table_name, rationale) values
  ('osha_cases', 'OSHA recordkeeping with health information (29 CFR 1904): Confidential, read only with data.restricted.read.medical, corrected by the recordkeeper in the audit trail, never restored.'),
  ('osha_establishments', 'OSHA recordkeeping (29 CFR 1904), corrected by the recordkeeper; a restore would also bring back the cases deleted with it.'),
  ('osha_annual_summaries', 'OSHA recordkeeping (29 CFR 1904): a certified Form 300A is corrected by the recordkeeper, never restored.'),
  ('access_review_campaigns', 'Deleting a campaign cancels it, and a canceled campaign never changes again; open a new campaign instead.'),
  ('warehouse_destinations', 'Deleting a destination destroys its bucket credential in Vault; add the destination again with a new credential.'),
  ('automations', 'Written only through app.save_automation and app.delete_automation, which keep the owner and plan rules.'),
  ('org_ip_allowlist', 'A removed network is revoked access; the allow-list changes through the security settings.'),
  ('chat_message_translations', 'Derived from its message and cached; an edit or delete of the message retires it.'),
  ('personal_access_tokens', 'A revoked token never comes back.')
on conflict (table_name) do nothing;

comment on table private.trash_excluded_tables is 'Soft-deletable tables kept out of Trash, with why: access, identity, credentials, settings, per-person state, restricted or legally kept records and derived data, whose deletion is not a mistake a person undoes from Trash. A migration that makes a table eligible for Trash and keeps it out lists it here (ADR 0110).';

-- 2. Title columns are never Restricted (from 1031) -------------------------------------------------------------------

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
  where not exists (select 1 from private.column_classifications k
                    where k.table_name = p_table::text and k.column_name = c.name and k.classification = 'Restricted')
  order by c.ord limit 1;
$$;

comment on function private.trash_title_column(regclass) is 'The column Trash shows as a row''s title: the first of title, name, display_name, subject, label, description, justification, invoice_number, po_number, change_order_number, body or code the table has, never a Restricted one (Section 8.3). Null when there is none.';
revoke all on function private.trash_title_column(regclass) from public, anon, authenticated;

-- 3. The view registers its classified titles (from 1031) ---------------------------------------------------------------

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
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.trash_items from xos_backup;
  end if;

  -- The title shows a classified column under another name: name each such source, so an export classifies the title
  -- as its highest source (2030's private.export_column_classification).
  delete from private.view_column_sources s where s.view_name = 'app.trash_items';
  insert into private.view_column_sources (view_name, column_name, source_table, source_column)
  select 'app.trash_items', 'title', k.table_name, k.column_name
  from private.trash_tables tt
  join private.retention_policies r on r.table_name = 'app.' || tt.table_name
  join private.column_classifications k on k.table_name = 'app.' || tt.table_name and k.column_name = tt.title_column
  where k.classification in ('Confidential', 'Restricted');
end;
$$;

comment on function private.rebuild_trash_items_view() is 'Regenerates the security_invoker view app.trash_items as the union of the soft-deleted rows of every table in private.trash_tables, and names each Confidential or Restricted title column in private.view_column_sources as a source of app.trash_items.title.';
revoke all on function private.rebuild_trash_items_view() from public, anon, authenticated;

-- 4. The sync reconciles (from 1031) ----------------------------------------------------------------------------------

-- The tables that belong in Trash, with their title column: 1031's candidates, read by the sync and by pgTAP 2390.
create or replace function private.trash_table_candidates()
returns table (table_name text, title_column text, has_project boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select x.table_name, x.title_column, x.has_project
  from (
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
  ) x
  where x.title_column is not null;
$$;

comment on function private.trash_table_candidates() is 'The app tables whose soft-deleted rows belong in Trash: a uuid id, org_id, updated_by, a Soft Deleted retention policy that purges by Delete, a title column that is not Restricted (private.trash_title_column), and no row in private.trash_excluded_tables. private.sync_trash_tables makes private.trash_tables exactly these.';
revoke all on function private.trash_table_candidates() from public, anon, authenticated;

create or replace function private.sync_trash_tables()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_added integer;
  v_changed integer;
  v_removed integer;
begin
  with gone as (
    delete from private.trash_tables tt
    where tt.table_name not in (select x.table_name from private.trash_table_candidates() x)
    returning 1
  )
  select count(*) into v_removed from gone;
  with changed as (
    update private.trash_tables tt set title_column = x.title_column, has_project = x.has_project
    from private.trash_table_candidates() x
    where x.table_name = tt.table_name and (x.title_column, x.has_project) is distinct from (tt.title_column, tt.has_project)
    returning 1
  )
  select count(*) into v_changed from changed;
  with inserted as (
    insert into private.trash_tables (table_name, title_column, has_project)
    select x.table_name, x.title_column, x.has_project from private.trash_table_candidates() x
    on conflict (table_name) do nothing
    returning 1
  )
  select count(*) into v_added from inserted;
  if v_added > 0 or v_changed > 0 or v_removed > 0 or to_regclass('app.trash_items') is null then
    perform private.rebuild_trash_items_view();
  end if;
  return v_added;
end;
$$;

comment on function private.sync_trash_tables() is 'Makes private.trash_tables exactly private.trash_table_candidates(): adds new tables, updates a changed title column, removes tables no longer eligible (dropped, excluded, without a title column that is not Restricted, or with another retention policy), and regenerates app.trash_items when the list changed. Returns how many tables it added.';
revoke all on function private.sync_trash_tables() from public, anon, authenticated;

-- 5. Register now, so the state after the migrations is the state after the nightly sweep ---------------------------------

select private.sync_trash_tables();
select private.rebuild_trash_items_view();
