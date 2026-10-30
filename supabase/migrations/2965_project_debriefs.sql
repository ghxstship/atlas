-- 2965_project_debriefs.sql
-- B7 (RRR-231, ADR 0146 decisions 5 and 6; gap G-267). A project's wrap-up: a structured debrief and a management
-- summary, printed with budget against actuals, attendance, carbon and incidents as the wrap-up report.
--
--   * app.project_debriefs: the one live debrief of a project, read with projects.project.read. Written only by
--     app.save_project_debrief, app.complete_project_debrief and app.reopen_project_debrief; completion is stamped
--     once inside the trusted operations debrief_completion and debrief_reopen, and the audit trail records both.
--   * app.project_debrief_items: the debrief's points (area, Went Well, To Improve or Action, the point, an owner for
--     an Action only), written under projects.project.write while the debrief is open. Deleted points are in Trash,
--     and a point is never restored under a completed debrief (debrief_completed).
--   * app.project_debrief_summaries: the management summary, kept apart from the debrief because it is drafted from
--     budget, measurement and incident facts. Its readers hold projects.project.read, finance.budget.read,
--     projects.gate.read and safety.incident.read on the project and finance.journal.read in the org; others see
--     "Not included". Written only by app.save_project_debrief.
--   * A summary drafted with Aurora (Section 4.7, EU AI Act Article 50) is stored only when a person saves it, linked to
--     its app.ai_requests row (the same org, the saver, feature summaries, the project as subject, Answered; else
--     debrief_ai_request), stamped with who saved it and when, and flagged ai_drafted. The flag outlives the request
--     row, which is purged by age (0650), so the "Drafted with Aurora and reviewed by" label survives the purge.
--   * app.my_capabilities_on_project (from 0470, its only definition) also answers finance.budget.read and
--     projects.gate.read, which decide the wrap-up sections a reader gets.
--   * Trash (ADR 0110): points are in Trash, titled by their text. A debrief is never deleted by members; it is
--     reopened instead, so it is listed in private.trash_excluded_tables. No view is created.

create type app.debrief_area as enum ('Schedule', 'Budget', 'Safety', 'Audience', 'Sustainability', 'Crew', 'Vendors', 'Other');
comment on type app.debrief_area is 'Area of a project debrief point (ADR 0146 decision 5).';

create type app.debrief_item_kind as enum ('Went Well', 'To Improve', 'Action');
comment on type app.debrief_item_kind is 'Kind of a project debrief point: what went well, what to improve, or an action with an owner.';

-- 1. The debrief ------------------------------------------------------------------------------------------------------

create table app.project_debriefs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  completed_at timestamptz,
  completed_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint project_debriefs_completed_pair check ((completed_at is null) = (completed_by is null))
);

create unique index project_debriefs_project_key on app.project_debriefs (project_id) where deleted_at is null;
create index project_debriefs_completed_by_idx on app.project_debriefs (completed_by);

call private.install_project_table('app.project_debriefs', 'projects.project.read', 'projects.project.write');
call private.describe('app.project_debriefs', 'The debrief of a project''s wrap-up (ADR 0146 decision 5): one live debrief per project, completed once and reopened when it needs a change. Written only by app.save_project_debrief, app.complete_project_debrief and app.reopen_project_debrief.', array[
  'project_id', 'Project the debrief wraps up.',
  'completed_at', 'When the debrief was completed; its points and summary are locked until it is reopened.',
  'completed_by', 'Person who completed the debrief.'
]);
revoke insert, update on app.project_debriefs from authenticated;
call private.install_audit_trail('app.project_debriefs');
call private.install_default_retention('app.project_debriefs');

create or replace function private.guard_project_debrief()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.completed_at is not null or new.completed_by is not null then
      perform private.refuse('debrief_completed', 'A debrief is completed with app.complete_project_debrief.');
    end if;
    return new;
  end if;
  if (new.completed_at, new.completed_by) is distinct from (old.completed_at, old.completed_by) then
    if new.completed_at is not null and not private.in_trusted_operation('debrief_completion') then
      perform private.refuse('debrief_completed', 'A debrief is completed with app.complete_project_debrief.');
    end if;
    if new.completed_at is null and not private.in_trusted_operation('debrief_reopen') then
      perform private.refuse('debrief_completed', 'A debrief is reopened with app.reopen_project_debrief.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_project_debrief() is 'Before insert or update on app.project_debriefs: completion is stamped only by app.complete_project_debrief (trusted operation debrief_completion) and cleared only by app.reopen_project_debrief (debrief_reopen).';
revoke all on function private.guard_project_debrief() from public, anon, authenticated;
create trigger t40_guard_project_debrief before insert or update on app.project_debriefs
  for each row execute function private.guard_project_debrief();

create or replace function private.project_debrief_completed(p_debrief_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.project_debriefs d where d.id = p_debrief_id and d.completed_at is not null);
$$;
comment on function private.project_debrief_completed(uuid) is 'True when the debrief is completed, so its points and summary are locked.';
revoke all on function private.project_debrief_completed(uuid) from public, anon, authenticated;

-- 2. Points ----------------------------------------------------------------------------------------------------------------

create table app.project_debrief_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  debrief_id uuid not null references app.project_debriefs (id),
  area app.debrief_area not null,
  item_kind app.debrief_item_kind not null,
  body text not null,
  position integer not null,
  owner_membership_id uuid references app.memberships (id),
  deleted_at timestamptz,
  constraint project_debrief_items_body_length check (char_length(btrim(body)) between 1 and 2000),
  constraint project_debrief_items_position_positive check (position > 0),
  constraint project_debrief_items_owner_for_action check (owner_membership_id is null or item_kind = 'Action')
);

