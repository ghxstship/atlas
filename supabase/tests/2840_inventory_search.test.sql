-- pgTAP: asset classes and asset units in global search (P7, RRR-221, gap G-290, Section 11.7 Search). Classes match
-- by name and units by tag, class name or serial, under the caller's own row level security: an org-wide reader finds
-- them all, a Field member only the units checked out to them, by tag or serial, and never by a class they cannot
-- read. A tag or serial typed in full matches as a key. Deleted rows never match, and the filters that apply only to
-- records, incidents or documents leave assets out. The world has no assets, and the Standard Library holds none.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(48);

create temporary table r (result_type text, result_id uuid, result_key text, title text, state text, dated_at timestamptz,
  rank real, matched text);
grant select, insert, delete on r to public;

-- Runs a search as a person (with API-key scopes when given) and keeps its rows in r.
create function pg_temp.run(p_user text, p_org text, p_query jsonb, p_scopes text[] default null, p_limit integer default 50)
returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  if p_scopes is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_user || '_user'), 'role', 'authenticated',
      'scopes', to_json(p_scopes), 'amr', json_build_array(json_build_object('method', 'xos_api_key', 'timestamp', 0)))::text, true);
  end if;
  delete from r;
  insert into r select g.result_type, g.result_id, g.result_key, g.title, g.state, g.dated_at, g.rank, g.matched
  from app.global_search(pg_temp.id(p_org), p_query, null, p_limit) g;
  perform pg_temp.as_platform();
end $$;

-- The asset rows of a search, as type:key (or type:title for a class), sorted.
create function pg_temp.inv(p_user text, p_org text, p_query jsonb, p_scopes text[] default null) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.run(p_user, p_org, p_query, p_scopes);
  select string_agg(r.result_type || ':' || coalesce(r.result_key, r.title), ',' order by r.result_type, coalesce(r.result_key, r.title))
  into v from r where r.result_type in ('asset', 'asset_class');
  return coalesce(v, '');
end $$;

create function pg_temp.candidates(p_user text, p_table text, p_org text, p_terms tsquery[], p_keys text[]) returns integer
language plpgsql as $$
declare
  v integer;
begin
  perform pg_temp.as_user(p_user);
  select count(*)::integer into v from app.search_asset_candidates(p_table, pg_temp.id(p_org), p_terms, p_keys);
  perform pg_temp.as_platform();
  return v;
end $$;

-- World: radios and spot fixtures in org_a, one unit checked out to frank (Field on NWL), a generator whose class is
-- deleted, a deleted unit and a unit whose only serial is deleted; a radio in org_b.
select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id) insert into world select 'radio', id from x;
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '5000.02.02-XPMS-003', 'Spot Fixture') returning id) insert into world select 'spot', id from x;
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '5000.06.01-XPMS-004', 'Towable Generator') returning id) insert into world select 'generator', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('radio'), 'RAD-001') returning id) insert into world select 'rad1', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('radio'), 'RAD-002') returning id) insert into world select 'rad2', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('spot'), 'RAD-0011') returning id) insert into world select 'rad11', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('spot'), 'MH-001') returning id) insert into world select 'mh1', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('spot'), 'MH-002') returning id) insert into world select 'mh2', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('spot'), 'MH-003') returning id) insert into world select 'mh3', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('spot'), 'MH-004') returning id) insert into world select 'mh4', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('spot'), 'MH-009') returning id) insert into world select 'mh9', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('generator'), 'GEN-001') returning id) insert into world select 'gen1', id from x;
insert into app.asset_identifiers (asset_unit_id, scheme, value) values
  (pg_temp.id('mh1'), 'serial', 'SPX-48810'),
  (pg_temp.id('mh2'), 'serial', 'SPX-48811'),
  (pg_temp.id('mh3'), 'serial', 'SPX-48812'),
  (pg_temp.id('mh4'), 'serial', 'DEL-77001'),
  (pg_temp.id('rad1'), 'gtin14', '09501101530003');
