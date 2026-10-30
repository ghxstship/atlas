-- 2930_project_days.sql
-- B4 Scheduling depth (RRR-228; parity gap G-38; ADR 0143 decision 1; ADR 0022 block 2930 to 2939). Day types: a
-- project's days, each a Load In, Show, Load Out, Travel, Off, Rehearsal or Other day, with up to four segments on a
-- split day (a Load Out in the morning and Travel in the afternoon). Schedules, calendars, day sheets and the portfolio
-- timeline read them as text-labelled tags, never colour alone.
--
--   * app.project_days, read with schedule.timeline.read and written with schedule.timeline.write (invariant 2). A
--     segment sits at a venue, at a Show node of the project (which gives the venue), or at a free-text location; its
--     time zone is stored only when no venue applies, since venues carry their own (0301). Readers take the venue's
--     zone, else the stored zone, else the project's.
--   * private.guard_project_day keeps a day in its project (project_day_project_immutable), allows at most four live
--     segments per date (project_day_split_limit), accepts only a Show node (project_day_scope_kind) and refuses a zone
--     where the node's venue gives one (project_day_time_zone). Moving a date is an ordinary edit for
--     schedule.timeline.write holders; app.move_project_anchor (2934) moves every day of the project at once.
--   * A deleted day is undone from Trash (ADR 0110): its title is its label, and an unlabelled day shows as Untitled
--     there (trash-view.tsx), so the table is registered rather than excluded. The delete toast's Undo restores it too.
-- No view is created, so 1650's xos_backup rule does not apply.

create type app.project_day_type as enum ('Load In', 'Show', 'Load Out', 'Travel', 'Off', 'Rehearsal', 'Other');
comment on type app.project_day_type is 'What a project day is for (G-38, ADR 0143 decision 1): Load In (the build, bump-in), Show (a performance or event day), Load Out (the strike, bump-out), Travel (the company moves between places), Off (a rest day), Rehearsal (a rehearsal or tech day) and Other (anything else, named by its label).';

insert into private.domain_event_types (code, subject, description) values
  ('project_day.saved', 'project_days', 'A project day was added or changed: its date, its day type or its place in a split day.')
on conflict (code) do nothing;

create table app.project_days (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  day_on date not null,
  day_type app.project_day_type not null,
  sort_order smallint not null default 1,
  label text,
  venue_id uuid references app.venues (id),
  location_text text,
  time_zone text,
  scope_node_id uuid references app.scope_nodes (id),
  team_code text references xpms.dim_team (team_id),
  deleted_at timestamptz,
  constraint project_days_sort_order check (sort_order between 1 and 4),
  constraint project_days_label_length check (label is null or (char_length(label) between 1 and 120 and label = btrim(label))),
  constraint project_days_location_length check (
    location_text is null or (char_length(location_text) between 1 and 300 and location_text = btrim(location_text))),
  constraint project_days_node_or_venue check (scope_node_id is null or venue_id is null),
  constraint project_days_zone_without_venue check (time_zone is null or venue_id is null)
);

create unique index project_days_order_key on app.project_days (project_id, day_on, sort_order) where deleted_at is null;
create index project_days_project_day_idx on app.project_days (project_id, day_on);
create index project_days_venue_id_idx on app.project_days (venue_id);
create index project_days_scope_node_id_idx on app.project_days (scope_node_id);
create index project_days_team_code_idx on app.project_days (team_code);

call private.install_project_table('app.project_days', 'schedule.timeline.read', 'schedule.timeline.write',
  array['app.scope_nodes', 'scope_node_id', 'app.venues', 'venue_id']);
call private.describe('app.project_days', 'Day types of a project (G-38, ADR 0143 decision 1): each date is a Load In, Show, Load Out, Travel, Off, Rehearsal or Other day, in up to four segments on a split day. Read with schedule.timeline.read and written with schedule.timeline.write; schedules, calendars, day sheets and the portfolio timeline show them as text-labelled tags.', array[
  'project_id', 'Project the day belongs to. Never changes.',
  'day_on', 'Date of the day, in the zone of its place (the venue''s, the stored zone, else the project''s).',
  'day_type', 'What the day is for.',
  'sort_order', 'Place of the segment on a split day, 1 to 4, 1 first.',
  'label', 'Name shown for the segment, such as Travel to Austin; NULL shows the day type''s name.',
  'venue_id', 'Venue the segment happens at, when no Show node is named (the node gives its venue).',
  'location_text', 'Where the segment happens when it is not at a venue, such as a city or an airport.',
  'time_zone', 'IANA zone of the segment when no venue applies; NULL means the project''s zone.',
  'scope_node_id', 'Show node of the same project the segment serves, such as one stage of a festival.',
  'team_code', 'Canon team the segment applies to; NULL means everyone on the project.'
]);

create trigger t39_project_day_project before insert or update on app.project_days
  for each row execute function private.assert_same_project('app.scope_nodes', 'scope_node_id');

create or replace function private.guard_project_day()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node app.scope_nodes;
begin
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    perform private.refuse('project_day_project_immutable', 'A day stays in its project; add the day to the other project instead.');
  end if;
  perform private.assert_time_zone(new.time_zone);

  if new.scope_node_id is not null then
    select * into v_node from app.scope_nodes n where n.id = new.scope_node_id;
    if v_node.scope_kind is distinct from 'Show' then
      perform private.refuse('project_day_scope_kind', 'A day serves a Show node of the project; choose a show, or leave it for the whole project.');
    end if;
    if v_node.venue_id is not null and new.time_zone is not null then
      perform private.refuse('project_day_time_zone', 'This show''s venue sets the time zone; leave the time zone empty.');
    end if;
  end if;

  if new.deleted_at is null then
    -- Two segments added at once to the same date count each other: the date is locked first.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('project_days:' || new.project_id::text || ':' || new.day_on::text, 0));
    if (select count(*) from app.project_days d
        where d.project_id = new.project_id and d.day_on = new.day_on and d.deleted_at is null and d.id <> new.id) >= 4 then
      perform private.refuse('project_day_split_limit', 'A day splits into at most four segments; change or remove one first.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_project_day() is 'Project days: the project never changes (project_day_project_immutable), the zone is a valid IANA zone, a named node is a Show node (project_day_scope_kind) whose venue, when it has one, sets the zone (project_day_time_zone), and a date holds at most four live segments (project_day_split_limit).';
revoke all on function private.guard_project_day() from public, anon, authenticated;

create trigger t40_guard_project_day before insert or update on app.project_days
  for each row execute function private.guard_project_day();

create trigger t90_emit_project_day_saved after insert or update of day_on, day_type, sort_order on app.project_days
  for each row execute function private.emit_row_event('project_day.saved', 'project_id', 'day_on', 'day_type', 'sort_order');

call private.install_default_retention('app.project_days');
call private.install_audit_trail('app.project_days');
-- A deleted day belongs in Trash (ADR 0110): register it now rather than at the nightly sweep.
select private.sync_trash_tables();
