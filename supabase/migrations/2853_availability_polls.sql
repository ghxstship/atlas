-- 2853_availability_polls.sql
-- P8 (RRR-222; parity gap G-124; ADR 0022 block 2850 to 2859; ADR 0063 amended 2026-10-28). Availability polls
-- (Section 4.5.6 item 25, S4.5.6-25; Section 4.2 Crew, S4.2-07): a planner asks members and engaged freelancers for
-- their availability on chosen days of a project, and each recipient answers day by day.
--
--   * app.availability_polls, with its days (app.availability_poll_days) and recipients
--     (app.availability_poll_recipients), belongs to a project. Planners are the holders of crew.shift.write on it, as
--     in 2251 and ADR 0063: they read every poll, day and recipient row; a recipient reads the polls addressed to them
--     and their own recipient row, never the others'. Polls, days and recipients are created only by the RPCs below;
--     planners rename, close and remove a poll through its update policy (a removed poll goes to Trash), and may only
--     remove or restore one of its days or recipients.
--   * app.send_availability_poll creates the poll and notifies each recipient (availability.requested).
--   * app.answer_availability_poll writes the recipient's answers as availability blocks on their calendar kept for
--     the org (0740, person-owned), one full project-local day each, tagged with the poll. A day already inside the
--     org's notice lock (2251's t41) is returned unwritten, so the guard never raises inside the call. Only the RPC
--     tags a block with a poll (t42 below): the owner can neither forge nor move a poll answer through their policy.
--   * app.availability_poll_results gives planners each recipient's availability per day, by the precedence of
--     app.rank_shift_candidates; blocks without the poll's tag count only where 0740's and 2251's visibility already
--     shows the calendar to the caller, and notes never appear. Answering a poll shares those days with the org's
--     planners; the answer form says so. When a recipient responded is the time of their latest poll-tagged block,
--     computed, never stored; open or closed is computed from closes_at.
--   * app.my_availability_requests lists the open polls addressed to the signed-in person, one row per day.
-- Answers are availability blocks, so app.rank_shift_candidates ranks a member who answered Available over one who
-- left the day unstated, unchanged.

-- 1. The polls ---------------------------------------------------------------------------------------------------------

create table app.availability_polls (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  title text not null,
  message text,
  closes_at timestamptz,
  deleted_at timestamptz,
  constraint availability_polls_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint availability_polls_message_length check (message is null or char_length(btrim(message)) between 1 and 1000)
);

create index availability_polls_project_id_idx on app.availability_polls (project_id);

call private.install_domain_table('app.availability_polls', 'app.projects', 'project_id');
call private.describe('app.availability_polls', 'A planner''s request to members and engaged freelancers for their availability on chosen days of a project (ADR 0063). Open until closes_at, computed. Created through app.send_availability_poll; read by the project''s planners (crew.shift.write) and by its recipients.', array[
  'project_id', 'Project the poll asks about; never changes.',
  'title', 'Title the recipients see, 1 to 200 characters.',
  'message', 'Optional message to the recipients, up to 1,000 characters.',
  'closes_at', 'When answers stop being accepted; NULL keeps the poll open.'
]);

create table app.availability_poll_days (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  availability_poll_id uuid not null references app.availability_polls (id) on delete cascade,
  day date not null,
  deleted_at timestamptz
);

create unique index availability_poll_days_poll_day_key on app.availability_poll_days (availability_poll_id, day)
  where deleted_at is null;

call private.install_domain_table('app.availability_poll_days', 'app.availability_polls', 'availability_poll_id');
call private.describe('app.availability_poll_days', 'Days an availability poll asks about, dates of the project''s calendar. Written only by app.send_availability_poll; purged with their poll.', array[
  'availability_poll_id', 'Poll the day belongs to.',
  'day', 'Project-local date asked about.'
]);

create table app.availability_poll_recipients (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  availability_poll_id uuid not null references app.availability_polls (id) on delete cascade,
  person_id uuid not null references app.people (id),
  deleted_at timestamptz
);

create unique index availability_poll_recipients_poll_person_key on app.availability_poll_recipients (availability_poll_id, person_id)
  where deleted_at is null;
create index availability_poll_recipients_person_id_idx on app.availability_poll_recipients (person_id);

