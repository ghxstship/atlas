-- 2624_offerings_backfill.sql
-- R3 Org and project offerings (RRR-181, owner decision 7). Offerings default to Not Offered, which would hide the
-- Travel and lodging, Per diem, Hospitality and Guest list tabs of engagements on projects that already use them. The
-- backfill keeps them: each live project gets a Project value 'provided' for an offering it already has records of.
--
--   * private.backfill_offerings(): for every live project (not deleted, not archived, not Complete or Canceled) and
--     each offering with evidence on the project, writes the Project value 'provided' unless the project already has
--     a live value for that setting or the org locked it (a locked org value wins and refuses lower values):
--       offerings.travel      a live travel segment (0442) or Travel fulfillment (0351)
--       offerings.lodging     a live accommodation block (0440) or Lodging fulfillment
--       offerings.catering    a live Catering fulfillment or BEO (0351)
--       offerings.per_diem    a live per diem (0341)
--       offerings.guest_list  a live guest list entry (0431)
--     Parking, uniforms, radios and carts have no records to read yet and stay Not Offered. Returns the number of
--     values written; running it again writes nothing new.
--   * The migration runs it once. Projects of the demo org get their values from supabase/seeds/2620_r3_offerings.sql,
--     since seeds load after migrations.

create or replace function private.backfill_offerings()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text, locked)
  select p.org_id, k.setting_key, 'Project', p.id, 'provided', false
  from app.projects p
  cross join (values ('offerings.travel'), ('offerings.lodging'), ('offerings.catering'), ('offerings.per_diem'),
    ('offerings.guest_list')) k (setting_key)
  where p.deleted_at is null and p.archived_at is null and p.project_state not in ('Complete', 'Canceled')
    and not exists (
      select 1 from app.setting_values v
      where v.setting_key = k.setting_key and v.scope_kind = 'Project' and v.scope_id = p.id and v.deleted_at is null)
    and not private.org_setting_locked(p.org_id, k.setting_key)
    and case k.setting_key
      when 'offerings.travel' then
        exists (select 1 from app.travel_segments s where s.project_id = p.id and s.deleted_at is null)
        or exists (select 1 from app.fulfillments f
                   where f.project_id = p.id and f.fulfillment_kind = 'Travel' and f.deleted_at is null)
      when 'offerings.lodging' then
        exists (select 1 from app.accommodation_blocks b where b.project_id = p.id and b.deleted_at is null)
        or exists (select 1 from app.fulfillments f
                   where f.project_id = p.id and f.fulfillment_kind = 'Lodging' and f.deleted_at is null)
      when 'offerings.catering' then
        exists (select 1 from app.fulfillments f
                where f.project_id = p.id and f.fulfillment_kind = 'Catering' and f.deleted_at is null)
        or exists (select 1 from app.beos b where b.project_id = p.id and b.deleted_at is null)
      when 'offerings.per_diem' then
        exists (select 1 from app.per_diems d where d.project_id = p.id and d.deleted_at is null)
      when 'offerings.guest_list' then
        exists (select 1 from app.guest_list_entries g where g.project_id = p.id and g.deleted_at is null)
      else false
    end;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.backfill_offerings() is 'Owner decision 7 backfill (R3): writes the Project value ''provided'' of offerings.travel, offerings.lodging, offerings.catering, offerings.per_diem and offerings.guest_list on every live project (not deleted, not archived, not Complete or Canceled) that already has records of that offering (travel segments or Travel fulfillments; accommodation blocks or Lodging fulfillments; Catering fulfillments or BEOs; per diems; guest list entries), unless the project has a live value for the setting or the org locked it. Returns the number of values written.';
revoke all on function private.backfill_offerings() from public, anon, authenticated;
grant execute on function private.backfill_offerings() to service_role;

select private.backfill_offerings();
