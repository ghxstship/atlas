-- pgTAP: global search, recent views and the semantic index (A87, RRR-132, finding A65-005, Section 11.7 Search,
-- Section 5 pgvector). The search reads with the caller's own row level security, the operators narrow it, dates
-- resolve on the org's calendar, recents keep the last 50 per person, and the embedding worker never sees a
-- Restricted column or an org that has semantic search off.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(49);

create temporary table s (key text primary key, id uuid, txt text);
grant select, insert, update on s to public;

create function pg_temp.keys(p_user text, p_org text, p_query jsonb) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.as_user(p_user);
  select string_agg(coalesce(g.result_key, g.title), ',' order by coalesce(g.result_key, g.title)) into v
  from app.global_search(pg_temp.id(p_org), p_query, null, 50) g;
  perform pg_temp.as_platform();
  return coalesce(v, '');
end $$;

-- A unit vector of 1,024 dimensions with a 1 at position p.
create function pg_temp.unit(p integer) returns extensions.vector
language sql immutable as $$
  select ('[' || array_to_string(array(select case when i = p then 1 else 0 end from generate_series(1, 1024) i), ',') || ']')::extensions.vector
$$;

-- World: records in NWL (dave, erin and frank are members) and NWX (no members), an incident, an SOP, a document,
-- and a record in org_b.
select pg_temp.as_user('alice');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Hang the main truss', 'Y', 'Declared') returning id, record_number)
  insert into s select 't1', id, 'NWL-' || record_number from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Focus the wash lights', 'Y', 'Declared') returning id, record_number)
  insert into s select 't2', id, 'NWL-' || record_number from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Permit', 'Special Event Permit', 'Y', 'Declared') returning id, record_number)
  insert into s select 'p1', id, 'NWL-' || record_number from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Inspection', 'Truss Main Bolts', 'Y', 'Declared') returning id, record_number)
  insert into s select 'i1', id, 'NWL-' || record_number from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a2'), 'Task', 'Hang the gala truss', 'Y', 'Declared') returning id, record_number)
  insert into s select 'g1', id, 'NWX-' || record_number from x;
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at)
  values (pg_temp.id('prj_a'), 'Truss Failure at Stage Left', 'ENM-097', now()) returning id, incident_number)
  insert into s select 'inc', id, 'NWL-' || incident_number from x;
update app.records set owner_party_id = pg_temp.id('dave') where id = (select id from s where key = 't2');
select app.transition_record((select id from s where key = 'p1'), 'Proposed', 'Ready', 'Paperwork in');
select app.transition_record((select id from s where key = 'p1'), 'Ready', 'Blocked', 'Waiting on the city', 'City review');
select pg_temp.as_user('carol');
with x as (insert into app.sops (org_id, code, title, body)
  values (pg_temp.id('org_a'), 'SOP-101', 'Working at Height', 'Wear a harness whenever you climb the truss.') returning id)
  insert into s select 'sop', id, 'SOP-101' from x;
update app.sops set published_at = now() where id = (select id from s where key = 'sop');
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Rigging Plan') returning id)
  insert into s select 'doc', id, 'Rigging Plan' from x;
select pg_temp.as_user('xavier');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_b'), 'Task', 'Hang the harbor truss', 'Y', 'Declared');
select pg_temp.as_platform();

-- The search runs as the caller --------------------------------------------------------------------------------------
select is((select prosecdef from pg_proc where oid = 'app.global_search(uuid, jsonb, extensions.vector, integer, real)'::regprocedure),
  false, 'app.global_search is SECURITY INVOKER: it reads with the caller''s own row level security');
select is((select prosecdef from pg_proc where oid = 'app.recent_items(uuid, integer)'::regprocedure),
  false, 'app.recent_items is SECURITY INVOKER too');

