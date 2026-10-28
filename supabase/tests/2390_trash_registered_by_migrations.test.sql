-- pgTAP: migration 2390, Trash registered by the migrations (ADR 0110, RRR-193). After all migrations the sync and the
-- nightly sweep change nothing, so a later migration that makes a table eligible for Trash must register or exclude it
-- (this suite fails at once instead of the night the sweep runs). The thirteen tables 2390 decided are in or out of
-- Trash as it says; no title is Restricted; a Confidential title is named in private.view_column_sources, so 2030's
-- registry check holds after a sync; the sync reconciles a changed or ineligible table; production's registrations of
-- the excluded tables leave Trash; and retention still purges their soft-deleted rows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

-- The views that read a Confidential or Restricted column under another name without naming it (2030's check).
create function pg_temp.unnamed_classified_sources() returns setof text
language sql as $$
  select distinct v.oid::regclass::text
  from private.column_classifications c
  join pg_attribute b on b.attrelid = to_regclass(c.table_name) and b.attname = c.column_name
  join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = b.attrelid and d.refobjsubid = b.attnum and d.classid = 'pg_rewrite'::regclass
  join pg_rewrite r on r.oid = d.objid
  join pg_class v on v.oid = r.ev_class and v.oid <> b.attrelid
  join pg_namespace n on n.oid = v.relnamespace and n.nspname = 'app'
  where c.classification in ('Confidential', 'Restricted')
    and not exists (select 1 from pg_attribute a where a.attrelid = v.oid and a.attname = c.column_name and not a.attisdropped)
    and not exists (select 1 from private.view_column_sources s where s.view_name = v.oid::regclass::text
                    and s.source_table = c.table_name and s.source_column = c.column_name)
$$;

-- After all migrations nothing is left for the sweep -------------------------------------------------------------------

create temporary table trash_before as select * from private.trash_tables;
create temporary table trash_view_before as select pg_get_viewdef('app.trash_items'::regclass) as def;

select is(private.sync_trash_tables(), 0,
  'after all migrations the sync adds no table: a migration that makes a table eligible for Trash registers or excludes it');
select is_empty($$(select * from private.trash_tables except select * from trash_before) union all (select * from trash_before except select * from private.trash_tables)$$,
  'and changes or removes none');
select results_eq($$select table_name, title_column, has_project from private.trash_table_candidates() order by 1$$,
  $$select table_name, title_column, has_project from private.trash_tables order by 1$$,
  'the registry is exactly the eligible tables');
select is(private.sweep_default_retention(), 0, 'the nightly sweep adds no retention policy either');
select is_empty($$(select * from private.trash_tables except select * from trash_before) union all (select * from trash_before except select * from private.trash_tables)$$,
  'so the registry after the migrations is the registry after the sweep');
select is(pg_get_viewdef('app.trash_items'::regclass), (select def from trash_view_before), 'and app.trash_items is the same view');

-- The decisions of 2390 ------------------------------------------------------------------------------------------------

select results_eq($$select table_name || ':' || title_column from private.trash_tables
    where table_name in ('shipments', 'price_books', 'emergency_codes', 'enumerations', 'earned_media_items') order by 1$$,
  $$values ('earned_media_items:title'), ('emergency_codes:label'), ('enumerations:label'), ('price_books:name'), ('shipments:description')$$,
  'shipments, price books, the Standard Library copies and earned media reach Trash');
select is((select count(*)::int from private.trash_excluded_tables where table_name in ('osha_cases', 'osha_establishments',
    'osha_annual_summaries', 'access_review_campaigns', 'warehouse_destinations', 'automations', 'org_ip_allowlist',
    'chat_message_translations', 'personal_access_tokens')), 9, 'OSHA records, access reviews, warehouse destinations, automations, the IP allow-list, chat translations and personal tokens are kept out, each with why');
select is_empty($$select table_name from private.trash_tables where table_name in (select table_name from private.trash_excluded_tables)$$,
  'no excluded table is in Trash');
select ok(pg_get_viewdef('app.trash_items'::regclass) not like '%osha_cases%', 'app.trash_items no longer reads OSHA cases');

-- Classified titles ------------------------------------------------------------------------------------------------------

select is_empty($$select t.table_name from private.trash_tables t join private.column_classifications k
    on k.table_name = 'app.' || t.table_name and k.column_name = t.title_column where k.classification = 'Restricted'$$,
  'no Trash title is a Restricted column');
select is_empty($$select t.table_name from private.trash_tables t join private.column_classifications k
    on k.table_name = 'app.' || t.table_name and k.column_name = t.title_column
    where k.classification in ('Confidential', 'Restricted')
      and not exists (select 1 from private.view_column_sources s where s.view_name = 'app.trash_items' and s.column_name = 'title'
                      and s.source_table = k.table_name and s.source_column = k.column_name)$$,
  'every Confidential title is named as a source of app.trash_items.title');
select is_empty('select * from pg_temp.unnamed_classified_sources()',
  'after a sync, every view showing a classified column under another name names it (2030)');
select ok(not has_table_privilege('xos_backup', 'app.trash_items', 'select'), 'the backup login is not granted the view');

-- A new table with a Confidential title reaches Trash with its source named.
create table app.trash_probe_case (id uuid primary key, org_id uuid not null, description text, updated_by uuid, deleted_at timestamptz);
insert into private.column_classifications (table_name, column_name, classification) values ('app.trash_probe_case', 'description', 'Confidential');
select is(private.sweep_default_retention(), 1, 'the sweep gives a new soft-deletable table its retention policy');
select ok(exists (select 1 from private.trash_tables where table_name = 'trash_probe_case' and title_column = 'description')
  and exists (select 1 from private.view_column_sources where view_name = 'app.trash_items' and column_name = 'title'
              and source_table = 'app.trash_probe_case' and source_column = 'description'),
  'and registers it in Trash with its Confidential title named in private.view_column_sources');
select is(private.export_column_classification('app.trash_items'::regclass, 'title'), 'Confidential'::app.data_classification,
  'so an export of Trash classifies the title Confidential');

-- A Restricted column is never a title, and the sync follows a classification that changes.
create table app.trash_probe_secret (id uuid primary key, org_id uuid not null, name text, code text, updated_by uuid, deleted_at timestamptz);
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale)
values ('app.trash_probe_secret', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Probe.');
select is(private.sync_trash_tables(), 1, 'a table titled by an unclassified name is added');
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.trash_probe_secret', 'name', 'Restricted', 'data.restricted.read.payroll');
select private.sync_trash_tables();
select is((select title_column from private.trash_tables where table_name = 'trash_probe_secret'), 'code',
  'once the name is Restricted, the sync titles the table by its next column');
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.trash_probe_secret', 'code', 'Restricted', 'data.restricted.read.payroll');
select private.sync_trash_tables();
select ok(not exists (select 1 from private.trash_tables where table_name = 'trash_probe_secret')
  and pg_get_viewdef('app.trash_items'::regclass) not like '%trash_probe_secret%',
  'and with only Restricted columns to name it, the table leaves Trash');
-- app.trash_items depends on every table in Trash, so a table leaves Trash before it is dropped.
delete from private.retention_policies where table_name in ('app.trash_probe_case', 'app.trash_probe_secret');
select private.sync_trash_tables();
drop table app.trash_probe_case;
drop table app.trash_probe_secret;

-- Production: the sweep registered the excluded tables before 2390 ---------------------------------------------------------

insert into private.trash_tables (table_name, title_column, has_project) values
  ('osha_cases', 'description', false), ('osha_establishments', 'name', false), ('access_review_campaigns', 'name', false),
  ('warehouse_destinations', 'display_name', false), ('automations', 'name', false), ('org_ip_allowlist', 'label', false),
  ('chat_message_translations', 'body', false), ('personal_access_tokens', 'name', false);
select private.rebuild_trash_items_view();
delete from private.view_column_sources where view_name = 'app.trash_items';
select isnt_empty('select * from pg_temp.unnamed_classified_sources()',
  'production''s Trash showed the Confidential OSHA description as title, unnamed');
select is(private.sync_trash_tables(), 0, 'the sync adds nothing there');
select ok(not exists (select 1 from private.trash_tables where table_name in (select table_name from private.trash_excluded_tables))
  and pg_get_viewdef('app.trash_items'::regclass) not like '%osha_cases%'
  and pg_get_viewdef('app.trash_items'::regclass) not like '%personal_access_tokens%',
  'and the excluded tables leave the registry and the view');

-- Retention still purges an excluded table's deleted rows.
insert into app.org_ip_allowlist (org_id, cidr, label) values (pg_temp.id('org_a'), '203.0.113.0/24', 'Old office');
update app.org_ip_allowlist set deleted_at = now() - interval '8 years' where org_id = pg_temp.id('org_a') and label = 'Old office';
select private.purge_table('app.org_ip_allowlist');
select is((select count(*)::int from app.org_ip_allowlist where org_id = pg_temp.id('org_a') and label = 'Old office'), 0,
  'retention purges a deleted IP allow-list entry past its period, out of Trash as before');

select * from finish();
rollback;
