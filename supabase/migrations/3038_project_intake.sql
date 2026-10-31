-- 3038_project_intake.sql
-- B14 Event types and project setup (RRR-238; parity gaps G-250, G-252 and G-262; ADR 0153; block 3030 to 3039). The
-- staged intake wizard's save: one transaction that creates the project from the event type's template, a chosen
-- template or nothing, sets its event type and bands, lays its Load In and Load Out days, and copies the chosen parts of
-- a past project. A refused step leaves no project behind.
--
-- app.create_project_from_intake runs as the caller (invoker, like app.apply_template), so row level security and every
-- guard decide. Setting the type and bands on the new project needs only the project update policy (t44, 3030), so a
-- custom role that creates projects without projects.settings.write still completes intake. The Load In and Load Out
-- days are B4's app.project_days (2930), saved through app.save_project_days; nothing else stores the bump windows
-- (ADR 0143 decision 1, ADR 0153 C1). Custom field values are saved afterwards by the server action through A117's
-- customFieldsOf(...).save; the gate check (3032) is the database requirement.

create or replace function app.create_project_from_intake(
  p_org_id uuid,
  p_project_key text,
  p_name text,
  p_time_zone text,
  p_starts_on date default null,
  p_ends_on date default null,
  p_venue_id uuid default null,
  p_event_type_id uuid default null,
  p_event_scale app.event_scale default null,
  p_event_audience app.event_audience default null,
  p_template_choice text default 'type',
  p_template_id uuid default null,
  p_without_dates boolean default false,
  p_load_in_from date default null,
  p_load_in_to date default null,
  p_load_out_from date default null,
  p_load_out_to date default null,
  p_copy_from_project_id uuid default null,
  p_copy_parts app.project_copy_part[] default '{}',
  p_copy_offset_days integer default null,
  p_jurisdiction_id text default null,
  p_region_code text default null,
  p_tier_code text default null,
  p_currency_code text default null,
  p_description text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_template uuid;
  v_application uuid;
  v_project uuid;
  v_count integer;
  v_day date;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  if p_template_choice is null or p_template_choice not in ('type', 'template', 'none') then
    raise exception using errcode = '22023', message = 'p_template_choice is type, template or none';
  end if;
  if (p_load_in_from is null) <> (p_load_in_to is null) or (p_load_out_from is null) <> (p_load_out_to is null)
     or p_load_in_to < p_load_in_from or p_load_out_to < p_load_out_from then
    raise exception using errcode = 'XR001', hint = 'project_bump_window_bounds',
      message = 'project_bump_window_bounds: Give the first and the last Load In day, and the first and the last Load Out day, each in order.';
  end if;
  if p_load_in_to - p_load_in_from >= 60 or p_load_out_to - p_load_out_from >= 60 then
    raise exception using errcode = 'XR001', hint = 'project_bump_window_length',
      message = 'project_bump_window_length: Bump-in and bump-out each last at most 60 days.';
  end if;

  -- 1. The template.
  if p_template_choice = 'type' and p_event_type_id is not null then
    v_template := app.resolve_event_type_template(p_event_type_id, p_event_scale, p_event_audience);
  elsif p_template_choice = 'template' then
    select t.id into v_template from app.templates t
    where t.id = p_template_id and t.org_id = p_org_id and t.deleted_at is null and t.template_kind = 'Project';
    if v_template is null then
      raise exception using errcode = '42501', message = 'template not found';
    end if;
  end if;

  -- 2. The project.
  if v_template is not null then
    v_application := app.apply_template(v_template, p_project_key, p_name, p_time_zone, p_starts_on, p_venue_id,
      coalesce(p_without_dates, false));
    select a.project_id into v_project from app.template_applications a where a.id = v_application;
  else
    v_project := app.create_project(p_org_id, p_project_key, p_name, p_time_zone, p_jurisdiction_id, p_region_code,
      p_tier_code, p_venue_id, p_starts_on, p_ends_on, p_currency_code, p_description);
  end if;

  -- 3. The type, the bands, and over a template's defaults the last show day and the header fields given; nothing to
  -- set, nothing updated.
  if p_event_type_id is not null or p_event_scale is not null or p_event_audience is not null
     or (v_template is not null and coalesce(p_ends_on::text, p_jurisdiction_id, p_region_code, p_tier_code,
                                             nullif(btrim(p_currency_code), ''), nullif(btrim(p_description), '')) is not null) then
    update app.projects p set
      event_type_id = p_event_type_id,
      event_scale = p_event_scale,
      event_audience = p_event_audience,
      ends_on = coalesce(p_ends_on, p.ends_on),
      jurisdiction_id = coalesce(p_jurisdiction_id, p.jurisdiction_id),
      region_code = coalesce(p_region_code, p.region_code),
      tier_code = coalesce(p_tier_code, p.tier_code),
      currency = coalesce(upper(nullif(btrim(p_currency_code), '')), p.currency),
      description = coalesce(nullif(btrim(p_description), ''), p.description)
    where p.id = v_project;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise exception using errcode = '42501', message = 'projects.project.write is required on the project';
    end if;
  end if;

  -- 4. Load In and Load Out days, through B4's day editor save.
  if p_load_in_from is not null or p_load_out_from is not null then
    if not ('schedule.timeline.write' = any (app.my_schedule_capabilities_on_project(v_project))) then
      raise exception using errcode = '42501', message = 'schedule.timeline.write is required on the project';
    end if;
    if p_load_in_from is not null then
      for v_day in select d::date from generate_series(p_load_in_from, p_load_in_to, interval '1 day') d loop
        perform app.save_project_days(v_project, v_day, '[{"dayType": "Load In"}]'::jsonb);
      end loop;
    end if;
    if p_load_out_from is not null then
      for v_day in select d::date from generate_series(p_load_out_from, p_load_out_to, interval '1 day') d loop
        perform app.save_project_days(v_project, v_day, '[{"dayType": "Load Out"}]'::jsonb);
      end loop;
    end if;
  end if;

  -- 5. The copy, in the same transaction: a refused copy leaves no project.
  if p_copy_from_project_id is not null then
    perform app.copy_project_setup(p_copy_from_project_id, v_project, p_copy_parts, true, p_copy_offset_days);
  end if;
  return v_project;
end;
$$;

comment on function app.create_project_from_intake(uuid, text, text, text, date, date, uuid, uuid, app.event_scale, app.event_audience, text, uuid, boolean, date, date, date, date, uuid, app.project_copy_part[], integer, text, text, text, text, text) is 'The staged intake wizard''s save (G-250, G-252, G-262; ADR 0153), in one transaction as the caller: creates the project from the event type''s template for the scale and audience (p_template_choice type, app.resolve_event_type_template; blank when none matches), from a template of the org (template) or blank (none; 22023 otherwise) through app.apply_template or app.create_project; sets the event type, bands and, over a template''s defaults, the last show day, jurisdiction, region, tier, currency and description when given (42501 when the caller cannot update the project); saves each date from p_load_in_from to p_load_in_to as a Load In day and each from p_load_out_from to p_load_out_to as a Load Out day through app.save_project_days, which needs schedule.timeline.write on the project (42501; project_bump_window_bounds for a missing or reversed bound, project_bump_window_length beyond 60 days); and, when p_copy_from_project_id is given, copies p_copy_parts from it with app.copy_project_setup. Any refusal leaves no project. Returns the project id.';
revoke all on function app.create_project_from_intake(uuid, text, text, text, date, date, uuid, uuid, app.event_scale, app.event_audience, text, uuid, boolean, date, date, date, date, uuid, app.project_copy_part[], integer, text, text, text, text, text) from public, anon;
grant execute on function app.create_project_from_intake(uuid, text, text, text, date, date, uuid, uuid, app.event_scale, app.event_audience, text, uuid, boolean, date, date, date, date, uuid, app.project_copy_part[], integer, text, text, text, text, text) to authenticated, service_role;
