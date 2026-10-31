-- 2250_shift_templates.sql
--
-- Shift templates (ADR 0022, 2250-2259), A132, RRR-194, ADR 0063. Section 4.5.6 item 25 lists shift templates
-- among the Scheduling settings, and Section 11.11 asks that crew fill be quick to plan. An org keeps named shift
-- shapes (role, call and wrap times, headcount and scheduled break) and a planner lays one onto a project's days in
-- one step:
--   * app.shift_templates, org-scoped, read by the org's members and written by holders of org.scheduling.write
--     (Settings, Scheduling). A wrap at or before the call ends the next day, so overnight shifts need no date;
--   * app.create_shifts_from_template(template, project, days) plans headcount open Draft shifts on each day, at the
--     call and wrap times read in the project's time zone, with the template's role and break. It needs
--     crew.shift.write on the project and creates every shift or none. Claiming and swapping (1322) are unchanged:
--     the shifts are ordinary open shifts once published.

create table app.shift_templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  role_code text references xpms.role (role_code),
  call_time time not null,
  wrap_time time not null,
  headcount smallint not null default 1,
  break_minutes smallint not null default 0,
  constraint shift_templates_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint shift_templates_headcount check (headcount between 1 and 50),
  constraint shift_templates_wrap check (wrap_time <> call_time),
  constraint shift_templates_break check (
    break_minutes >= 0
    and break_minutes * interval '1 minute' < case when wrap_time > call_time then wrap_time - call_time
                                                    else wrap_time - call_time + interval '24 hours' end)
);

create index shift_templates_role_code_idx on app.shift_templates (role_code);

call private.install_domain_table('app.shift_templates');
create unique index shift_templates_name_key on app.shift_templates (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.shift_templates', 'Shift shapes an org plans crew from (Section 4.5.6 item 25): a role, call and wrap times, how many people and the scheduled break. app.create_shifts_from_template lays one onto a project''s days as open Draft shifts. Read by the org''s members; written by holders of org.scheduling.write.', array[
  'name', 'Name planners pick the template by, unique in the org.',
  'role_code', 'Canon role of the shifts (Roles Library); null plans them without a role.',
  'call_time', 'Call time, read in the project''s time zone.',
  'wrap_time', 'Wrap time; at or before the call time, the shift ends the next day.',
  'headcount', 'Shifts planned on each day, one per person needed (1 to 50).',
  'break_minutes', 'Meal break scheduled within each shift, in minutes; shorter than the shift.'
]);

call private.install_policies('app.shift_templates',
  $$org_id in (select private.my_org_ids())$$,
  $$private.has_capability(org_id, 'org.scheduling.write')$$);
call private.install_default_retention('app.shift_templates');
call private.install_audit_trail('app.shift_templates');
-- A removed template belongs in Trash (ADR 0110): register it now rather than at the nightly sweep.
select private.sync_trash_tables();

-- Laying a template onto days ---------------------------------------------------------------------------------------

create or replace function app.create_shifts_from_template(p_template_id uuid, p_project_id uuid, p_days date[])
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_template app.shift_templates;
  v_project app.projects;
  v_day date;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  perform private.require_person();
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.can_on_project(p_project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project to plan shifts';
  end if;
  select * into v_template from app.shift_templates t
  where t.id = p_template_id and t.org_id = v_project.org_id and t.deleted_at is null;
  if v_template.id is null then
    perform private.refuse('shift_template_unknown', 'Pick a shift template of this organization.');
  end if;
  if coalesce(cardinality(p_days), 0) = 0 then
    perform private.refuse('shift_template_days', 'Pick at least one day to plan.');
  end if;
  if cardinality(p_days) > 31 or exists (select 1 from unnest(p_days) d group by d having count(*) > 1)
     or exists (select 1 from unnest(p_days) d where d is null) then
    perform private.refuse('shift_template_days', 'Pick up to 31 different days to plan.');
  end if;

  foreach v_day in array p_days loop
    for i in 1 .. v_template.headcount loop
      insert into app.shifts (org_id, project_id, role_code, starts_at, ends_at, time_zone, scheduled_break_minutes)
      values (
        v_project.org_id, v_project.id, v_template.role_code,
        (v_day + v_template.call_time) at time zone v_project.time_zone,
        (v_day + case when v_template.wrap_time > v_template.call_time then 0 else 1 end + v_template.wrap_time)
          at time zone v_project.time_zone,
        v_project.time_zone,
        nullif(v_template.break_minutes, 0))
      returning id into v_id;
      v_ids := v_ids || v_id;
    end loop;
  end loop;
  return v_ids;
end;
$$;

comment on function app.create_shifts_from_template(uuid, uuid, date[]) is 'Plans the template''s headcount of open Draft shifts on each of up to 31 days (A132, ADR 0063): call and wrap read in the project''s time zone (a wrap at or before the call ends the next day), with the template''s role and scheduled break. Needs crew.shift.write on the project; the template must be the project org''s. Creates every shift or none and returns their ids in day order.';

revoke all on function app.create_shifts_from_template(uuid, uuid, date[]) from public, anon;
grant execute on function app.create_shifts_from_template(uuid, uuid, date[]) to authenticated, service_role;
