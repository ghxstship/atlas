-- 0944_sync_scope_refresh_safe_delete.sql
-- Orchestrator correction to A03F's 0943, in A03F's late slot so it runs after 0943. PostgREST's authenticator loads pg_safeupdate, which refuses a
-- DELETE without a WHERE clause. private.refresh_sync_scope_grants emptied its temp table with an
-- unqualified delete, so every membership change made through the API (create_organization among them)
-- failed with SQLSTATE 21000. The body is otherwise unchanged from 0943.

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
  delete from sync_scope_fresh where true;
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