select is(pg_temp.keys('alice', 'org_a', '{"terms": ["truss"]}'),
  (select string_agg(txt, ',' order by txt) from s where key in ('t1', 'i1', 'g1', 'inc', 'sop')),
  'the owner finds records of both projects, the incident and the SOP whose text mentions truss, and nothing of org_b');
select is(pg_temp.keys('dave', 'org_a', '{"terms": ["hang"]}'), (select txt from s where key = 't1'),
  'a project member finds the record of their project but not NWX, which they cannot read');
select is(pg_temp.keys('dave', 'org_a', '{"terms": ["har"]}'), 'SOP-101', 'the last word matches as a prefix (har: harness), and org_b''s harbor record stays hidden');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.global_search(pg_temp.id('org_b'), '{"terms": ["truss"]}')$$, '42501', null,
  'searching an org the caller does not belong to is refused');
select pg_temp.as_platform();

-- Operators -----------------------------------------------------------------------------------------------------------
select is(pg_temp.keys('alice', 'org_a', jsonb_build_object('terms', jsonb_build_array((select lower(txt) from s where key = 't2')))),
  (select txt from s where key = 't2'), 'a record key finds that record exactly, whatever its case');
select pg_temp.as_user('alice');
select is((select matched from app.global_search(pg_temp.id('org_a'), jsonb_build_object('terms', jsonb_build_array((select txt from s where key = 't2'))))),
  'key', 'a key match says so');
select pg_temp.as_platform();
select is(pg_temp.keys('alice', 'org_a', '{"phrases": ["main truss"]}'), (select txt from s where key = 't1'),
  'a quoted phrase matches the words in order (Truss Main Bolts does not)');
select is(pg_temp.keys('alice', 'org_a', '{"terms": ["truss"], "exclude_terms": ["main"], "types": ["record"]}'),
  (select txt from s where key = 'g1'), 'a minus word leaves out results that contain it');
select is(pg_temp.keys('alice', 'org_a', '{"terms": ["truss"], "exclude_phrases": ["main truss"], "types": ["record"]}'),
  (select string_agg(txt, ',' order by txt) from s where key in ('i1', 'g1')), 'a minus phrase leaves out only the phrase');
select is(pg_temp.keys('alice', 'org_a', '{"terms": ["truss"], "types": ["incident"]}'), (select txt from s where key = 'inc'),
  'type: narrows to one result type');
select is(pg_temp.keys('alice', 'org_a', '{"terms": ["truss"], "exclude_types": ["record", "sop"]}'), (select txt from s where key = 'inc'),
  '-type: leaves result types out');
select is(pg_temp.keys('alice', 'org_a', '{"kinds": ["permit"]}'), (select txt from s where key = 'p1'),
  'a record kind alone lists the records of that kind');
select is(pg_temp.keys('alice', 'org_a', '{"statuses": ["blocked"]}'), (select txt from s where key = 'p1'),
  'status: matches the record state');
select is(pg_temp.keys('alice', 'org_a', '{"is": ["blocked"]}'), (select txt from s where key = 'p1'), 'is:blocked lists blocked records');
select is(pg_temp.keys('alice', 'org_a', '{"terms": ["truss"], "statuses": ["open"]}'),
  (select string_agg(txt, ',' order by txt) from s where key in ('t1', 'i1', 'g1', 'inc')),
  'status:open keeps open records and incidents and drops types without a state');
select is(pg_temp.keys('alice', 'org_a', '{"kinds": ["permit"], "exclude_statuses": ["blocked"]}'), '',
  '-status: leaves a state out');
select is(pg_temp.keys('dave', 'org_a', '{"assignees": ["me"]}'), (select txt from s where key = 't2'), 'assignee:me lists the caller''s records');
select is(pg_temp.keys('alice', 'org_a', '{"assignees": ["dav"]}'), (select txt from s where key = 't2'),
  'assignee: also takes part of a member''s name');
select is(pg_temp.keys('alice', 'org_a', '{"projects": ["nwx"]}'), (select txt from s where key = 'g1'),
  'project: takes a project key in any case');
