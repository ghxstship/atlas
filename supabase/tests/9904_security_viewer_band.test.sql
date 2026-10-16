-- pgTAP: A22 RLS regression, the Viewer role band (RRR-41, Section 8, Section 4.5.9, gate 4).
-- A Viewer reads within granted scopes and writes nothing. For every app table with org_id that
-- holds a Northwind row, gina (Viewer of Northwind Live) changes, removes and copies none of them.
-- Each statement runs in its own subtransaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 9901_security_world.psql

select plan(3);

create function pg_temp.lands(p_sql text, p_row jsonb) returns boolean
language plpgsql as $$
declare
  v_rows bigint;
begin
  begin
    execute p_sql using p_row;
    get diagnostics v_rows = row_count;
    raise exception using errcode = 'ZZ001', message = v_rows::text;
  exception
    when sqlstate 'ZZ001' then return sqlerrm::bigint > 0;
    when others then return false;
  end;
end $$;

create function pg_temp.viewer_writes(p_kind text) returns setof text
language plpgsql as $$
declare
  t record;
  v_sql text;
  v_row jsonb;
begin
  for t in select rel, has_id, own_sample from security_targets
           where own_sample is not null loop
    v_row := case when t.has_id then t.own_sample || jsonb_build_object('id', gen_random_uuid()) else t.own_sample end;
    v_sql := case p_kind
      when 'update' then format('update %s set org_id = org_id where org_id = %L', t.rel, pg_temp.id('org_a'))
      when 'delete' then format('delete from %s where org_id = %L', t.rel, pg_temp.id('org_a'))
      else format('insert into %s select * from jsonb_populate_record(null::%s, $1)', t.rel, t.rel) end;
    perform pg_temp.as_user('gina');
    if pg_temp.lands(v_sql, v_row) then
      perform pg_temp.as_platform();
      return next t.rel;
    end if;
  end loop;
  perform pg_temp.as_platform();
end $$;

select is_empty($$select pg_temp.viewer_writes('update')$$, 'a Viewer updates no Northwind row');
select is_empty($$select pg_temp.viewer_writes('delete')$$, 'a Viewer deletes no Northwind row');
select is_empty($$select pg_temp.viewer_writes('insert')$$, 'a Viewer inserts no copy of a Northwind row');

select * from finish();
rollback;
