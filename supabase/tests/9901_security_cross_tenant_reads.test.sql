-- pgTAP: A22 RLS regression, cross-tenant reads (RRR-41, Section 9, Section 18 gate 4).
-- Every app table with org_id is generated from the catalog. A person outside Northwind Live
-- (another org's Owner, or a person with no org) reads no row of another tenant.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 9901_security_world.psql

select plan(4);

-- Tables in which a person sees a row owned by an org other than Harbor Lights.
create function pg_temp.visible_victim_tables(p_who text) returns setof text
language plpgsql as $$
declare
  t record;
  v bigint;
begin
  perform pg_temp.as_user(p_who);
  for t in select rel from security_targets where sample is not null loop
    execute format('select count(*) from %s where org_id <> %L', t.rel, pg_temp.id('org_b')) into v;
    if v > 0 then
      return next t.rel;
    end if;
  end loop;
  perform pg_temp.as_platform();
end $$;

select cmp_ok((select count(*)::integer from security_targets where sample is not null), '>=', 15,
  'the suite covers at least 15 tables that hold another tenant''s rows');

select is_empty($$select pg_temp.visible_victim_tables('xavier')$$,
  'another org''s Owner reads no other tenant''s row in any app table');

select is_empty($$select pg_temp.visible_victim_tables('nina')$$,
  'a person with no organization reads no tenant row in any app table');

select pg_temp.as_anon();
select throws_ok($$select count(*) from app.projects$$, '42501', null,
  'anon cannot reach the app schema at all');

select * from finish();
rollback;
