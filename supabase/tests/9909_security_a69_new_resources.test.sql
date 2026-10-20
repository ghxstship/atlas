-- pgTAP: A69 security review (RRR-114). The generic cross-tenant suites (9901 to 9903) test only tables that hold a
-- victim row in the shared world, and the resources added since the A22 review held none: legal entities, the IP
-- allow-list, access reviews, break-glass, project shares and price books. This suite gives each a Northwind row and
-- checks that another org's Owner (xavier) and a person with no org (nina) read, change and delete none of them, that
-- the RPCs built on them refuse Northwind's ids, and that a share's partner can read the share but never change it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

-- Northwind (org_a) rows, written as the platform.
select pg_temp.as_platform();
insert into app.price_books (org_id, name, currency_code) values (pg_temp.id('org_a'), 'Standard Client Rates', 'USD');
insert into app.org_legal_entities (org_id, legal_name, country_code, fiscal_year_start_month, base_currency)
values (pg_temp.id('org_a'), 'Northwind Live LLC', 'US', 1, 'USD');
insert into world select 'le', id from app.org_legal_entities where legal_name = 'Northwind Live LLC';
insert into app.org_ip_allowlist (org_id, cidr, label) values (pg_temp.id('org_a'), '203.0.113.0/24', 'Office');
insert into app.access_review_campaigns (org_id, name, due_on) values (pg_temp.id('org_a'), 'Q4 Access Review', current_date + 14);
insert into app.break_glass_sessions (org_id, person_id, reason, started_at, expires_at)
values (pg_temp.id('org_a'), pg_temp.id('alice'), 'Payroll export failed during show day and must run now.', now(), now() + interval '1 hour');
insert into world select 'bg', id from app.break_glass_sessions where person_id = pg_temp.id('alice');
insert into app.project_shares (project_id, partner_organization_id, project_role)
values (pg_temp.id('prj_a'), pg_temp.id('org_p'), 'Field Supervisor');
insert into world select 'share', id from app.project_shares where project_id = pg_temp.id('prj_a');
insert into app.project_share_scope_nodes (project_share_id, scope_node_id) values (pg_temp.id('share'), pg_temp.id('show_a'));

create temporary table a69_targets (rel text primary key);
insert into a69_targets values ('app.price_books'), ('app.org_legal_entities'), ('app.org_ip_allowlist'),
  ('app.access_review_campaigns'), ('app.access_review_items'), ('app.break_glass_sessions'), ('app.project_shares'),
  ('app.project_share_scope_nodes');
grant select on a69_targets to public;

select is((select count(*)::int from a69_targets t
  where exists (select 1 from pg_class c where c.oid = t.rel::regclass)), 8, 'the eight resources exist');

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

-- Resources where the person reads, or a statement of theirs touches, a Northwind row.
create function pg_temp.reached(p_who text, p_template text) returns setof text
language plpgsql as $$
declare
  t record;
  v bigint;
begin
  for t in select rel from a69_targets order by rel loop
    perform pg_temp.as_user(p_who);
    if p_template = 'read' then
      execute format('select count(*) from %s where org_id = %L', t.rel, pg_temp.id('org_a')) into v;
    else
      v := pg_temp.rows_touched(format(p_template, t.rel, pg_temp.id('org_a')));
    end if;
    perform pg_temp.as_platform();
    if v > 0 then
      return next t.rel;
    end if;
  end loop;
end $$;

select pg_temp.as_platform();
select is_empty($$select rel from a69_targets t where not exists (
  select 1 from pg_class c where c.oid = t.rel::regclass and c.relrowsecurity)$$, 'row level security is on for all of them');
select is((select count(*)::int from app.access_review_items where org_id = pg_temp.id('org_a')) > 0, true,
  'the campaign opened items for Northwind''s roles');

-- Policy helpers run as the caller. One without EXECUTE for authenticated made every read of its table fail
-- (private.visible_project_share_ids, granted in 1298).
select is_empty($$
  select distinct p.schemaname || '.' || p.tablename || ' ' || m[1]
  from pg_policies p, regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), 'private\.([a-z_0-9]+)\(', 'g') m
  where p.schemaname in ('app', 'api_external', 'xpms') and ('authenticated' = any (p.roles) or 'public' = any (p.roles))
    and not exists (select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
                    where n.nspname = 'private' and f.proname = m[1] and has_function_privilege('authenticated', f.oid, 'execute'))
$$, 'every private helper a policy calls is executable by authenticated');

select is_empty($$select pg_temp.reached('xavier', 'read')$$, 'another org''s Owner reads none of them');
select is_empty($$select pg_temp.reached('nina', 'read')$$, 'a person with no org reads none of them');
select is_empty($$select pg_temp.reached('xavier', 'update %s set org_id = org_id where org_id = %L')$$,
  'another org''s Owner changes none of them');
select is_empty($$select pg_temp.reached('xavier', 'update %s set deleted_at = now() where org_id = %L')$$,
  'another org''s Owner soft-deletes none of them');
select is_empty($$select pg_temp.reached('xavier', 'delete from %s where org_id = %L')$$,
  'another org''s Owner deletes none of them');

-- The RPCs, given Northwind's ids by another org's Owner.
select pg_temp.as_user('xavier');
select throws_ok($$select app.end_break_glass((select id from world where key = 'bg'))$$, '42501', null,
  'another org cannot end Northwind''s break-glass session');
select throws_ok($$select app.set_org_legal_entity_tax_identifier((select id from world where key = 'le'), '12-3456789')$$,
  '42501', null, 'nor set its tax identifier');
select throws_ok($$select app.start_break_glass((select id from world where key = 'org_a'), 'Taking emergency access in an org I do not belong to.')$$,
  '42501', null, 'nor take emergency access in it');
select is((select count(*)::int from app.network_access(pg_temp.id('org_a'), '203.0.113.9')), 0,
  'the allow-list answers nothing about an org the caller does not belong to');
select is((select count(*)::int from app.shared_projects()), 0, 'an org outside the share sees no shared project');
select is((select count(*)::int from app.shared_project_scope_nodes(pg_temp.id('prj_a'))), 0, 'nor its scope nodes');
select is((select count(*)::int from app.org_legal_entities_masked where org_id = pg_temp.id('org_a')), 0,
  'nor the masked legal entities');
select throws_ok($$insert into app.project_shares (project_id, partner_organization_id) values ((select id from world where key = 'prj_a'), (select id from world where key = 'org_b'))$$,
  '42501', null, 'another org cannot share Northwind''s project with itself');

-- The partner reads the share and the projection, and changes nothing.
select pg_temp.as_user('paul');
select is((select count(*)::int from app.project_shares where id = pg_temp.id('share')), 1, 'the partner reads the share');
select is(pg_temp.rows_touched($$update app.project_shares set project_role = 'Producer' where id = (select id from world where key = 'share')$$),
  0::bigint, 'the partner cannot raise the role the share grants');
select is(pg_temp.rows_touched($$update app.project_shares set valid_to = null, deleted_at = null where id = (select id from world where key = 'share')$$),
  0::bigint, 'nor change its end');
select throws_ok($$insert into app.project_share_scope_nodes (project_share_id, scope_node_id) values ((select id from world where key = 'share'), (select id from world where key = 'root_a'))$$,
  '42501', null, 'nor widen its scope');
select is(pg_temp.rows_touched($$update app.projects set name = 'Taken' where id = (select id from world where key = 'prj_a')$$),
  0::bigint, 'and never writes the owner''s project');

select * from finish();
rollback;
