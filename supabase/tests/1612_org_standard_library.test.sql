-- pgTAP: migration 1612, finding A65-027 (Section 7.2). A new org receives an editable copy of the XOS Standard
-- Library, each row naming its standard source; an existing org adopts it with the "Adopt Standard Library" action;
-- adopting again changes nothing and never overwrites an org's edits. Emergency codes are org data in numeric order.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(30);

create function pg_temp.status(p_org uuid) returns table (library text, standard_count integer, adopted_count integer)
language sql as $$ select * from app.standard_library_status(p_org) $$;

-- A new org receives its copy ------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world values ('new_org', app.create_organization('Lantern Works', 'lantern-works'));
select is(
  (select string_agg(library, ', ' order by library) from pg_temp.status(pg_temp.id('new_org')) where adopted_count <> standard_count),
  null, 'a new org holds a copy of every Standard Library row');
select is((select count(*)::int from pg_temp.status(pg_temp.id('new_org'))), 10, 'all ten Standard Library tables are reported');
select is((select count(*)::int from app.emergency_codes where org_id = pg_temp.id('new_org')), 14, 'the 14 emergency codes are copied');
select is(
  (select string_agg(code, ', ' order by sort_order, code) from (select code, sort_order from app.emergency_codes
    where org_id = pg_temp.id('new_org') and deleted_at is null order by sort_order limit 3) c),
  'CODE_RED, CODE_ORANGE, CODE_YELLOW', 'emergency codes keep the canon order as numbers');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('new_org') and std_sop_id is not null and published_at is null), 34,
  'the 34 SOPs arrive as drafts naming their standard SOP');
select is((select count(*)::int from app.sops s join xpms.std_sop x on x.sop_id = s.std_sop_id
  where s.org_id = pg_temp.id('new_org') and s.title = x.title and strpos(s.body, x.procedure_step_1) > 0), 34,
  'each SOP carries its title and procedure steps');
select is((select count(*)::int from app.verbiage_terms where org_id = pg_temp.id('new_org') and std_verbiage_id is not null and definition like '%.'), 213,
  'the 213 verbiage terms are copied with sentence definitions');
select is((select count(*)::int from app.documents where org_id = pg_temp.id('new_org') and std_document_id is not null and project_id is null), 34,
  'the 34 library documents are org documents naming their source');
select is((select count(*)::int from app.vendor_class_entitlements e join app.vendor_classes c on c.id = e.vendor_class_id
  where c.org_id = pg_temp.id('new_org') and c.std_vendor_class_id is not null), 59, 'the 59 vendor entitlements hang off the org''s vendor class copies');
select is((select count(distinct rate_card_id)::int from app.rate_card_lines where org_id = pg_temp.id('new_org') and canon_rate_card_id is not null), 1,
  'the standard labor rates are one org rate card');
select is((select count(*)::int from app.radio_channel_plan where org_id = pg_temp.id('new_org')), 32, 'the 32 radio channels form the org''s radio plan');
select is((select count(*)::int from app.enumerations where org_id = pg_temp.id('new_org')), 91, 'the 91 enumeration values are copied');
select is((select count(*)::int from app.role_library where org_id = pg_temp.id('new_org')), 35, 'the 35 Roles Library roles are copied');

-- The copies are the org's to edit ----------------------------------------------------------------------------------
update app.emergency_codes set label = 'Fire Alarm', sort_order = 20 where org_id = pg_temp.id('new_org') and code = 'CODE_RED';
select is((select label from app.emergency_codes where org_id = pg_temp.id('new_org') and code = 'CODE_RED'), 'Fire Alarm',
  'the Owner relabels an emergency code');
select is((select code from app.emergency_codes where org_id = pg_temp.id('new_org') and deleted_at is null order by sort_order, code limit 1),
  'CODE_ORANGE', 'and reorders it by number');
update app.sops set title = 'Rigging Inspection' where org_id = pg_temp.id('new_org') and std_sop_id = 'SOP-001';
update app.verbiage_terms set deleted_at = now() where org_id = pg_temp.id('new_org') and std_verbiage_id = 'VRB-001';
select is((select label from xpms.emergency_code where code = 'CODE_RED'), 'Code Red', 'canon keeps its own label');

-- Adopting again changes nothing ------------------------------------------------------------------------------------
create temporary table before_counts as select library, adopted_count from pg_temp.status(pg_temp.id('new_org'));
grant select on before_counts to public;
select is(
  (select string_agg(key || '=' || value, ', ') from jsonb_each_text(app.adopt_standard_library(pg_temp.id('new_org'))) where value <> '0'),
  null, 'adopting again copies nothing');
select is(
  (select count(*)::int from pg_temp.status(pg_temp.id('new_org')) s join before_counts b using (library) where s.adopted_count <> b.adopted_count),
  0, 'every library holds the same rows as before');
select is((select label from app.emergency_codes where org_id = pg_temp.id('new_org') and code = 'CODE_RED'), 'Fire Alarm',
  'an edited emergency code keeps the org''s label');
select is((select title from app.sops where org_id = pg_temp.id('new_org') and std_sop_id = 'SOP-001'), 'Rigging Inspection',
  'an edited SOP keeps the org''s title');
select ok((select deleted_at is not null from app.verbiage_terms where org_id = pg_temp.id('new_org') and std_verbiage_id = 'VRB-001'),
  'a removed term stays removed');
select is((select count(*)::int from app.verbiage_terms where org_id = pg_temp.id('new_org') and std_verbiage_id = 'VRB-001'), 1,
  'and is not copied again');

-- An existing org adopts with the action ----------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world values ('demo_owner_user', '01920000-0000-7000-8000-000000000101'), ('demo', '01920000-0000-7000-8000-000000000001');
select pg_temp.as_user('demo_owner');
select is((select adopted_count from pg_temp.status(pg_temp.id('demo')) where library = 'emergency_codes'), 0,
  'an org created before the Standard Library was copied holds no emergency codes');
select is((app.adopt_standard_library(pg_temp.id('demo')) ->> 'emergency_codes')::int, 14, 'the action copies them');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('demo') and std_sop_id is null), 4, 'the org''s own SOPs stay as they were');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('demo') and std_sop_id is not null), 34,
  'every standard SOP is copied, a used code taking the next free one');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('demo') and deleted_at is null)
  - (select count(distinct code)::int from app.sops where org_id = pg_temp.id('demo') and deleted_at is null), 0, 'no SOP code is used twice');
select is(
  (select string_agg(key || '=' || value, ', ') from jsonb_each_text(app.adopt_standard_library(pg_temp.id('demo'))) where value <> '0'),
  null, 'adopting twice changes nothing');

-- Only the people who may change the org's canon extensions adopt ---------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.adopt_standard_library((select id from world where key = 'org_a'))$$, '42501', null,
  'a Member cannot adopt the Standard Library');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.standard_library_status((select id from world where key = 'org_a'))$$, '42501', null,
  'another org''s Owner cannot read the status');

select * from finish();
rollback;
