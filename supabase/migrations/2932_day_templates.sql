-- 2932_day_templates.sql
-- B4 Scheduling depth (RRR-228; parity gap G-42; ADR 0143 decision 2; ADR 0022 block 2930 to 2939). Day templates: a
-- day's records and cues saved once (a show day, a load-in day) and laid onto another day through a reviewable dry run
-- (2933). They follow 1032's template patterns in tables of their own: v1 freezes Template.template_kind to
-- ["Project"] and TemplateItem.item_kind to ["Scope Node", "Record"] (packages/api/openapi/v1.json), and the v1
-- template handlers read app.templates and app.template_items, so a Day kind there would leak through GET /templates.
--
--   * app.day_templates: an org's day templates, read by its members and written with projects.template.write.
--   * app.day_template_items: Record items (a kind, an XYZ tag and a title in the kind's grammar) and Cue items (a label
--     and a segment's text; B3 owns the segment library). Each starts at a minute of the day's wall clock, from -1440
--     (the evening before) to 2879 (the night after), and lasts 0 to 1440 minutes; a Record item without a length is due
--     at its start. private.guard_day_template_item checks a Record item's title against its kind's grammar
--     (day_template_title) and keeps a template to 500 live items (day_template_too_large).
--   * app.day_template_applications: append-only, one row per committed application with what it created and skipped.
-- Templates and items removed by mistake come back from Trash (ADR 0110); applications have no title and stay out.

create type app.day_template_item_kind as enum ('Record', 'Cue');
comment on type app.day_template_item_kind is 'Kind of a day template item: a Record created on the project, or a Cue appended to the day''s running order.';

-- Templates --------------------------------------------------------------------------------------------------------------

create table app.day_templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  day_type app.project_day_type,
  deleted_at timestamptz,
  constraint day_templates_name_length check (char_length(name) between 1 and 200 and name = btrim(name)),
  constraint day_templates_description_length check (description is null or char_length(description) <= 2000)
);

call private.install_domain_table('app.day_templates');
create unique index day_templates_name_key on app.day_templates (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.day_templates', 'Day templates of an org (G-42, ADR 0143 decision 2): a day''s records and cues saved with times relative to local midnight, laid onto another day through app.apply_day_template''s dry run. Read by the org''s members; written with projects.template.write.', array[
  'name', 'Template name, unique in the org.',
  'description', 'When to use the template.',
  'day_type', 'The kind of day the template suits, such as Show; NULL suits any day.'
]);
call private.install_policies('app.day_templates',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);
call private.install_default_retention('app.day_templates');
call private.install_audit_trail('app.day_templates');

-- Items --------------------------------------------------------------------------------------------------------------------

create table app.day_template_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  day_template_id uuid not null references app.day_templates (id),
  item_kind app.day_template_item_kind not null,
  sort_order smallint not null,
  name text not null,
  record_kind text references xpms.dim_record_kind (record_kind),
  xyz xpms.xyz_tag,
  phase_code text references xpms.dim_phase (phase_code),
  start_minute integer not null,
  duration_minutes integer,
  segment text,
  start_tbc boolean not null default false,
  deleted_at timestamptz,
  constraint day_template_items_sort_order check (sort_order between 1 and 500),
  constraint day_template_items_name_length check (char_length(name) between 1 and 200 and name = btrim(name)),
  constraint day_template_items_start check (start_minute between -1440 and 2879),
  constraint day_template_items_duration check (duration_minutes is null or duration_minutes between 0 and 1440),
  constraint day_template_items_segment_length check (segment is null or (char_length(segment) between 1 and 200 and segment = btrim(segment))),
  constraint day_template_items_record check (item_kind <> 'Record' or (record_kind is not null and xyz is not null and segment is null)),
  constraint day_template_items_cue check (item_kind <> 'Cue' or (record_kind is null and xyz is null and phase_code is null))
);

create index day_template_items_template_idx on app.day_template_items (day_template_id, sort_order);
create index day_template_items_record_kind_idx on app.day_template_items (record_kind);
create index day_template_items_phase_idx on app.day_template_items (phase_code);

