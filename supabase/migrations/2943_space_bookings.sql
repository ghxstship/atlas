-- 2943_space_bookings.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144; parity gap G-32). Green rooms, dressing
-- rooms and other back-of-house spaces booked for an act or a team, optionally for the set time they serve.
--
--   * app.space_bookings: a space of the project's venue (0350) booked from in to out. An Exclusive booking holds the
--     space alone; Shared bookings may overlap each other and are grouped and checked against the space's capacity on
--     the board, never refused.
--   * A booking for a set time (app.engagement_cues, 0760) names the engagement of that set: when engagement_cue_id is
--     given, engagement_id is copied from it, a derived copy the guard keeps equal (denormalization register). The
--     guard compares the copied engagement's project with the booking's itself, because t39_assert_same_project runs
--     before t40 fills it, and app.engagement_cues has no project_id of its own.
--   * The overlap guard takes a transaction advisory lock per space, without btree_gist (ADR 0104 section 6), as
--     private.guard_dock_slot does (0351).
--   * app.space_booking_board (security invoker) computes conflicts, the peak party size and whether the set moved.
--   * api_external.space_bookings: an act's own bookings (space, purpose, in, out, set) for its people and principals.
-- Trash: app.space_bookings has no title column (private.trash_title_column), so a canceled booking is not in Trash; it
-- is booked again, or restored in place by its writer.

create type app.space_booking_purpose as enum ('Green Room', 'Dressing Room', 'Production Office', 'Hospitality Suite', 'Other');
comment on type app.space_booking_purpose is 'What a space is booked as: Green Room, Dressing Room, Production Office, Hospitality Suite or Other.';
create type app.space_booking_mode as enum ('Exclusive', 'Shared');
comment on type app.space_booking_mode is 'Exclusive holds the space alone; Shared bookings may overlap each other.';

create table app.space_bookings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  space_id uuid not null references app.spaces (id),
  engagement_id uuid references app.engagements (id),
  engagement_cue_id uuid references app.engagement_cues (id),
  purpose app.space_booking_purpose not null,
  booking_mode app.space_booking_mode not null default 'Exclusive',
  party_size smallint,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  notes text,
  deleted_at timestamptz,
  constraint space_bookings_window check (ends_at > starts_at),
  constraint space_bookings_party_size check (party_size is null or party_size between 1 and 500),
  constraint space_bookings_notes_length check (notes is null or char_length(btrim(notes)) between 1 and 1000)
);

create index space_bookings_project_id_idx on app.space_bookings (project_id, starts_at);
create index space_bookings_space_id_idx on app.space_bookings (space_id, starts_at);
create index space_bookings_engagement_id_idx on app.space_bookings (engagement_id);
create index space_bookings_engagement_cue_id_idx on app.space_bookings (engagement_cue_id);

call private.install_project_table('app.space_bookings', 'hospitality.fulfillment.read', 'hospitality.fulfillment.write',
  array['app.spaces', 'space_id', 'app.engagements', 'engagement_id', 'app.engagement_cues', 'engagement_cue_id']);
call private.describe('app.space_bookings', 'Back-of-house spaces of the project''s venue booked for an act or a team (B5, G-32): green rooms, dressing rooms, production offices and hospitality suites, from in to out, optionally for the set time they serve. Conflicts, capacity and moved sets are computed on the board (app.space_booking_board), never stored.', array[
  'project_id', 'Project.',
  'space_id', 'Space booked, of the project''s venue.',
  'engagement_id', 'Engagement the space is for; copied from the set time when engagement_cue_id is given.',
  'engagement_cue_id', 'Set time the booking serves, when it serves one.',
  'purpose', 'Green Room, Dressing Room, Production Office, Hospitality Suite or Other.',
  'booking_mode', 'Exclusive holds the space alone; Shared bookings may overlap each other.',
  'party_size', 'People expected in the space, from 1 to 500; NULL when not known.',
  'starts_at', 'In: when the booking starts.',
  'ends_at', 'Out: when the booking ends; after the start.',
  'notes', 'Notes for the desk.'
]);

