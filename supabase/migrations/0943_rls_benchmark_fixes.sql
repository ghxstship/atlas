-- 0943_rls_benchmark_fixes.sql
-- A03 Domain Data, late slot (RRR-71, Section 18 gate 17: policy-filtered list queries under 50 ms at
-- p95 on 1,000,000 rows). Fixes from the benchmark in supabase/tests/0399_rls_benchmark.psql. Lives in
-- the late slot because time_entries_read was last written in 0940.
--
-- 1. Record child tables. "record_id in (select private.record_ids_with(c))" makes Postgres materialize
--    every record the person can reach, one million ids for an org overseer, on every query: past 20 s at
--    1,000,000 rows. The policies now check the one parent record by primary key with a correlated
--    EXISTS, after a first arm on the child's own org_id for org overseers (who hold the capability
--    org-wide with projects.members.manage, and so reach every project of the org anyway). Without that
--    arm the planner hashes every reachable record for an overseer (740 ms). The project and assignment
--    sets are computed once per query as arrays. The meaning is unchanged: a record of a project the
--    person may use the capability on, or a record assigned to them, that is not deleted; an overseer
--    reaches every record of the org. The parent is also read under its own read policy, so a child row
--    is never visible without its record.
-- 2. records_read and time_entries_read. "x in (select f())" inside an OR runs as a subplan that the
--    planner may re-run per row: a Member listing records newest first passed 20 s. The sets are now
--    "x = any (array(select f()))", evaluated once per query and usable by bitmap index scans on each
--    arm. Same rows, same helpers (invariant 5).
-- 3. Indexes for the default lists: records (created_at), time_entries (clock_in), and time_entries
--    (project_id, clock_in), without which a project's newest entries were found by walking the clock_in
--    index past every other project (180 ms).
-- 4. private.my_record_ids walked every record of the person's orgs and called capability_reach and
--    current_person_id on each row: past 20 s at 1,000,000 records, and every records policy calls it.
--    It now starts from the person's owned, accountable and assigned records through their indexes and
--    checks the capability once per org. Same rows.
-- Every policy keeps calling its helpers from private with session values only (ADR 0016 crash rule:
-- no helper re-reads the scanned table).

-- 1. Record child tables ---------------------------------------------------------------------------------

do $$
declare
  v_policy record;
  v_column text;
  v_capability text;
  v_expression text;
begin
  for v_policy in
    select p.tablename, p.policyname, p.cmd, coalesce(p.qual, p.with_check) as expression
    from pg_catalog.pg_policies p
    where p.schemaname = 'app'
      and p.tablename not in ('punch_items')
      and coalesce(p.qual, p.with_check) ~ '^\(\w+ IN \( SELECT private\.record_ids_with\(''[a-z_.]+''::text\) AS record_ids_with\)\)$'
  loop
    v_column := substring(v_policy.expression from '^\((\w+) IN');
    v_capability := substring(v_policy.expression from 'record_ids_with\(''([a-z_.]+)''');
    v_expression := format(
      'org_id = any (array(select private.oversight_org_ids(%L)))'
      ' or exists (select 1 from app.records r where r.id = %I and r.deleted_at is null'
      ' and (r.project_id = any (array(select private.project_ids_with(%L)))'
      ' or r.id = any (array(select private.my_record_ids(%L)))))',
      v_capability, v_column, v_capability, v_capability);
    if v_policy.cmd = 'SELECT' then
      execute format('alter policy %I on app.%I using (%s)', v_policy.policyname, v_policy.tablename, v_expression);
    elsif v_policy.cmd = 'INSERT' then
      execute format('alter policy %I on app.%I with check (%s)', v_policy.policyname, v_policy.tablename, v_expression);
    else
      execute format('alter policy %I on app.%I using (%s) with check (%s)', v_policy.policyname, v_policy.tablename, v_expression, v_expression);
    end if;
  end loop;