insert into app.asset_custody (asset_unit_id, custodian_membership_id) values (pg_temp.id('mh2'), pg_temp.id('frank@org_a'));
select pg_temp.as_user('xavier');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_b'), '9000.03.01-XPMS-003', 'Digital Two-Way Radio') returning id) insert into world select 'radio_b', id from x;
insert into app.asset_units (asset_class_id, asset_tag) values (pg_temp.id('radio_b'), 'HL-RAD-01');
select pg_temp.as_platform();
update app.asset_classes set deleted_at = now() where id = pg_temp.id('generator');
update app.asset_units set deleted_at = now() where id = pg_temp.id('mh9');
update app.asset_identifiers set deleted_at = now() where asset_unit_id = pg_temp.id('mh4');
-- Each unit changed a second before the one listed before it, and RAD-002 90 days ago, so the filter-only order and
-- the recency factor can be seen.
alter table app.asset_units disable trigger t90_stamp_audit_columns;
update app.asset_units u set updated_at = now() - interval '1 second' * o.n
from (values ('rad1', 1), ('rad11', 2), ('mh1', 3), ('mh2', 4), ('mh3', 5), ('mh4', 6), ('gen1', 7)) o(k, n)
where u.id = pg_temp.id(o.k);
update app.asset_units set updated_at = now() - interval '90 days' where id = pg_temp.id('rad2');
alter table app.asset_units enable trigger t90_stamp_audit_columns;

-- The functions ------------------------------------------------------------------------------------------------------
select is((select prosecdef from pg_proc where oid = 'app.global_search(uuid, jsonb, extensions.vector, integer, real)'::regprocedure),
  false, 'app.global_search stays SECURITY INVOKER');
select ok(not has_function_privilege('anon', 'app.global_search(uuid, jsonb, extensions.vector, integer, real)', 'execute'),
  'anon cannot run app.global_search');
select ok(has_function_privilege('authenticated', 'app.global_search(uuid, jsonb, extensions.vector, integer, real)', 'execute'),
  'a signed-in person can');
select is((select prosecdef from pg_proc where oid = 'app.search_asset_candidates(text, uuid, tsquery[], text[], integer)'::regprocedure),
  true, 'app.search_asset_candidates runs as definer');
select is((select proconfig from pg_proc where oid = 'app.search_asset_candidates(text, uuid, tsquery[], text[], integer)'::regprocedure),
  array['search_path=""'], 'with an empty search_path');
select ok(not has_function_privilege('anon', 'app.search_asset_candidates(text, uuid, tsquery[], text[], integer)', 'execute'),
  'anon cannot run app.search_asset_candidates');
select is(pg_temp.candidates('carol', 'asset_units', 'org_a', array[to_tsquery('simple', 'rad:*')], '{}'), 3,
  'a reader''s unit candidates match the tag as a prefix');
select is(pg_temp.candidates('carol', 'records', 'org_a', array[to_tsquery('simple', 'rad:*')], '{}'), 0,
  'candidates are offered for asset classes and asset units only');
select is(pg_temp.candidates('carol', 'asset_units', 'org_a', '{}', '{}'), 0, 'and only for something to look for');
select is((select count(*)::integer from app.search_asset_candidates('asset_units', pg_temp.id('org_a'), array[to_tsquery('simple', 'rad:*')], '{}')),
  0, 'a signed-out caller gets none');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.search_asset_candidates('asset_units', pg_temp.id('org_a'), array[to_tsquery('simple', 'rad:*')], '{}')$$,
  '42501', null, 'a non-member is refused');
select throws_ok($$select * from app.global_search(pg_temp.id('org_a'), '{"terms": ["radio"]}')$$, '42501', null,
  'and so is their search of the org');
select pg_temp.as_platform();

-- An org-wide reader -------------------------------------------------------------------------------------------------
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"]}'), 'asset:RAD-001,asset:RAD-002,asset_class:Digital Two-Way Radio',
  'a class name finds the class and its units');
select is((select title || ' / ' || state from r where result_key = 'RAD-001'), 'Digital Two-Way Radio / Proposed',
  'a unit is titled by its class and carries its tag as the key and its asset state');
select is((select count(*)::integer from r where result_type in ('asset', 'asset_class') and (rank <= 0 or rank > 1)), 0,
  'every asset rank is in (0, 1]');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["RAD-001"]}'), 'asset:RAD-001,asset:RAD-0011',
  'a key-shaped tag finds that unit, and the longer tag it starts');
select is((select matched from r where result_key = 'RAD-001'), 'key', 'the tag typed in full matches as a key');
select ok((select rank from r where result_key = 'RAD-001') > (select max(rank) from r where result_type = 'asset' and result_key <> 'RAD-001'),
  'and ranks above every other asset hit');
select ok(abs((select rank from r where result_key = 'RAD-001') - 1.0) < 0.001, 'a key match changed today ranks 1.0 times the recency factor');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["spx-48812"]}'), 'asset:MH-003', 'a serial typed in full finds its unit, in any case');
select is((select matched from r where result_key = 'MH-003'), 'key', 'and matches as a key');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["RAD-00"]}'), 'asset:RAD-001,asset:RAD-0011,asset:RAD-002',
  'a tag prefix finds the units it starts');