call private.install_domain_table('app.day_template_items', 'app.day_templates', 'day_template_id');
call private.describe('app.day_template_items', 'Items of a day template: records created on the project and cues appended to the day''s running order, each at a minute of the day''s wall clock.', array[
  'day_template_id', 'Day template the item belongs to.',
  'item_kind', 'Record or Cue.',
  'sort_order', 'Position in the template, 1 first (1 to 500).',
  'name', 'Record title in its kind''s grammar, or cue label.',
  'record_kind', 'For a record: canon record kind.',
  'xyz', 'For a record: schema family tag (X Resource, Y Process, Z Timeline), declared.',
  'phase_code', 'For a record: canon phase the record belongs to, if any.',
  'start_minute', 'Start in minutes from the day''s local midnight, -1440 (the evening before) to 2879 (the night after).',
  'duration_minutes', 'Length in minutes, 0 to 1440; NULL on a record means it is due at its start.',
  'segment', 'For a cue: the show segment''s text, such as Act II.',
  'start_tbc', 'True when the start is an estimate to be confirmed, copied to what the item creates.'
]);

create or replace function private.guard_day_template_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text;
begin
  if new.item_kind = 'Record' and (tg_op = 'INSERT' or new.name <> old.name or new.record_kind is distinct from old.record_kind) then
    v_refusal := private.title_grammar_refusal(new.record_kind, new.name);
    if v_refusal is not null then
      perform private.refuse('day_template_title', v_refusal);
    end if;
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('day_template_items:' || new.day_template_id::text, 0));
    if (select count(*) from app.day_template_items i
        where i.day_template_id = new.day_template_id and i.deleted_at is null and i.id <> new.id) >= 500 then
      perform private.refuse('day_template_too_large', 'A day template holds at most 500 items; remove one first.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_day_template_item() is 'Day template items: a Record item''s name passes its kind''s title grammar (day_template_title, with the correction), and a template holds at most 500 live items (day_template_too_large).';
revoke all on function private.guard_day_template_item() from public, anon, authenticated;

create trigger t40_guard_day_template_item before insert or update on app.day_template_items
  for each row execute function private.guard_day_template_item();

call private.install_policies('app.day_template_items',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);
call private.install_default_retention('app.day_template_items');

-- Applications -------------------------------------------------------------------------------------------------------------

create table app.day_template_applications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  day_template_id uuid not null references app.day_templates (id),
  project_id uuid not null references app.projects (id),
  day_on date not null,
  run_of_show_id uuid references app.run_of_show (id),
  records_created integer not null default 0,
  cues_created integer not null default 0,
  items_skipped integer not null default 0,
  constraint day_template_applications_counts check (records_created >= 0 and cues_created >= 0 and items_skipped >= 0)
);

create index day_template_applications_template_idx on app.day_template_applications (day_template_id);
create index day_template_applications_project_idx on app.day_template_applications (project_id, day_on);
create index day_template_applications_run_idx on app.day_template_applications (run_of_show_id);

call private.install_domain_table('app.day_template_applications', 'app.day_templates', 'day_template_id',
  array['app.projects', 'project_id', 'app.run_of_show', 'run_of_show_id'], true);
call private.describe('app.day_template_applications', 'Append-only record of each day template laid onto a project day: the running order its cues joined and what it created and skipped. Written by app.apply_day_template.', array[
  'day_template_id', 'Day template applied.',
  'project_id', 'Project the template was laid onto.',
  'day_on', 'Day the template was laid onto, in the project''s zone.',
  'run_of_show_id', 'Running order of the same project the cue items joined; NULL when none did.',
  'records_created', 'Records the application created, as it was applied.',
  'cues_created', 'Cues the application created, as it was applied.',
  'items_skipped', 'Items left out: unticked, already on the day, or cues with no running order that day.'
]);
create trigger t39_day_template_application_project before insert on app.day_template_applications
  for each row execute function private.assert_same_project('app.run_of_show', 'run_of_show_id');
call private.install_policies('app.day_template_applications',
  $$project_id in (select private.readable_project_ids())$$,
  $$project_id in (select private.project_ids_with('schedule.timeline.write'))$$);
call private.install_default_retention('app.day_template_applications');

-- Removed templates and items belong in Trash (ADR 0110): register them now rather than at the nightly sweep.
select private.sync_trash_tables();