create trigger t39_space_booking_project before insert or update on app.space_bookings
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');

create or replace function private.guard_space_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_space app.spaces;
  v_venue uuid;
  v_cue_engagement uuid;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  select * into v_space from app.spaces s where s.id = new.space_id;
  if v_space.id is null or v_space.deleted_at is not null or v_space.org_id <> new.org_id then
    perform private.refuse('space_booking_space', 'A booking is for a live space of the org.');
  end if;
  select p.venue_id into v_venue from app.projects p where p.id = new.project_id;
  if v_venue is not null and v_space.venue_id <> v_venue then
    perform private.refuse('space_booking_venue', 'A booking is for a space of the project''s venue.');
  end if;
  if new.engagement_cue_id is not null then
    select ec.engagement_id into v_cue_engagement from app.engagement_cues ec where ec.id = new.engagement_cue_id and ec.deleted_at is null;
    if v_cue_engagement is null or (new.engagement_id is not null and new.engagement_id <> v_cue_engagement) then
      perform private.refuse('space_booking_set_engagement', 'The set time belongs to another engagement.');
    end if;
    new.engagement_id := v_cue_engagement;
    if (select e.project_id from app.engagements e where e.id = new.engagement_id) is distinct from new.project_id then
      perform private.refuse('space_booking_set_engagement', 'The set time belongs to an engagement of another project.');
    end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('space_bookings:' || new.space_id::text, 0));
  if exists (
      select 1 from app.space_bookings b
      where b.space_id = new.space_id and b.id <> new.id and b.deleted_at is null
        and tstzrange(b.starts_at, b.ends_at) && tstzrange(new.starts_at, new.ends_at)
        and (new.booking_mode = 'Exclusive' or b.booking_mode = 'Exclusive')) then
    perform private.refuse('space_booking_overlap', 'The space is booked exclusively at that time, or this exclusive booking overlaps another.');
  end if;
  return new;
end;
$$;

comment on function private.guard_space_booking() is 'A live space booking is for a live space of the org at the project''s venue; a booking for a set time takes the set''s engagement, of the same project (engagement_id is filled from the set time); an Exclusive booking overlaps no live booking of the space and a Shared one no Exclusive booking. Refusals: space_booking_space, space_booking_venue, space_booking_set_engagement, space_booking_overlap. Locks the space.';
revoke all on function private.guard_space_booking() from public, anon, authenticated;
create trigger t40_guard_space_booking before insert or update on app.space_bookings
  for each row execute function private.guard_space_booking();

-- The board ------------------------------------------------------------------------------------------------------------