select is(pg_temp.keys('alice', 'org_a', '{"terms": ["hang"], "exclude_projects": ["Northwind Winter"]}'), (select txt from s where key = 't1'),
  '-project: takes the start of a project name');

-- Dates resolve on the org's calendar ----------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), 'Pacific/Kiritimati', null, null, false);
select is((select c.org_today from app.search_context(pg_temp.id('org_a')) c), (now() at time zone 'Pacific/Kiritimati')::date,
  'today is the org''s date in its time zone (UTC+14 here), not the UTC date');
-- Due one minute after the org's midnight: today on the org's calendar, yesterday in UTC.
update app.records set due_at = ((now() at time zone 'Pacific/Kiritimati')::date::timestamp at time zone 'Pacific/Kiritimati') + interval '1 minute'
where id = (select id from s where key = 't2');
select pg_temp.as_platform();
select is(pg_temp.keys('alice', 'org_a', '{"due_after": "-1", "due_before": "1"}'), (select txt from s where key = 't2'),
  'due:today finds a record due in the first minute of the org''s day, a day the UTC calendar calls yesterday');
select is(pg_temp.keys('alice', 'org_a', jsonb_build_object('due_before', ((now() at time zone 'Pacific/Kiritimati')::date + 1)::text, 'kinds', jsonb_build_array('task'))),
  (select txt from s where key = 't2'), 'a calendar date bound works the same way as days from today');
select is(pg_temp.keys('alice', 'org_a', '{"before": "0", "types": ["record"]}'), '', 'before:today leaves out what changed today');
select is(pg_temp.keys('alice', 'org_a', '{"after": "-1", "kinds": ["permit"]}'), (select txt from s where key = 'p1'),
  'after:yesterday keeps what changed today');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.global_search(pg_temp.id('org_a'), '{"after": "2026-02-30"}')$$, 'XR001', null,
  'an impossible date is refused with a reason');
select is((select count(*)::integer from app.global_search(pg_temp.id('org_a'), '{"terms": [], "is": []}')), 0,
  'a query with nothing to search for returns nothing (the menu shows recent items)');
select pg_temp.as_platform();

-- Recent views ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select app.record_recent_view(pg_temp.id('org_a'), 'records', (select id from s where key = 't1'));
select app.record_recent_view(pg_temp.id('org_a'), 'incidents', (select id from s where key = 'inc'));
select app.record_recent_view(pg_temp.id('org_a'), 'records', (select id from s where key = 't2'));
select is(app.record_recent_view(pg_temp.id('org_a'), 'records', (select id from s where key = 'g1')), false,
  'a record the person cannot read is not recorded');
select is((select string_agg(coalesce(r.result_key, r.title), ',' order by r.viewed_at desc) from app.recent_items(pg_temp.id('org_a')) r),
  (select string_agg(txt, ',' order by ord) from (values ('t2', 1), ('inc', 2), ('t1', 3)) v (k, ord) join s on s.key = v.k),
  'recent items list what the person opened, newest first');
select app.record_recent_view(pg_temp.id('org_a'), 'records', (select id from s where key = 't1'));
select is((select coalesce(r.result_key, r.title) from app.recent_items(pg_temp.id('org_a')) r limit 1), (select txt from s where key = 't1'),
  'opening it again moves it to the top without a second row');
select is((select count(*)::integer from app.recent_views), 3, 'one row per thing opened');
insert into app.recent_views (org_id, person_id, subject_table, subject_id)
  values (pg_temp.id('org_a'), pg_temp.id('erin'), 'records', (select id from s where key = 'p1'));
select is((select person_id from app.recent_views where subject_id = (select id from s where key = 'p1')), pg_temp.id('dave'),
  'a recent view is always the signed-in person''s own');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.recent_views), 0, 'nobody reads another person''s recent views');
