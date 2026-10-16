-- pgTAP: A22 RLS regression, cross-tenant inserts (RRR-41, Section 18 gate 4, ADR 0002).
-- For every app table with org_id that holds another tenant's rows, another org's Owner cannot
-- insert a copy of one of those rows under a new id. The copy keeps the victim's org_id and parent
-- references, so the policy, the derived org_id trigger or the cross-org reference trigger must
-- refuse it. Each insert runs in its own subtransaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 9901_security_world.psql

select plan(1);

-- True when the insert succeeded; always rolled back.
create function pg_temp.insert_lands(p_rel text, p_row jsonb) returns boolean
language plpgsql as $$
begin
  begin
    execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', p_rel, p_rel) using p_row;
    raise exception using errcode = 'ZZ001', message = 'landed';
  exception
    when sqlstate 'ZZ001' then return true;
    when others then return false;
  end;
end $$;

create function pg_temp.inserted_victim_tables(p_who text) returns setof text
language plpgsql as $$
declare
  t record;
  v_row jsonb;
begin
  for t in select rel, has_id, sample from security_targets where sample is not null loop
    v_row := case when t.has_id then t.sample || jsonb_build_object('id', gen_random_uuid()) else t.sample end;
    perform pg_temp.as_user(p_who);
    if pg_temp.insert_lands(t.rel, v_row) then
      perform pg_temp.as_platform();
      return next t.rel;
    end if;
  end loop;
  perform pg_temp.as_platform();
end $$;

select is_empty($$select pg_temp.inserted_victim_tables('xavier')$$,
  'another org''s Owner inserts no row into another tenant in any app table');

select * from finish();
rollback;
