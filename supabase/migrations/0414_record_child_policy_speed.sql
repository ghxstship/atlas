-- 0414_record_child_policy_speed.sql
-- A08 (ADR 0022 range 0410 to 0419). Section 18 gate 17 (policy-filtered lists under 50 ms at p95 on
-- 1,000,000 rows), following A03F's 0943. punch_items and record_watchers checked
-- "record_id in (select private.record_ids_with(c))", which materializes every record the person
-- can reach on every query. They now check org overseers first, then the one parent record by
-- primary key with a correlated EXISTS, with the person's project and assignment sets computed once
-- per query as arrays. Who sees and writes which row is unchanged (pgTAP 0414 compares every row for
-- every role against the previous expressions).

alter policy punch_items_read on app.punch_items using (
  org_id = any (array(select private.oversight_org_ids('work.record.read')))
  or exists (
    select 1 from app.records r
    where r.id = record_id and r.deleted_at is null
      and (r.project_id = any (array(select private.project_ids_with('work.record.read')))
           or r.id = any (array(select private.my_record_ids('work.record.read'))))));

alter policy punch_items_insert on app.punch_items with check (
  exists (
    select 1 from app.records r
    where r.id = record_id
      and r.project_id = any (array(select private.project_ids_with('work.punch_list.write')))));

alter policy punch_items_update on app.punch_items
  using (
    exists (
      select 1 from app.records r
      where r.id = record_id
        and r.project_id = any (array(select private.project_ids_with('work.punch_list.write')))))
  with check (
    exists (
      select 1 from app.records r
      where r.id = record_id
        and r.project_id = any (array(select private.project_ids_with('work.punch_list.write')))));

alter policy record_watchers_read on app.record_watchers using (
  org_id = any (array(select private.oversight_org_ids('work.record.read')))
  or exists (
    select 1 from app.records r
    where r.id = record_id and r.deleted_at is null
      and (r.project_id = any (array(select private.project_ids_with('work.record.read')))
           or r.id = any (array(select private.my_record_ids('work.record.read'))))));

create or replace function private.can_watch_record(p_org_id uuid, p_record_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.records r
    where r.id = p_record_id and r.deleted_at is null
      and (r.org_id = any (array(select private.oversight_org_ids('work.record.read')))
           or r.project_id = any (array(select private.project_ids_with('work.record.read')))
           or r.id = any (array(select private.my_record_ids('work.record.read'))))
      and (p_person_id = private.current_person_id()
           or r.org_id = any (array(select private.oversight_org_ids('work.record.write')))
           or r.project_id = any (array(select private.project_ids_with('work.record.write')))
           or r.id = any (array(select private.my_record_ids('work.record.write')))));
$$;

comment on function private.can_watch_record(uuid, uuid, uuid) is 'Watcher write rule: the record is readable to the signed-in person, and the watcher is that person or the person may write the record. Takes the row''s values as arguments and reads only app.records (ADR 0016 crash rule).';
revoke all on function private.can_watch_record(uuid, uuid, uuid) from public, anon;
grant execute on function private.can_watch_record(uuid, uuid, uuid) to authenticated, service_role;

alter policy record_watchers_insert on app.record_watchers
  with check (private.can_watch_record(org_id, record_id, person_id));

alter policy record_watchers_update on app.record_watchers
  using (private.can_watch_record(org_id, record_id, person_id))
  with check (private.can_watch_record(org_id, record_id, person_id));