create index project_debrief_items_debrief_id_idx on app.project_debrief_items (debrief_id, position);
create index project_debrief_items_owner_membership_id_idx on app.project_debrief_items (owner_membership_id);

call private.install_child_table('app.project_debrief_items', 'app.project_debriefs', 'debrief_id', 'projects.project.read',
  'projects.project.write', array['app.memberships', 'owner_membership_id']);
call private.describe('app.project_debrief_items', 'Points of a project debrief (ADR 0146 decision 5): what went well, what to improve and actions, by area. Locked while the debrief is completed.', array[
  'debrief_id', 'Debrief the point belongs to.',
  'area', 'Area of the project the point is about.',
  'item_kind', 'Went Well, To Improve or Action.',
  'body', 'The point, up to 2000 characters.',
  'position', 'Order of the point in the debrief, from 1; the next free position when omitted.',
  'owner_membership_id', 'Member who owns an Action. Only Actions have an owner.'
]);
call private.install_audit_trail('app.project_debrief_items');
call private.install_default_retention('app.project_debrief_items');

create or replace function private.guard_project_debrief_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.project_debrief_completed(case when tg_op = 'DELETE' then old.debrief_id else new.debrief_id end)
     or (tg_op = 'UPDATE' and new.debrief_id is distinct from old.debrief_id and private.project_debrief_completed(old.debrief_id)) then
    perform private.refuse('debrief_completed', 'This debrief is completed. Reopen it to change its points.');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'INSERT' and new.position is null then
    new.position := coalesce((select max(i.position) from app.project_debrief_items i
                              where i.debrief_id = new.debrief_id and i.deleted_at is null), 0) + 1;
  end if;
  return new;
end;
$$;
comment on function private.guard_project_debrief_item() is 'Before insert, update or delete on app.project_debrief_items: refuses any change under a completed debrief, a restore from Trash included (debrief_completed), and gives a new point without a position the next free one.';
revoke all on function private.guard_project_debrief_item() from public, anon, authenticated;
create trigger t40_guard_project_debrief_item before insert or update or delete on app.project_debrief_items
  for each row execute function private.guard_project_debrief_item();

-- 3. The management summary ------------------------------------------------------------------------------------------------

create table app.project_debrief_summaries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  debrief_id uuid not null references app.project_debriefs (id),
  management_summary text not null,
  management_summary_ai_request_id uuid references app.ai_requests (id) on delete set null,
  ai_drafted boolean not null default false,
  summary_by uuid references app.people (id),
  summary_at timestamptz,
  deleted_at timestamptz,
  constraint project_debrief_summaries_length check (char_length(management_summary) between 1 and 4000)
);

create unique index project_debrief_summaries_debrief_key on app.project_debrief_summaries (debrief_id) where deleted_at is null;
create index project_debrief_summaries_ai_request_idx on app.project_debrief_summaries (management_summary_ai_request_id);
create index project_debrief_summaries_summary_by_idx on app.project_debrief_summaries (summary_by);

call private.install_domain_table('app.project_debrief_summaries', 'app.project_debriefs', 'debrief_id',
  array['app.ai_requests', 'management_summary_ai_request_id']);
