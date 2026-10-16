-- pgTAP: A22 RLS regression, cross-tenant updates and deletes (RRR-41, Section 18 gate 4).
-- For every app table with org_id that holds another tenant's rows, another org's Owner changes and
-- removes none of them. Each statement runs in its own subtransaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 9901_security_world.psql

select plan(2);

-- Rows a statement touched, rolled back either way; a refusal counts as zero.
create function pg_temp.rows_touched(p_sql text) returns bigint
language plpgsql as $$
declare
  v_rows bigint;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    raise exception using errcode = 'ZZ001', message = v_rows::text;
  exception
    when sqlstate 'ZZ001' then return sqlerrm::bigint;
    when others then return 0;
  end;
end $$;

-- Tables in which a person's statement touched another tenant's rows.
create function pg_temp.changed_victim_tables(p_who text, p_template text) returns setof text
language plpgsql as $$
declare
  t record;
begin
  for t in select rel from security_targets where sample is not null loop
    perform pg_temp.as_user(p_who);
    if pg_temp.rows_touched(format(p_template, t.rel, pg_temp.id('org_b'))) > 0 then
      perform pg_temp.as_platform();
      return next t.rel;
    end if;
  end loop;
  perform pg_temp.as_platform();
end $$;

select is_empty($$select pg_temp.changed_victim_tables('xavier', 'update %s set org_id = org_id where org_id <> %L')$$,
  'another org''s Owner updates no other tenant''s row in any app table');

select is_empty($$select pg_temp.changed_victim_tables('xavier', 'delete from %s where org_id <> %L')$$,
  'another org''s Owner deletes no other tenant''s row in any app table');

select * from finish();
rollback;
