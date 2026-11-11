-- pgTAP: export rows in one value (2360; A102, RRR-146). app.export_job_rows returns one jsonb array, not a set:
-- PostgREST caps a set-returning function at max_rows (1,000), which cut every larger export to 1,000 rows without a
-- truncation note. An export of 1,200 rows reads all 1,200, the worker's limit + 1 still tells it the file is cut,
-- the rows keep the sort order, an empty export reads an empty array, and the function stays the service role's alone.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

create temporary table k (key text primary key, id uuid);
grant select, insert, update on k to public;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

-- The shape PostgREST sees ------------------------------------------------------------------------------------------
select is((select proretset from pg_catalog.pg_proc where oid = 'app.export_job_rows(uuid, integer)'::regprocedure), false,
  'export rows are not a set, so PostgREST''s max_rows never cuts them');
select is(pg_catalog.pg_get_function_result('app.export_job_rows(uuid, integer)'::regprocedure), 'jsonb',
  'they come back as one jsonb array');
select is((select provolatile::text || ':' || prosecdef::text from pg_catalog.pg_proc where oid = 'app.export_job_rows(uuid, integer)'::regprocedure),
  's:false', 'still stable, so a read replica serves it, and security invoker');
select ok(has_function_privilege('service_role', 'app.export_job_rows(uuid, integer)', 'execute')
  and not has_function_privilege('authenticated', 'app.export_job_rows(uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'app.export_job_rows(uuid, integer)', 'execute'),
  'only the service role reads export rows');

-- An export of more than 1,000 rows ---------------------------------------------------------------------------------
-- 1,200 venues of org_a in Bulk Town; one of org_b in Bulk Town too.
select pg_temp.as_user('alice');
insert into app.venues (org_id, name, locality, jurisdiction_id, time_zone)
select pg_temp.id('org_a'), format('Bulk Venue %s', lpad(g::text, 4, '0')), 'Bulk Town', 'US-FL-MIAMI-DADE', 'America/New_York'
from generate_series(1, 1200) g;
select pg_temp.as_user('xavier');
insert into app.venues (org_id, name, locality, jurisdiction_id, time_zone)
values (pg_temp.id('org_b'), 'Bulk Venue 0000', 'Bulk Town', 'US-FL-MIAMI-DADE', 'America/New_York');

select pg_temp.as_user('dave');
insert into k values ('bulk', app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues',
  array['app.venues.name', 'app.venues.locality'], array['Venue', 'City'],
  '[{"operator":"eq","column":"locality","value":"Bulk Town"}]'::jsonb));
insert into k values ('none', app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name'], null,
  '[{"operator":"eq","column":"locality","value":"Nowhere"}]'::jsonb));
select pg_temp.as_worker();
select is((select count(*)::int from app.claim_export_renders('worker-1', 5) c where c.export_job_id in (select id from k)),
  2, 'the worker claims both exports');

select is(jsonb_array_length(app.export_job_rows((select id from k where key = 'bulk'), 50001)), 1200,
  'all 1,200 rows of the requester''s org come back in one call');
select is(jsonb_array_length(app.export_job_rows((select id from k where key = 'bulk'), 1001)), 1001,
  'a limit of 1,001 reads 1,001 rows, so the worker knows a 1,000-row file is cut');
select is(app.export_job_rows((select id from k where key = 'bulk'), 1) -> 0,
  '{"name": "Bulk Venue 0001", "locality": "Bulk Town"}'::jsonb, 'each row carries the exported columns');
select ok((select bool_and(r.e ->> 'name' >= coalesce(lag, '')) from (
    select e, lag(e ->> 'name') over (order by n) as lag
    from jsonb_array_elements(app.export_job_rows((select id from k where key = 'bulk'), 50001)) with ordinality as x (e, n)) r),
  'the rows keep the sort order of the exported columns');
select is(app.export_job_rows((select id from k where key = 'bulk'), 50001) -> -1,
  '{"name": "Bulk Venue 1200", "locality": "Bulk Town"}'::jsonb, 'the last row is the last in that order, never org_b''s venue');
select is(app.export_job_rows((select id from k where key = 'none'), 50001), '[]'::jsonb,
  'an export with no rows reads an empty array, never null');
select is(current_user::text, 'service_role', 'the worker gets its own role back after reading');

select * from finish();
rollback;