call private.install_domain_table('app.availability_poll_recipients', 'app.availability_polls', 'availability_poll_id');
call private.describe('app.availability_poll_recipients', 'People an availability poll asks: active members of the org or people with an open engagement with it. Written only by app.send_availability_poll; purged with their poll. When a recipient responded is computed from their answers, never stored.', array[
  'availability_poll_id', 'Poll the person is asked in.',
  'person_id', 'Person asked.'
]);

-- A poll stays on its project.
create or replace function private.guard_availability_poll()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    perform private.refuse('availability_poll_project', 'A poll stays on its project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_availability_poll() is 'An availability poll never moves to another project.';
revoke all on function private.guard_availability_poll() from public, anon, authenticated;

create trigger t40_guard_availability_poll before update on app.availability_polls
  for each row execute function private.guard_availability_poll();

-- 2. Who reads them ----------------------------------------------------------------------------------------------------

create or replace function private.my_availability_poll_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.availability_poll_id from app.availability_poll_recipients r
  where r.person_id = private.current_person_id() and r.deleted_at is null;
$$;

comment on function private.my_availability_poll_ids() is 'Availability polls the signed-in person is a live recipient of.';
revoke all on function private.my_availability_poll_ids() from public, anon;
grant execute on function private.my_availability_poll_ids() to authenticated, service_role;

create or replace function private.planned_availability_poll_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.availability_polls p where p.project_id in (select private.project_ids_with('crew.shift.write'));
$$;

comment on function private.planned_availability_poll_ids() is 'Availability polls of the projects the signed-in person plans crew on (crew.shift.write), live or removed.';
revoke all on function private.planned_availability_poll_ids() from public, anon;
grant execute on function private.planned_availability_poll_ids() to authenticated, service_role;

call private.install_policies('app.availability_polls',
  $$project_id in (select private.project_ids_with('crew.shift.write')) or id in (select private.my_availability_poll_ids())$$,
  null,
  $$project_id in (select private.project_ids_with('crew.shift.write'))$$);
call private.install_policies('app.availability_poll_days',
  $$availability_poll_id in (select private.planned_availability_poll_ids())
    or availability_poll_id in (select private.my_availability_poll_ids())$$,
  null,
  $$availability_poll_id in (select private.planned_availability_poll_ids())$$);
call private.install_policies('app.availability_poll_recipients',
  $$availability_poll_id in (select private.planned_availability_poll_ids())
    or person_id = (select private.current_person_id())$$,
  null,
  $$availability_poll_id in (select private.planned_availability_poll_ids())$$);
-- Days and recipients are created only by app.send_availability_poll. Planners may only remove or restore one, which
-- is also how Trash brings them back with their poll (1031 restores the rows deleted with it).
revoke update on app.availability_poll_days, app.availability_poll_recipients from authenticated;
grant update (deleted_at) on app.availability_poll_days, app.availability_poll_recipients to authenticated;

call private.install_audit_trail('app.availability_polls');
call private.install_audit_trail('app.availability_poll_days');
call private.install_audit_trail('app.availability_poll_recipients');
call private.install_default_retention('app.availability_polls');
call private.install_default_retention('app.availability_poll_days');
call private.install_default_retention('app.availability_poll_recipients');

-- 3. Answers are availability blocks tagged with the poll ----------------------------------------------------------------

alter table app.availability_blocks
  add column availability_poll_id uuid references app.availability_polls (id) on delete set null;

create index availability_blocks_availability_poll_id_idx on app.availability_blocks (availability_poll_id);

comment on column app.availability_blocks.availability_poll_id is 'Availability poll this block answers, set only by app.answer_availability_poll; NULL for a period the owner stated themselves. Planners of the poll''s project read the answer through app.availability_poll_results. Set to NULL when the poll is purged; the block stays the owner''s.';

create or replace function private.guard_block_poll()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.availability_poll_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.availability_poll_id is distinct from new.availability_poll_id then
    perform private.refuse('availability_poll_answer', 'A poll answer stays with its poll.');
  end if;
  -- The answer's day and kind change only by answering again; the owner may still clear the tag, write a
  -- note or move the block to Trash.
  if tg_op = 'UPDATE' and pg_catalog.current_setting('xos.availability_poll_answer', true) is distinct from 'on'
     and (old.starts_at, old.ends_at, old.availability_kind, old.availability_calendar_id)
         is distinct from (new.starts_at, new.ends_at, new.availability_kind, new.availability_calendar_id) then
    perform private.refuse('availability_poll_answer', 'Change a poll answer by answering the poll again.');
  end if;
  if tg_op = 'INSERT' and pg_catalog.current_setting('xos.availability_poll_answer', true) is distinct from 'on' then
    perform private.refuse('availability_poll_answer', 'Answer an availability poll from its request.');
  end if;
  if (select p.org_id from app.availability_polls p where p.id = new.availability_poll_id) is distinct from new.org_id then
    perform private.refuse('availability_poll_answer', 'A poll answer goes on the calendar kept for the poll''s organization.');
  end if;
  return new;
end;
$$;

comment on function private.guard_block_poll() is 'An availability block carries a poll only when app.answer_availability_poll writes it (the transaction-local setting xos.availability_poll_answer), keeps that poll (it may only be cleared), keeps its period, kind and calendar until the poll is answered again, and is on a calendar kept for the poll''s org.';
revoke all on function private.guard_block_poll() from public, anon, authenticated;

create trigger t42_guard_block_poll before insert or update on app.availability_blocks
  for each row execute function private.guard_block_poll();

-- 4. Sending a poll -----------------------------------------------------------------------------------------------------

create or replace function app.send_availability_poll(
  p_project_id uuid,
  p_title text,
  p_days date[],
  p_person_ids uuid[],
  p_message text default null,
  p_closes_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_org_name text;
  v_rule record;
  v_today date;
  v_days date[];
  v_people uuid[];
  v_outsider text;
  v_poll uuid;
  v_person uuid;
begin
  perform private.require_person();
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.can_on_project(p_project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project to ask for availability';
  end if;

  v_today := (now() at time zone v_project.time_zone)::date;
  if coalesce(cardinality(p_days), 0) = 0 or cardinality(p_days) > 31
     or exists (select 1 from unnest(p_days) d where d is null)
     or exists (select 1 from unnest(p_days) d group by d having count(*) > 1)
     or exists (select 1 from unnest(p_days) d where d < v_today) then
    perform private.refuse('availability_poll_days', 'Ask about 1 to 31 different days, none of them in the past.');
  end if;
  select array_agg(d order by d) into v_days from unnest(p_days) d;
  select * into v_rule from private.availability_rule(v_project.org_id);
  if v_rule.required and v_rule.notice_days > 0 and exists (
    select 1 from unnest(v_days) d
    where (d::timestamp at time zone v_project.time_zone) < now() + pg_catalog.make_interval(days => v_rule.notice_days)
  ) then
    perform private.refuse('availability_poll_inside_notice',
      format('Availability for the next %s days is locked; ask only about days after that.', v_rule.notice_days));
  end if;
  if p_closes_at is not null and p_closes_at <= now() then
    raise exception using errcode = '22023', message = 'a poll closes in the future';
  end if;

  if coalesce(cardinality(p_person_ids), 0) = 0 or cardinality(p_person_ids) > 200
     or exists (select 1 from unnest(p_person_ids) x where x is null)
     or exists (select 1 from unnest(p_person_ids) x group by x having count(*) > 1) then
    perform private.refuse('availability_poll_recipients', 'Ask 1 to 200 different people.');
  end if;
  v_people := p_person_ids;
  select coalesce(pe.full_name, 'A person') into v_outsider
  from unnest(v_people) x
  left join app.people pe on pe.id = x and pe.deleted_at is null
  where pe.id is null
     or not (private.is_active_member(x, v_project.org_id) or exists (
       select 1 from app.engagements e
       where e.person_id = x and e.org_id = v_project.org_id and e.deleted_at is null
         and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')))
  limit 1;
  if found then
    perform private.refuse('availability_poll_recipient',
      v_outsider || ' is neither a member of this organization nor engaged by it, so they cannot be asked.');
  end if;

  insert into app.availability_polls (project_id, title, message, closes_at)
  values (v_project.id, btrim(p_title), nullif(btrim(p_message), ''), p_closes_at)
  returning id into v_poll;
  insert into app.availability_poll_days (availability_poll_id, day)
  select v_poll, d from unnest(v_days) d;
  insert into app.availability_poll_recipients (availability_poll_id, person_id)
  select v_poll, x from unnest(v_people) x;

  v_org_name := (select o.name from app.organizations o where o.id = v_project.org_id);
  foreach v_person in array v_people loop
    perform private.notify(v_project.org_id, v_person, 'availability.requested', 'app.availability_polls', v_poll, v_project.id,
      jsonb_build_object('title', btrim(p_title), 'orgName', v_org_name, 'projectName', v_project.name,
        'firstDay', v_days[1], 'lastDay', v_days[cardinality(v_days)], 'dayCount', cardinality(v_days),
        'gatewayPath', '/profile#availability-requests'));
  end loop;
  return v_poll;
end;
$$;

comment on function app.send_availability_poll(uuid, text, date[], uuid[], text, timestamptz) is 'Asks 1 to 200 people for their availability on 1 to 31 project-local days from today (ADR 0063): each must be an active member of the project''s org or hold an engagement with it in Onboarding, Blocked, Active or Closing (availability_poll_recipient, naming the person). While the org requires availability, no day may fall inside its notice period (availability_poll_inside_notice). Notifies each recipient (availability.requested). Needs crew.shift.write on the project. Returns the poll id.';
revoke all on function app.send_availability_poll(uuid, text, date[], uuid[], text, timestamptz) from public, anon;
grant execute on function app.send_availability_poll(uuid, text, date[], uuid[], text, timestamptz) to authenticated, service_role;

-- 5. Answering ------------------------------------------------------------------------------------------------------------

create or replace function app.answer_availability_poll(p_poll_id uuid, p_answers jsonb)
returns table (day date, availability_kind app.availability_kind, written boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
  v_poll app.availability_polls;
  v_zone text;
  v_calendar uuid;
  v_member boolean;
  v_rule record;
  v_cutoff timestamptz;
  v_answer record;
  v_start timestamptz;
  v_earlier timestamptz;
begin
  select * into v_poll from app.availability_polls p where p.id = p_poll_id and p.deleted_at is null;
  if v_poll.id is null or not exists (
    select 1 from app.availability_poll_recipients r
    where r.availability_poll_id = v_poll.id and r.person_id = v_person and r.deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'only a recipient answers an availability poll';
  end if;
  if v_poll.closes_at is not null and v_poll.closes_at <= now() then
    perform private.refuse('availability_poll_closed', 'This poll has closed; tell your planner your availability directly.');
  end if;
  if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers) = 0
     or exists (
       select 1 from jsonb_array_elements(p_answers) a
       where jsonb_typeof(a) <> 'object'
          or (a ->> 'kind') is null or (a ->> 'kind') not in ('Available', 'Tentative', 'Unavailable')
          or (a ->> 'day') is null or (a ->> 'day') !~ '^\d{4}-\d{2}-\d{2}$'
          or not exists (select 1 from app.availability_poll_days d
                         where d.availability_poll_id = v_poll.id and d.deleted_at is null and d.day::text = a ->> 'day'))
     or (select count(distinct a ->> 'day') from jsonb_array_elements(p_answers) a) <> jsonb_array_length(p_answers) then
    perform private.refuse('availability_poll_answer', 'Answer each day of the poll once, as Available, Tentative or Unavailable.');
  end if;

  v_zone := (select p.time_zone from app.projects p where p.id = v_poll.project_id);
  select c.id into v_calendar from app.availability_calendars c
  where c.person_id = v_person and c.org_id = v_poll.org_id and c.deleted_at is null;
  if v_calendar is null then
    insert into app.availability_calendars (org_id, person_id, time_zone) values (v_poll.org_id, v_person, v_zone)
    returning id into v_calendar;
  end if;

  -- The notice lock, exactly as 2251's t41 applies it, so a locked day is reported rather than raised.
  v_member := private.is_active_member(v_person, v_poll.org_id);
  select * into v_rule from private.availability_rule(v_poll.org_id);
  v_cutoff := case when auth.uid() is not null and v_member and v_rule.required and v_rule.notice_days > 0
    then now() + pg_catalog.make_interval(days => v_rule.notice_days) end;

  for v_answer in
    select (a ->> 'day')::date as day, (a ->> 'kind')::app.availability_kind as kind
    from jsonb_array_elements(p_answers) a order by 1
  loop
    v_start := v_answer.day::timestamp at time zone v_zone;
    select min(b.starts_at) into v_earlier from app.availability_blocks b
    where b.availability_calendar_id = v_calendar and b.availability_poll_id = v_poll.id and b.deleted_at is null
      and b.starts_at = v_start;
    if v_cutoff is not null and (v_start < v_cutoff or v_earlier < v_cutoff) then
      day := v_answer.day;
      availability_kind := v_answer.kind;
      written := false;
      return next;
      continue;
    end if;
    perform pg_catalog.set_config('xos.availability_poll_answer', 'on', true);
    update app.availability_blocks b set deleted_at = now()
    where b.availability_calendar_id = v_calendar and b.availability_poll_id = v_poll.id and b.deleted_at is null
      and b.starts_at = v_start;
    insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind, availability_poll_id)
    values (v_calendar, v_start, (v_answer.day + 1)::timestamp at time zone v_zone, v_answer.kind, v_poll.id);
    perform pg_catalog.set_config('xos.availability_poll_answer', 'off', true);
    day := v_answer.day;
    availability_kind := v_answer.kind;
    written := true;
    return next;
  end loop;
end;
$$;

comment on function app.answer_availability_poll(uuid, jsonb) is 'Writes the signed-in recipient''s answers ([{day, kind}], Available, Tentative or Unavailable) to an open availability poll as blocks on their calendar kept for the org (opened in the project''s zone when they have none), each from the start of the project-local day to the start of the next, tagged with the poll. A later answer for a day replaces the earlier. A day inside the org''s notice lock (2251) comes back with written false and nothing written. Refuses a closed poll and an answer outside its days; only a recipient may call it. Answering shares those days with the org''s planners.';
revoke all on function app.answer_availability_poll(uuid, jsonb) from public, anon;
grant execute on function app.answer_availability_poll(uuid, jsonb) to authenticated, service_role;

-- 6. Results for planners -------------------------------------------------------------------------------------------------

create or replace function app.availability_poll_results(p_poll_id uuid)
returns table (
  person_id uuid,
  full_name text,
  day date,
  availability text,
  answered_by_poll boolean,
  responded_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_poll app.availability_polls;
  v_zone text;
begin
  perform private.require_person();
  select * into v_poll from app.availability_polls p where p.id = p_poll_id and p.deleted_at is null;
  if v_poll.id is null or not private.can_on_project(v_poll.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the poll''s project';
  end if;
  v_zone := (select p.time_zone from app.projects p where p.id = v_poll.project_id);
  return query
  with grid as (
    select r.person_id, pe.full_name, d.day,
      d.day::timestamp at time zone v_zone as day_start,
      (d.day + 1)::timestamp at time zone v_zone as day_end
    from app.availability_poll_recipients r
    join app.availability_poll_days d on d.availability_poll_id = r.availability_poll_id and d.deleted_at is null
    left join app.people pe on pe.id = r.person_id
    where r.availability_poll_id = v_poll.id and r.deleted_at is null
  ), blocks as (
    -- The recipient's calendar kept for the org: the blocks answering this poll, and any other block there only when
    -- the caller may already see that calendar (0740, 2251), so a freelancer's Private calendar stays private.
    select c.person_id, b.availability_kind, b.starts_at, b.ends_at, b.availability_poll_id = v_poll.id as by_poll
    from app.availability_blocks b
    join app.availability_calendars c on c.id = b.availability_calendar_id and c.deleted_at is null
    where b.deleted_at is null and c.org_id = v_poll.org_id
      and c.person_id in (select g.person_id from grid g)
      and (b.availability_poll_id is not distinct from v_poll.id
           or private.availability_shared_with_me(c.person_id, c.org_id, c.visibility))
  )
  select g.person_id, g.full_name, g.day,
    case
      when exists (select 1 from blocks b where b.person_id = g.person_id and b.starts_at < g.day_end and b.ends_at > g.day_start
                   and b.availability_kind = 'Unavailable') then 'Unavailable'
      when exists (select 1 from blocks b where b.person_id = g.person_id and b.availability_kind = 'Available'
                   and b.starts_at <= g.day_start and b.ends_at >= g.day_end) then 'Available'
      when exists (select 1 from blocks b where b.person_id = g.person_id and b.starts_at < g.day_end and b.ends_at > g.day_start) then 'Tentative'
      else 'Unstated'
    end,
    exists (select 1 from blocks b where b.person_id = g.person_id and b.by_poll and b.starts_at < g.day_end and b.ends_at > g.day_start),
    (select max(b.created_at) from app.availability_blocks b
     join app.availability_calendars c on c.id = b.availability_calendar_id
     where c.person_id = g.person_id and b.availability_poll_id = v_poll.id)
  from grid g
  order by g.full_name nulls last, g.person_id, g.day;
end;
$$;

comment on function app.availability_poll_results(uuid) is 'Each recipient''s availability on each day of a poll, for the poll project''s planners (crew.shift.write): Unavailable, Available covering the project-local day, Tentative (partly stated or tentative) or Unstated, by the precedence of app.rank_shift_candidates, from their calendar kept for the org. Blocks answering the poll always count; other blocks there count only where the caller may see the calendar. answered_by_poll says the poll''s answer covers the day; responded_at is the time of the recipient''s latest answer to it. Notes never appear; computed, never stored.';
revoke all on function app.availability_poll_results(uuid) from public, anon;
grant execute on function app.availability_poll_results(uuid) to authenticated, service_role;

-- 7. The recipient's requests ---------------------------------------------------------------------------------------------

create or replace function app.my_availability_requests()
returns table (
  poll_id uuid,
  org_id uuid,
  org_name text,
  project_name text,
  title text,
  message text,
  closes_at timestamptz,
  day date,
  answer app.availability_kind,
  locked boolean,
  responded_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
begin
  return query
  with polls as (
    select p.id, p.org_id, o.name as org_name, pr.name as project_name, pr.time_zone, p.title, p.message, p.closes_at,
      r.required, r.notice_days, private.is_active_member(v_person, p.org_id) as member
    from app.availability_polls p
    join app.availability_poll_recipients x on x.availability_poll_id = p.id and x.person_id = v_person and x.deleted_at is null
    join app.organizations o on o.id = p.org_id
    join app.projects pr on pr.id = p.project_id
    cross join lateral private.availability_rule(p.org_id) r
    where p.deleted_at is null and (p.closes_at is null or p.closes_at > now())
  ), days as (
    select p.*, d.day, d.day::timestamp at time zone p.time_zone as day_start
    from polls p
    join app.availability_poll_days d on d.availability_poll_id = p.id and d.deleted_at is null
    where d.day >= (now() at time zone p.time_zone)::date
  )
  select d.id, d.org_id, d.org_name, d.project_name, d.title, d.message, d.closes_at, d.day,
    (select b.availability_kind from app.availability_blocks b
     join app.availability_calendars c on c.id = b.availability_calendar_id
     where c.person_id = v_person and b.availability_poll_id = d.id and b.deleted_at is null and b.starts_at = d.day_start
     order by b.created_at desc limit 1),
    d.member and d.required and d.notice_days > 0
      and d.day_start < now() + pg_catalog.make_interval(days => d.notice_days),
    (select max(b.created_at) from app.availability_blocks b
     join app.availability_calendars c on c.id = b.availability_calendar_id
     where c.person_id = v_person and b.availability_poll_id = d.id)
  from days d
  order by d.closes_at nulls last, d.id, d.day;
end;
$$;

comment on function app.my_availability_requests() is 'The open availability polls addressed to the signed-in person, one row per day from today: the org and project, title, message and closing time, their current answer for the day, whether the org''s notice lock (2251) already holds the day, and when they last answered the poll.';
revoke all on function app.my_availability_requests() from public, anon;
grant execute on function app.my_availability_requests() to authenticated, service_role;

-- 8. Trash ---------------------------------------------------------------------------------------------------------------
-- ADR 0110: a removed poll is a mistake a planner can undo, and its update policy lets them restore it, so it goes to
-- Trash titled by its title. Its days and recipients have no title column and stay out.

select private.sync_trash_tables();