select pg_temp.as_user('alice');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  select pg_temp.id('prj_a'), 'Task', 'Check rigging point ' || n, 'Y', 'Declared' from generate_series(1, 52) n;
select count(app.record_recent_view(pg_temp.id('org_a'), 'records', r.id)) from app.records r where r.title like 'Check rigging point %';
select is((select count(*)::integer from app.recent_views), 50, 'at most the last 50 are kept');
select pg_temp.as_platform();
select is((select retention from private.retention_policies where table_name = 'app.recent_views'), interval '90 days',
  'recent views go after 90 days');
update app.people set deleted_at = now() where id = pg_temp.id('dave');
select is((select count(*)::integer from app.recent_views where person_id = pg_temp.id('dave')), 0,
  'deleting a person deletes everything they opened');
update app.people set deleted_at = null where id = pg_temp.id('dave');

-- The semantic index ----------------------------------------------------------------------------------------------------
select is((select count(*)::integer from app.search_embedding_backlog('local-hash', 'local-hash-1024', 50) b where b.org_id = pg_temp.id('org_a')), 0,
  'nothing is offered for embedding while the org has search.semantic_enabled off');
select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'search.semantic_enabled', 'Organization', pg_temp.id('org_a'), null, true, null, false);
select pg_temp.as_platform();
select is((select string_agg(b.source_table, ',' order by b.source_table) from app.search_embedding_backlog('local-hash', 'local-hash-1024', 50) b
           where b.org_id = pg_temp.id('org_a')), 'documents,sops', 'with it on, the published SOP and the document are offered');
insert into private.column_classifications (table_name, column_name, classification, read_capability)
  values ('app.sops', 'body', 'Restricted', 'knowledge.sop.write')
  on conflict do nothing;
select is((select b.content from app.search_embedding_backlog('local-hash', 'local-hash-1024', 50) b where b.source_id = (select id from s where key = 'sop')),
  'Working at Height', 'a column classified Restricted never reaches the embedding provider');
delete from private.column_classifications where table_name = 'app.sops' and column_name = 'body' and classification = 'Restricted';
update s set txt = (select b.content_sha256 from app.search_embedding_backlog('local-hash', 'local-hash-1024', 50) b where b.source_id = s.id) where key = 'sop';
select throws_ok(format($$select app.store_search_embedding('sops', %L, %L, 'local-hash', 'local-hash-1024', pg_temp.unit(1))$$,
  (select id from s where key = 'sop'), repeat('0', 64)), 'XR001', null, 'a vector for text that has since changed is refused');
select lives_ok(format($$select app.store_search_embedding('sops', %L, %L, 'local-hash', 'local-hash-1024', pg_temp.unit(1))$$,
  (select id from s where key = 'sop'), (select txt from s where key = 'sop')), 'the worker stores the vector of the current text');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.search_embedding_backlog('local-hash', 'local-hash-1024', 5)$$, '42501', null,
  'only the service role reads the embedding backlog');
select is((select count(*)::integer from app.global_search(pg_temp.id('org_a'), '{"terms": ["climbing"], "model": "local-hash-1024"}', pg_temp.unit(1)) g
           where g.result_type = 'sop' and g.matched = 'semantic'), 1,
  'a nearby vector finds the SOP although no word matches, blended into the same results');
select is((select count(*)::integer from app.global_search(pg_temp.id('org_a'), '{"terms": ["climbing"], "model": "other-model"}', pg_temp.unit(1))), 0,
  'vectors of another model are never compared');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.search_embeddings), 0, 'an embedding is readable only by people who can read its source');
select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'search.semantic_enabled', 'Organization', pg_temp.id('org_a'), null, false, null, false);
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.global_search(pg_temp.id('org_a'), '{"terms": ["climbing"]}', pg_temp.unit(1))), 0,
  'with semantic search turned off the vector is ignored');
select pg_temp.as_platform();
select is(app.retire_search_embeddings(), 1, 'turning it off retires the org''s vectors on the next worker pass');

select * from finish();
rollback;
