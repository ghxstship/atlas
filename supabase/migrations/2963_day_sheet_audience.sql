-- 2963_day_sheet_audience.sql
-- B7 (RRR-231, ADR 0146 decisions 2 and 3; gap G-52). A day sheet prints for one team or one canon department with
-- only that audience's calls and records. The audience rule is the one calendar feeds use (2961), in SQL alone.
--
--   * app.day_sheet_schedule(day sheet, team or department) returns the audience's name and the ids of the shifts and
--     records of that day it may print. It is security definer because the audience helpers read memberships the
--     reader cannot list; it first requires show.run_of_show.read on the sheet's project, then reads shifts and
--     records with the owner-reach expressions of the calendar feed's project branch (crew.shift.read or the reader's
--     own shift; work.record.read or the reader's own records), so a filter never shows more than the reader may see.
--   * The day is the project's local day (private.zone_date, A71): shifts that start on it, and Meeting, Milestone and
--     Deadline records whose start, else due time, falls on it.
--   * A team that is not live or is of another org is not found (42501, so the route answers 404); both or neither of
--     team and department, or an unknown department, is refused with day_sheet_audience.

create or replace function app.day_sheet_schedule(
  p_day_sheet_id uuid, p_team_id uuid default null, p_department_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sheet app.day_sheets;
  v_zone text;
  v_name text;
  v_members uuid[];
  v_shifts uuid[];
  v_records uuid[];
begin
  select * into v_sheet from app.day_sheets d where d.id = p_day_sheet_id and d.deleted_at is null;
  if v_sheet.id is null or not private.can_on_project(v_sheet.project_id, 'show.run_of_show.read') then
    raise exception using errcode = '42501', message = 'day sheet not found';
  end if;
  if num_nonnulls(p_team_id, p_department_code) <> 1 then
    perform private.refuse('day_sheet_audience', 'Choose one audience for the day sheet: a team or a department.');
  end if;
  if p_team_id is not null then
    select t.name into v_name from app.teams t where t.id = p_team_id and t.org_id = v_sheet.org_id and t.deleted_at is null;
    if v_name is null then
      raise exception using errcode = '42501', message = 'team not found';
    end if;
  else
    select d.department into v_name from xpms.dim_department d where d.dept_code = p_department_code;
    if v_name is null then
      perform private.refuse('day_sheet_audience', 'That department does not exist.');
    end if;
  end if;

  select coalesce(p.time_zone, 'UTC') into v_zone from app.projects p where p.id = v_sheet.project_id;
  v_members := array(select private.schedule_audience_memberships(v_sheet.org_id, null, p_team_id, p_department_code));

  select coalesce(array_agg(s.id order by s.starts_at, s.id), '{}') into v_shifts
  from app.shifts s
  where s.project_id = v_sheet.project_id and s.deleted_at is null
    and private.zone_date(s.starts_at, v_zone) = v_sheet.day
    and (s.membership_id in (select private.my_membership_ids()) or s.project_id in (select private.project_ids_with('crew.shift.read')))
    and private.schedule_audience_shift(s.membership_id, s.role_code, v_members, p_department_code);

  select coalesce(array_agg(r.id order by coalesce(r.starts_at, r.due_at), r.id), '{}') into v_records
  from app.records r
  where r.project_id = v_sheet.project_id and r.deleted_at is null and r.record_kind in ('Meeting', 'Milestone', 'Deadline')
    and private.zone_date(coalesce(r.starts_at, r.due_at), v_zone) = v_sheet.day
    and (r.project_id in (select private.project_ids_with('work.record.read')) or r.id in (select private.my_record_ids('work.record.read')))
    and private.schedule_audience_record(r.id, v_members);

  return jsonb_build_object('audience_name', v_name, 'shift_ids', to_jsonb(v_shifts), 'record_ids', to_jsonb(v_records));
end;
$$;

comment on function app.day_sheet_schedule(uuid, uuid, text) is 'The schedule of a day sheet for one audience (ADR 0146 decision 2): {audience_name, shift_ids, record_ids}, the team''s name or the canon department''s, and the ids of the project''s shifts starting on the sheet''s local day and its Meeting, Milestone and Deadline records starting or due that day that belong to the audience (private.schedule_audience_shift, private.schedule_audience_record) and that the reader may see. Needs show.run_of_show.read on the project (else day sheet not found); a team of another org is not found; both or neither audience, or an unknown department, is refused with day_sheet_audience.';
revoke all on function app.day_sheet_schedule(uuid, uuid, text) from public, anon;
grant execute on function app.day_sheet_schedule(uuid, uuid, text) to authenticated, service_role;