end $$;

-- 2. Set membership as arrays ------------------------------------------------------------------------------

alter policy records_read on app.records using (
  project_id = any (array(select private.project_ids_with('work.record.read')))
  or id = any (array(select private.my_record_ids('work.record.read')))
  or org_id = any (array(select private.oversight_org_ids('work.record.read'))));

alter policy time_entries_read on app.time_entries using (
  project_id = any (array(select private.project_ids_with('crew.time_entry.read')))
  or membership_id = any (array(select private.my_membership_ids()))
  or engagement_id = any (array(select private.my_engagement_ids('operational'))));

-- 3. Newest-first lists ----------------------------------------------------------------------------------------

create index if not exists records_created_at_idx on app.records (created_at);
create index if not exists time_entries_clock_in_idx on app.time_entries (clock_in);
create index if not exists time_entries_project_clock_in_idx on app.time_entries (project_id, clock_in);
drop index if exists app.time_entries_project_id_idx;

-- 4. Records assigned to the person -------------------------------------------------------------------------------

create or replace function private.my_record_ids(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select private.current_person_id() as person_id
  ),
  reachable_orgs as (
    select o.org_id from (select private.my_org_ids() as org_id) o
    where private.capability_reach(o.org_id, p_capability) is not null
  ),
  candidates as (
    select r.id, r.org_id from app.records r, me where r.owner_party_id = me.person_id and r.deleted_at is null
    union
    select r.id, r.org_id from app.records r, me where r.accountable_party_id = me.person_id and r.deleted_at is null
    union
    select r.id, r.org_id from app.record_assignments a join app.records r on r.id = a.record_id
    where a.deleted_at is null and r.deleted_at is null and a.membership_id in (select private.my_membership_ids())
  )
  select c.id from candidates c where c.org_id in (select ro.org_id from reachable_orgs ro)
  union
  select rg.target_id from app.record_grants rg, me
  where rg.target_kind = 'record' and rg.capability_code = p_capability
    and rg.deleted_at is null and rg.valid_from <= now() and rg.valid_to > now()
    and (rg.grantee_person_id = me.person_id or rg.grantee_org_id in (select private.my_org_ids()));
$$;

comment on function private.my_record_ids(text) is 'Invariant 2: records the signed-in person may use a capability on because they are assigned to them (owner, accountable party or assignee) in an org where they hold the capability at any reach, or through a record grant. Starts from the person''s own records through their indexes (gate 17).';

-- 5. Sync scope refresh without a notice per call -------------------------------------------------------------
-- The 0942 refresh created its scratch table with "if not exists", which raises a notice on every call
-- after the first in a transaction; bulk changes flooded the log. Same behavior, checked first.

create or replace function private.refresh_sync_scope_grants(p_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    return 0;
  end if;
  if to_regclass('pg_temp.sync_scope_fresh') is null then
    create temporary table sync_scope_fresh (scope_key text, scope_value text, audience text) on commit drop;
  end if;
  delete from sync_scope_fresh;
  insert into sync_scope_fresh
  select distinct on (r.scope_key, r.scope_value) r.scope_key, r.scope_value, r.audience
  from private.sync_scope_rows(p_user_id) r
  order by r.scope_key, r.scope_value, r.audience;
  delete from private.sync_scope_grants g
  where g.person_user_id = p_user_id
    and not exists (select 1 from sync_scope_fresh f where f.scope_key = g.scope_key and f.scope_value = g.scope_value);
  insert into private.sync_scope_grants (person_user_id, scope_key, scope_value, audience)
  select p_user_id, f.scope_key, f.scope_value, f.audience from sync_scope_fresh f
  on conflict (person_user_id, scope_key, scope_value) do update set audience = excluded.audience, refreshed_at = now();
  select count(*) into v_count from private.sync_scope_grants g where g.person_user_id = p_user_id;
  return v_count;
end;
$$;