call private.describe('app.project_debrief_summaries', 'The management summary of a project debrief (ADR 0146 decision 6). It is drafted from budget, measurement and incident facts, so only readers of all of them read it. A summary drafted with Aurora is stored only when a person saves it, linked to its request and flagged, and printed as drafted with Aurora and reviewed by that person. Written only by app.save_project_debrief.', array[
  'debrief_id', 'Debrief the summary belongs to.',
  'management_summary', 'The summary for management, 1 to 4000 characters.',
  'management_summary_ai_request_id', 'Aurora request the summary was drafted from, when it was; cleared when the request is purged by age.',
  'ai_drafted', 'True when the saved summary was drafted with Aurora. It outlives the purge of the request row.',
  'summary_by', 'Person who saved the summary: its author, or its reviewer when Aurora drafted it.',
  'summary_at', 'When the summary was saved.'
]);
call private.install_policies('app.project_debrief_summaries',
  $$debrief_id in (select d.id from app.project_debriefs d
    where d.project_id in (select private.project_ids_with('projects.project.read'))
      and d.project_id in (select private.project_ids_with('finance.budget.read'))
      and d.project_id in (select private.project_ids_with('projects.gate.read'))
      and d.project_id in (select private.project_ids_with('safety.incident.read'))
      and d.org_id in (select private.orgs_with_capability('finance.journal.read')))$$);
revoke insert, update on app.project_debrief_summaries from authenticated;
call private.install_audit_trail('app.project_debrief_summaries');
call private.install_default_retention('app.project_debrief_summaries');

create or replace function private.guard_project_debrief_summary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_request app.ai_requests;
begin
  -- The purge of an old request row clears only the link (on delete set null); the flag and the stamps stay.
  if tg_op = 'UPDATE' and old.management_summary_ai_request_id is not null and new.management_summary_ai_request_id is null
     and (new.management_summary, new.ai_drafted, new.summary_by, new.summary_at, new.deleted_at)
         is not distinct from (old.management_summary, old.ai_drafted, old.summary_by, old.summary_at, old.deleted_at) then
    return new;
  end if;
  if private.project_debrief_completed(new.debrief_id) then
    perform private.refuse('debrief_completed', 'This debrief is completed. Reopen it to change its summary.');
  end if;
  if new.management_summary_ai_request_id is not null
     and (tg_op = 'INSERT' or new.management_summary_ai_request_id is distinct from old.management_summary_ai_request_id) then
    select d.project_id into v_project from app.project_debriefs d where d.id = new.debrief_id;
    select * into v_request from app.ai_requests r where r.id = new.management_summary_ai_request_id;
    if v_request.id is null or v_request.org_id is distinct from new.org_id
       or v_request.person_id is distinct from private.current_person_id() or v_request.feature <> 'summaries'
       or v_request.subject_table is distinct from 'app.projects' or v_request.subject_id is distinct from v_project
       or v_request.outcome <> 'Answered' then
      perform private.refuse('debrief_ai_request', 'Save a summary Aurora drafted for this project at your request.');
    end if;
    new.ai_drafted := true;
  end if;
  if tg_op = 'INSERT' or new.management_summary is distinct from old.management_summary
     or new.management_summary_ai_request_id is distinct from old.management_summary_ai_request_id
     or new.ai_drafted is distinct from old.ai_drafted then
    new.summary_by := private.current_person_id();
    new.summary_at := now();
  end if;
  return new;
end;
$$;
comment on function private.guard_project_debrief_summary() is 'Before insert or update on app.project_debrief_summaries: refuses any change under a completed debrief (debrief_completed); a newly linked Aurora request must be the saver''s own Answered summaries request about this project in this org (else debrief_ai_request) and flags the summary ai_drafted; every save stamps summary_by and summary_at. The purge of an old request only clears the link.';
revoke all on function private.guard_project_debrief_summary() from public, anon, authenticated;
create trigger t40_guard_project_debrief_summary before insert or update on app.project_debrief_summaries
  for each row execute function private.guard_project_debrief_summary();

-- 4. Writes ------------------------------------------------------------------------------------------------------------