-- The act a booking is for, named as 2657 names a party: the supplying account, else the engaged person. Engagements are
-- read with opportunities.engagement.read, which the hospitality desk may not hold, so the board reads the name here.
create or replace function private.booking_act_name(p_engagement_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(o.name, private.known_person_name(e.person_id))
  from app.engagements e
  left join app.counterparties cp on cp.id = e.counterparty_id
  left join app.organizations o on o.id = cp.organization_id
  where e.id = p_engagement_id and e.deleted_at is null
    and private.can_on_project(e.project_id, 'hospitality.fulfillment.read');
$$;

comment on function private.booking_act_name(uuid) is 'Name of the act an engagement books a space for: the account that supplies it, else the engaged person''s name when the reader may know it (private.known_person_name). NULL unless the signed-in person holds hospitality.fulfillment.read on the engagement''s project.';
revoke all on function private.booking_act_name(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need it.
grant execute on function private.booking_act_name(uuid) to authenticated, service_role;

-- Spaces and venues are read with places.venue.read or projects.project.read (0350), which the desk may not hold, so the
-- board reads the booked space here.
create or replace function private.booked_space(p_booking_id uuid)
returns table (space_name text, space_capacity integer, venue_id uuid, venue_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select sp.name, sp.capacity, sp.venue_id, v.name
  from app.space_bookings b
  join app.spaces sp on sp.id = b.space_id
  left join app.venues v on v.id = sp.venue_id
  where b.id = p_booking_id and private.can_on_project(b.project_id, 'hospitality.fulfillment.read');
$$;

comment on function private.booked_space(uuid) is 'The space a booking is for (name, capacity, venue and venue name), for a reader holding hospitality.fulfillment.read on the booking''s project; no row for anyone else.';
revoke all on function private.booked_space(uuid) from public, anon;
grant execute on function private.booked_space(uuid) to authenticated, service_role;

create view app.space_booking_board with (security_invoker = on) as
with live as (
  select b.* from app.space_bookings b where b.deleted_at is null
),
swept as (
  select l.*,
    max(l.ends_at) over (partition by l.space_id order by l.starts_at, l.id rows between unbounded preceding and 1 preceding) as previous_end
  from live l
),
clustered as (
  select s.*,
    sum(case when s.previous_end is null or s.starts_at >= s.previous_end then 1 else 0 end)
      over (partition by s.space_id order by s.starts_at, s.id) as cluster_seq
  from swept s
),
concurrent as (
  select c.*,
    (select coalesce(sum(coalesce(o.party_size, 0)), 0) from live o
     where o.space_id = c.space_id and o.starts_at <= c.starts_at and o.ends_at > c.starts_at) as party_at_start
  from clustered c
),
grouped as (
  select g.*,
    first_value(g.id) over k as cluster_first_id,
    (count(*) over k2)::integer as cluster_size,
    (sum(coalesce(g.party_size, 0)) over k2)::integer as cluster_party_total,
    (max(g.party_at_start) over k2)::integer as cluster_peak
  from concurrent g
  window k as (partition by g.space_id, g.cluster_seq order by g.starts_at, g.id),
    k2 as (partition by g.space_id, g.cluster_seq)
)
select g.id, g.org_id, g.project_id, g.space_id, sp.space_name, sp.space_capacity, sp.venue_id, sp.venue_name, g.engagement_id, g.engagement_cue_id, g.purpose, g.booking_mode, g.party_size, g.starts_at, g.ends_at,
  private.booking_act_name(g.engagement_id) as act_name,
  c.label as set_label, c.planned_at as set_planned_at, coalesce(c.planned_at + c.duration, c.planned_at) as set_ends_at,
  coalesce(c.planned_at < g.starts_at or coalesce(c.planned_at + c.duration, c.planned_at) > g.ends_at, false) as set_moved,
  case when g.cluster_size > 1 then g.cluster_first_id end as conflict_group,
  g.cluster_size as group_size,
  g.cluster_party_total as group_party_total,
  g.cluster_peak as group_peak_party,
  case when sp.space_capacity is null then null else g.cluster_peak > sp.space_capacity end as over_capacity,
  g.notes
from grouped g
left join lateral private.booked_space(g.id) sp on true
left join app.engagement_cues ec on ec.id = g.engagement_cue_id and ec.deleted_at is null
left join app.cues c on c.id = ec.cue_id and c.deleted_at is null;

call private.describe('app.space_booking_board', 'Each live space booking the reader may see (B5, G-32) with its space, act and set time, and what is computed on every read: the cluster of overlapping bookings of one space it belongs to (a running-max sweep by start time), the cluster''s peak party size against the space''s capacity, and whether the set moved outside the booking. Rows follow the bookings'' policies (hospitality.fulfillment.read on the project); the set columns follow the running order''s (show.run_of_show.read) and are NULL without it.', array[
  'id', 'Booking.',
  'org_id', 'Owning org.',
  'project_id', 'Project.',
  'space_id', 'Space booked.',
  'space_name', 'Space name.',
  'space_capacity', 'Occupant capacity of the space; NULL when not measured.',
  'venue_id', 'Venue of the space.',
  'venue_name', 'Venue name.',
  'engagement_id', 'Engagement the space is for.',
  'engagement_cue_id', 'Set time the booking serves.',
  'purpose', 'What the space is booked as.',
  'booking_mode', 'Exclusive or Shared.',
  'party_size', 'People expected; NULL when not known.',
  'starts_at', 'In.',
  'ends_at', 'Out.',
  'act_name', 'The account that supplies the engagement, else the engaged person''s name when the reader may know it.',
  'set_label', 'Label of the set time''s cue.',
  'set_planned_at', 'Planned start of the set; NULL when not planned or not readable.',
  'set_ends_at', 'Planned start plus duration, or the planned start when no duration is set.',
  'set_moved', 'True when the set''s planned start is before the booking starts or its planned end after it ends: Set moved. False with no planned time.',
  'conflict_group', 'Id of the first booking of the cluster of overlapping bookings of the space this one belongs to; NULL when it overlaps none.',
  'group_size', 'Bookings in the cluster, 1 when it overlaps none.',
  'group_party_total', 'Sum of the party sizes in the cluster, NULL sizes counted as 0. Shown, never compared with capacity.',
  'group_peak_party', 'Highest sum of the party sizes of bookings covering one instant in the cluster, taken at each booking''s start; NULL sizes count as 0.',
  'over_capacity', 'True when the cluster''s peak party size exceeds the space''s capacity; NULL when the capacity is not measured.',
  'notes', 'Notes for the desk.'
]);

revoke all on app.space_booking_board from public, anon;
grant select on app.space_booking_board to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
revoke select on app.space_booking_board from xos_backup;

-- What an act reads ---------------------------------------------------------------------------------------------------

create or replace view api_external.space_bookings as
select b.id, b.engagement_id, b.project_id, sp.name as space_name, b.purpose, b.starts_at, b.ends_at, c.label as set_label
from app.space_bookings b
join app.spaces sp on sp.id = b.space_id
left join app.engagement_cues ec on ec.id = b.engagement_cue_id and ec.deleted_at is null
left join app.cues c on c.id = ec.cue_id and c.deleted_at is null
where b.deleted_at is null
  and (b.engagement_id in (select private.my_engagement_ids('operational'))
    or b.engagement_id in (select r.engagement_id from app.engagement_roster_entries r
                           where r.id in (select private.my_roster_entry_ids('operational'))));

comment on view api_external.space_bookings is 'Green rooms, dressing rooms and other spaces booked for the caller''s engagements while the operational area is open (B5, G-32): the engaged person''s, their account''s and a represented artist''s, and those of the engagement of a person''s operational roster entry. Space, purpose, in, out and the set''s label only; another act''s bookings, party sizes and notes never appear.';

revoke all on api_external.space_bookings from public, anon;
grant select on api_external.space_bookings to authenticated, service_role;

-- Domain events, comments, Realtime, retention and Trash ---------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('space_booking.created', 'space_bookings', 'A green room, dressing room or other space was booked on a project.'),
  ('space_booking.canceled', 'space_bookings', 'A space booking was canceled.')
on conflict (code) do nothing;

create trigger t90_emit_space_booking_created after insert on app.space_bookings
  for each row execute function private.emit_row_event('space_booking.created', 'project_id', 'space_id', 'engagement_id', 'starts_at', 'ends_at');
create trigger t90_emit_space_booking_canceled after update of deleted_at on app.space_bookings
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.emit_subject_event('space_booking.canceled', 'space_bookings', 'id', 'space_id', 'starts_at');

insert into private.comment_subjects (table_name) values ('app.space_bookings') on conflict do nothing;

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables p
                     where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = 'space_bookings') then
    alter publication supabase_realtime add table app.space_bookings;
  end if;
end;
$$;

call private.install_default_retention('app.space_bookings');

select private.sync_trash_tables();