select is((select string_agg(distinct matched, ',') from r where result_type = 'asset'), 'text', 'as a text match');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio", "RAD-001"]}'), 'asset:RAD-001',
  'words split across the class name and the tag find exactly that unit');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "exclude_terms": ["digital"]}'), '',
  'a minus word in the class name leaves out the class and its units');
select is(pg_temp.inv('carol', 'org_a', '{"phrases": ["two-way radio"]}'), 'asset:RAD-001,asset:RAD-002,asset_class:Digital Two-Way Radio',
  'a phrase matches the class name');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["spx"]}'), 'asset:MH-001,asset:MH-002,asset:MH-003', 'a serial matches as a word too');

-- Deleted rows -------------------------------------------------------------------------------------------------------
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["towable"]}'), '', 'a deleted class is not found, nor its units by its name');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["GEN-001"]}'), 'asset:GEN-001', 'a unit of a deleted class is still found by its tag');
select is((select title from r where result_key = 'GEN-001'), 'GEN-001', 'and is titled by its tag');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["MH-009"]}'), '', 'a deleted unit is never found');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["DEL-77001"]}'), '', 'nor a unit by its deleted serial, as a key or a word');

-- Filters ------------------------------------------------------------------------------------------------------------
select pg_temp.run('carol', 'org_a', '{"terms": ["radio"], "types": ["asset_class"]}');
select is((select string_agg(result_type || ':' || title, ',') from r), 'asset_class:Digital Two-Way Radio', 'type: asset class returns only classes');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "exclude_types": ["asset"]}'), 'asset_class:Digital Two-Way Radio',
  '-type: asset leaves the units out');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "kinds": ["Task"]}')
  || pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "statuses": ["open"]}')
  || pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "projects": ["NWL"]}')
  || pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "assignees": ["me"]}')
  || pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "is": ["open"]}'), '',
  'a kind, status, project, assignee or is:open filter leaves assets out');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "is": ["archived"]}'), '', 'is:archived leaves assets out: they are not archivable');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "before": "0"}'), 'asset:RAD-002',
  'before:today leaves out what changed today, the class and RAD-001');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "before": "-30"}'), 'asset:RAD-002', 'and keeps what changed before');
select is(pg_temp.inv('carol', 'org_a', '{"terms": ["radio"], "after": "-30"}'), 'asset:RAD-001,asset_class:Digital Two-Way Radio',
  'after: keeps what changed since');
select pg_temp.run('carol', 'org_a', '{"types": ["asset"]}', null, 3);
select is((select string_agg(result_key, ',' order by result_key) from r), 'MH-001,RAD-001,RAD-0011',
  'type:asset alone lists the readable units, newest first, at most the limit (RAD-002 changed 90 days ago)');
select is((select string_agg(distinct matched, ',') from r), 'filter', 'as filter matches');
select pg_temp.run('carol', 'org_a', '{"types": ["asset"], "before": "-30"}');
select ok(abs((select rank from r where result_key = 'RAD-002') - 0.5 * (0.7 + 0.3 * exp(-2.0))) < 0.002,
  'a filter match ranks 0.5 times the 45-day recency factor');

-- A Field member reads assets at assigned reach ------------------------------------------------------------------------
select is(pg_temp.inv('frank', 'org_a', '{"terms": ["MH-002"]}') || ' ' || pg_temp.inv('frank', 'org_a', '{"terms": ["SPX-48811"]}'),
  'asset:MH-002 asset:MH-002', 'a Field member finds the unit checked out to them by tag and by serial');
select is((select title from r where result_key = 'MH-002'), 'MH-002', 'titled by its tag: they cannot read its class');
select is(pg_temp.inv('frank', 'org_a', '{"terms": ["spot"]}'), '', 'they get no class, and do not find their unit by the class name');
select is(pg_temp.inv('frank', 'org_a', '{"terms": ["MH-003"]}') || pg_temp.inv('frank', 'org_a', '{"terms": ["SPX-48812"]}')
  || pg_temp.inv('frank', 'org_a', '{"terms": ["MH"]}'), 'asset:MH-002',
  'and no unit that is not assigned to them, by tag or serial');

-- No read, another org -----------------------------------------------------------------------------------------------
select is(pg_temp.inv('gina', 'org_a', '{"terms": ["radio"]}', array['crew']) || pg_temp.inv('gina', 'org_a', '{"terms": ["MH-002"]}', array['crew']),
  '', 'a session without assets.asset.read (an API key without the assets scope) gets no asset or class');
select is(pg_temp.inv('xavier', 'org_b', '{"terms": ["radio"]}'), 'asset:HL-RAD-01,asset_class:Digital Two-Way Radio',
  'a member of org_b finds only org_b''s inventory');

select * from finish();
rollback;