create or replace function app.save_project_debrief(
  p_project_id uuid, p_management_summary text default null, p_ai_request_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_debrief app.project_debriefs;
  v_summary app.project_debrief_summaries;
  v_text text := btrim(p_management_summary);
begin
  perform private.require_person();
  if p_project_id is null or not private.can_on_project(p_project_id, 'projects.project.write') then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  select * into v_debrief from app.project_debriefs d where d.project_id = p_project_id and d.deleted_at is null for update;
  if v_debrief.id is null then
    insert into app.project_debriefs (project_id) values (p_project_id) returning * into v_debrief;
  end if;
  if p_management_summary is null then
    return v_debrief.id;
  end if;
  if v_debrief.completed_at is not null then
    perform private.refuse('debrief_completed', 'This debrief is completed. Reopen it to change its summary.');
  end if;
  if char_length(v_text) > 4000 then
    perform private.refuse('debrief_summary', 'Write a management summary of up to 4000 characters.');
  end if;
  select * into v_summary from app.project_debrief_summaries s where s.debrief_id = v_debrief.id and s.deleted_at is null for update;
  if v_text = '' then
    update app.project_debrief_summaries set deleted_at = now() where id = v_summary.id;
  elsif v_summary.id is null then
    insert into app.project_debrief_summaries (debrief_id, management_summary, management_summary_ai_request_id, ai_drafted)
    values (v_debrief.id, v_text, p_ai_request_id, false);
  else
    update app.project_debrief_summaries
    set management_summary = v_text, management_summary_ai_request_id = p_ai_request_id,
      ai_drafted = case when p_ai_request_id is null then false
                        when p_ai_request_id is not distinct from v_summary.management_summary_ai_request_id then v_summary.ai_drafted
                        else false end
    where id = v_summary.id;
  end if;
  return v_debrief.id;
end;
$$;
comment on function app.save_project_debrief(uuid, text, uuid) is 'Creates the project''s debrief when there is none and returns its id (ADR 0146 decision 5). With a summary, saves it as the management summary: a blank one clears it, and null leaves it as it is. With p_ai_request_id the summary is the Aurora draft the caller reviewed (Section 4.7): the request must be their own Answered summaries request about this project (debrief_ai_request); without it the summary is the caller''s own writing and the Aurora flag is cleared. Needs projects.project.write. Refuses debrief_completed while the debrief is completed and debrief_summary over 4000 characters.';

create or replace function app.complete_project_debrief(p_project_debrief_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_debrief app.project_debriefs;
begin
  select * into v_debrief from app.project_debriefs d where d.id = p_project_debrief_id and d.deleted_at is null for update;
  if v_debrief.id is null or not private.can_on_project(v_debrief.project_id, 'projects.project.write') then
    raise exception using errcode = '42501', message = 'project debrief not found';
  end if;
  if v_debrief.completed_at is not null then
    perform private.refuse('debrief_completed', 'This debrief is already completed.');
  end if;
  perform private.begin_trusted_operation('debrief_completion');
  update app.project_debriefs set completed_at = now(), completed_by = v_person where id = v_debrief.id;
  perform private.end_trusted_operation('debrief_completion');
end;
$$;
comment on function app.complete_project_debrief(uuid) is 'Completes a project debrief once, stamping who and when; its points and summary are locked until it is reopened (debrief_completed when already complete). Needs projects.project.write. The audit trail records it.';

create or replace function app.reopen_project_debrief(p_project_debrief_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_debrief app.project_debriefs;
begin
  perform private.require_person();
  select * into v_debrief from app.project_debriefs d where d.id = p_project_debrief_id and d.deleted_at is null for update;
  if v_debrief.id is null or not private.can_on_project(v_debrief.project_id, 'projects.project.write') then
    raise exception using errcode = '42501', message = 'project debrief not found';
  end if;
  if v_debrief.completed_at is null then
    return;
  end if;
  perform private.begin_trusted_operation('debrief_reopen');
  update app.project_debriefs set completed_at = null, completed_by = null where id = v_debrief.id;
  perform private.end_trusted_operation('debrief_reopen');
end;
$$;
comment on function app.reopen_project_debrief(uuid) is 'Reopens a completed project debrief so its points and summary can change again; an open debrief is left as it is. Needs projects.project.write. The audit trail records it.';

revoke all on function app.save_project_debrief(uuid, text, uuid) from public, anon;
grant execute on function app.save_project_debrief(uuid, text, uuid) to authenticated, service_role;
revoke all on function app.complete_project_debrief(uuid) from public, anon;
grant execute on function app.complete_project_debrief(uuid) to authenticated, service_role;
revoke all on function app.reopen_project_debrief(uuid) from public, anon;
grant execute on function app.reopen_project_debrief(uuid) to authenticated, service_role;

-- 5. Which wrap-up sections a reader gets (from 0470) -------------------------------------------------------------------

create or replace function app.my_capabilities_on_project(p_project_id uuid, p_capabilities text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c order by c), '{}')
  from unnest(p_capabilities) c
  where (c like 'credentials.%' or c like 'safety.%' or c like 'data.restricted.%' or c in ('finance.budget.read', 'projects.gate.read'))
    and private.can_on_project(p_project_id, c);
$$;
comment on function app.my_capabilities_on_project(uuid, text[]) is 'Which of the named credentials, safety and restricted-data capabilities, and finance.budget.read and projects.gate.read (the wrap-up report''s sections, ADR 0146), the signed-in person may use on a project. Only shapes which controls and sections the apps show; row level security and the RPCs still decide every read and write.';
revoke all on function app.my_capabilities_on_project(uuid, text[]) from public, anon;
grant execute on function app.my_capabilities_on_project(uuid, text[]) to authenticated, service_role;

-- 6. Trash ------------------------------------------------------------------------------------------------------------------

insert into private.trash_excluded_tables (table_name, rationale) values
  ('project_debriefs', 'One per project and never deleted by members; reopened instead.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();
