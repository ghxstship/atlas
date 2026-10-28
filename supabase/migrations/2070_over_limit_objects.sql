-- 2070_over_limit_objects.sql
-- A107 (RRR-152), S16-07, finding A65-015, Section 16: "Downgrades never delete data. They make over-limit objects
-- read-only with a clear explanation." Terms of Service 5.2: at the end of a trial, "Objects over the Access limits
-- become read-only." ADR 0081 records the rules.
--
-- Nothing is deleted when a trial ends (1350 moves it to Access) or a plan goes down, and
-- private.assert_within_plan_limit refuses new objects over a limit. Until now the objects already over a limit stayed
-- writable. This migration makes them read-only:
--   * Which limits: the three that count standing objects. active_projects counts projects that are not archived,
--     deleted, completed or canceled; seats counts memberships whose best role is above Field; field_members counts
--     memberships whose best role is Field. The two monthly limits (external engagements and Aurora requests) count
--     what happens in a month, so they keep refusing new acts and never make an object read-only (ADR 0081).
--   * Which objects: within each limit the objects are ranked, and those past the limit are read-only. Owners rank
--     first among seats and are never read-only, so an Owner can always reach Billing and Plan. Then come the objects
--     the Owner chose to keep writable (app.plan_limit_choices, set through app.choose_plan_limit_keeps in 2071), then
--     the oldest. Without a choice, the oldest stay writable.
--   * app.over_limit_objects holds the result. private.recompute_over_limit rewrites an org's rows from the plan in
--     force and the objects counted. Triggers in the database call it, never webhook code: a subscription's plan,
--     state, extra seats or grandfathering changing (a trial ending, a downgrade, an upgrade, a cancellation, Stripe or
--     a partner or the console setting the plan); a console plan or limit override made or ended (1471); a project
--     archived, deleted, restored or changing state; a role assigned or removed; a membership ending; the plan limits
--     themselves changing. The hourly lifecycle job also refreshes orgs with read-only objects, so a membership that
--     ends at its valid_to lifts a seat on time, and orgs whose memberships began or whose overrides started or
--     expired in the last two hours.
--   * The guard: the read-only row guard of 1063 (t15_refuse_read_only_org, on every app table with org_id that is
--     not exempt) now also refuses a person's write to a read-only project or to anything of it, however deep: a row
--     that carries the project's id, belongs to one of its records or engagements, is about one of its rows (a comment
--     thread, an attachment) or descends from one through the parent it takes its org from (a budget line, a comment,
--     a PO line). It also refuses every write of a person whose own seat is read-only. The personal tables of
--     private.over_limit_personal_tables (a person's membership, preferences, consents, follows and reading marks)
--     stay writable, though a read-only seat only leaves or drops its own roles there. Archiving or deleting
--     a read-only project stays allowed, since it brings the org back under the limit. Each refusal is
--     plan_limit_read_only and names the plan, the limit, the count and how to lift it. Workers, billing and
--     retention (no person) still write.
--   * Restoring an archived or deleted project now counts against active_projects like creating or reopening one,
--     so a restore never silently turns another project read-only.

-- The Owner's choice ------------------------------------------------------------------------------------------------

create table app.plan_limit_choices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  limit_code app.plan_limit_code not null,
  project_id uuid references app.projects (id) on delete cascade,
  membership_id uuid references app.memberships (id) on delete cascade,
  constraint plan_limit_choices_limit check (limit_code in ('active_projects', 'seats', 'field_members')),
  constraint plan_limit_choices_subject check (num_nonnulls(project_id, membership_id) = 1),
  constraint plan_limit_choices_subject_limit check ((limit_code = 'active_projects') = (project_id is not null))
);

call private.install_domain_table('app.plan_limit_choices', null, null,
  array['app.projects', 'project_id', 'app.memberships', 'membership_id']);
create unique index plan_limit_choices_project_key on app.plan_limit_choices (project_id) where deleted_at is null;
create index plan_limit_choices_project_id_idx on app.plan_limit_choices (project_id);
create unique index plan_limit_choices_membership_key on app.plan_limit_choices (membership_id, limit_code) where deleted_at is null;
create index plan_limit_choices_membership_id_idx on app.plan_limit_choices (membership_id);
call private.describe('app.plan_limit_choices', 'What the Owner chose to keep writable when the org is over a plan limit (Section 16, ADR 0081): projects for active_projects, members for seats and field_members. Chosen objects rank before the oldest; past the limit the rest are read-only. Written only by app.choose_plan_limit_keeps, which replaces a limit''s choice as a set.', array[
  'limit_code', 'Limit the choice is for: active_projects, seats or field_members.',
  'project_id', 'Project kept writable, for active_projects.',
  'membership_id', 'Member kept writable, for seats or field_members.'
]);

call private.install_policies('app.plan_limit_choices',
  $$org_id in (select private.orgs_with_capability('org.billing.read'))$$);
call private.install_audit_trail('app.plan_limit_choices');

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.plan_limit_choices', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'A replaced choice is history only; the audit trail keeps who chose what.');

-- The read-only objects ----------------------------------------------------------------------------------------------

create table app.over_limit_objects (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  limit_code app.plan_limit_code not null,
  plan_code text not null references app.plans (code),
  project_id uuid references app.projects (id) on delete cascade,
  membership_id uuid references app.memberships (id) on delete cascade,
  constraint over_limit_objects_limit check (limit_code in ('active_projects', 'seats', 'field_members')),
  constraint over_limit_objects_subject check (num_nonnulls(project_id, membership_id) = 1),
  constraint over_limit_objects_subject_limit check ((limit_code = 'active_projects') = (project_id is not null))
);

create unique index over_limit_objects_project_key on app.over_limit_objects (project_id);
create unique index over_limit_objects_membership_key on app.over_limit_objects (membership_id, limit_code);
create index over_limit_objects_plan_code_idx on app.over_limit_objects (plan_code);

call private.install_domain_table('app.over_limit_objects');
call private.describe('app.over_limit_objects', 'Objects that are read-only because the org is over a plan limit (Section 16, ADR 0081): projects past active_projects, members past seats or field_members. Rewritten by private.recompute_over_limit whenever the plan or what it counts changes; a row is deleted the moment its object is writable again. Downgrades never delete data.', array[
  'limit_code', 'Limit the object is over: active_projects, seats or field_members.',
  'plan_code', 'Plan in force whose limit the org exceeds.',
  'project_id', 'Read-only project, for active_projects.',
  'membership_id', 'Member whose seat is read-only, for seats or field_members.',
  'created_at', 'When the object became read-only.'
]);

call private.install_policies('app.over_limit_objects', $$org_id in (select private.my_org_ids())$$);

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.over_limit_objects', 'Written by triggers when the plan or usage changes, whatever the org''s state.'),
  ('app.plan_limit_choices', 'Choosing what stays writable is how an org leaves read-only, so it stays open.');
drop trigger if exists t15_refuse_read_only_org on app.over_limit_objects;
drop trigger if exists t15_refuse_read_only_org on app.plan_limit_choices;

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.over_limit_objects', 'Soft Deleted', 'deleted_at', interval '30 days', 'Delete', 'Derived state: a row is deleted as soon as its object is writable again and is never soft deleted.');

-- Tables that stay writable ------------------------------------------------------------------------------------------

create table private.over_limit_personal_tables (
  table_name text primary key,
  rationale text not null,
  constraint over_limit_personal_tables_name check (table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint over_limit_personal_tables_rationale check (char_length(btrim(rationale)) between 1 and 300)
);

comment on table private.over_limit_personal_tables is 'App tables that stay writable while plan limits make objects read-only (ADR 0081): a person''s membership, preferences, consents, follows and reading marks, which are about the person rather than the work. A person whose own seat is read-only still writes them, and so does anyone reading a read-only project.';
comment on column private.over_limit_personal_tables.table_name is 'Schema-qualified app table.';
comment on column private.over_limit_personal_tables.rationale is 'Why the table stays writable.';

alter table private.over_limit_personal_tables enable row level security;
revoke all on private.over_limit_personal_tables from public, anon, authenticated;
grant select on private.over_limit_personal_tables to service_role;

insert into private.over_limit_personal_tables (table_name, rationale) values
  ('app.memberships', 'A person leaves the org, and admins with a writable seat end memberships to free one; a read-only seat only leaves.'),
  ('app.membership_roles', 'Admins with a writable seat change roles to free one; a read-only seat only drops its own.'),
  ('app.notification_preferences', 'A person''s own notification choices.'),
  ('app.notification_settings', 'A person''s own quiet hours and digest.'),
  ('app.push_subscriptions', 'A person''s own devices and browsers for notifications.'),
  ('app.personal_setting_values', 'A person''s own settings.'),
  ('app.sidebar_item_preferences', 'A person''s own sidebar.'),
  ('app.saved_views', 'A person''s own saved views of what they may read.'),
  ('app.saved_view_filters', 'Filters of a person''s own saved view.'),
  ('app.saved_view_sorts', 'Sorts of a person''s own saved view.'),
  ('app.saved_view_defaults', 'A person''s own default views.'),
  ('app.saved_searches', 'A person''s own saved searches.'),
  ('app.favorites', 'A person''s own favorites.'),
  ('app.inbox_snoozes', 'A person''s own Inbox.'),
  ('app.thread_reads', 'Reading a conversation marks it read.'),
  ('app.thread_subscriptions', 'Following a conversation.'),
  ('app.record_watchers', 'Watching a record a person may read.'),
  ('app.tour_progress', 'A person''s own product tours.'),
  ('app.tip_dismissals', 'A person''s own dismissed tips.'),
  ('app.legal_acceptances', 'Accepting the current legal terms is needed to keep reading.'),
  ('app.cookie_consent_events', 'A person''s own cookie choices.'),
  ('app.sms_consent_events', 'A person''s own text message consent.'),
  ('app.privacy_signals', 'A person''s own privacy opt-outs.'),
  ('app.sop_acknowledgments', 'Confirming a person read a published SOP is reading, not work.'),
  ('app.personal_access_tokens', 'A person''s own API tokens, which reach only what the person may do.'),
  ('app.personal_access_token_scopes', 'Scopes of a person''s own API tokens.'),
  ('app.ai_requests', 'Asking Aurora about what a person may read; what Aurora drafts is saved through the guarded tables.');

-- Ranking ----------------------------------------------------------------------------------------------------------

create or replace function private.over_limit_candidates(p_org_id uuid)
returns table (
  limit_code app.plan_limit_code,
  project_id uuid,
  membership_id uuid,
  created_at timestamptz,
  chosen boolean,
  locked boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'active_projects'::app.plan_limit_code, p.id, null::uuid, p.created_at,
    exists (select 1 from app.plan_limit_choices c where c.project_id = p.id and c.deleted_at is null), false
  from app.projects p
  where p.org_id = p_org_id and p.deleted_at is null and p.archived_at is null
    and p.project_state in ('Proposed', 'Active', 'Blocked')
  union all
  select b.limit_code, null::uuid, b.id, b.created_at,
    exists (select 1 from app.plan_limit_choices c
            where c.membership_id = b.id and c.limit_code = b.limit_code and c.deleted_at is null),
    b.owner and b.limit_code = 'seats'
  from (
    select m.id, m.created_at, bool_or(r.org_id is null and r.code = 'owner') as owner,
      case when min(r.band) <= 5 then 'seats' when min(r.band) = 6 then 'field_members' end::app.plan_limit_code as limit_code
    from app.memberships m
    join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id and r.deleted_at is null
    where m.org_id = p_org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    group by m.id, m.created_at
  ) b
  where b.limit_code is not null;
$$;

comment on function private.over_limit_candidates(uuid) is 'Every object an org''s object limits count (ADR 0081): projects that are not archived, deleted, completed or canceled (active_projects), and active members by their best role, above Field for seats and Field for field_members, as private.membership_band_counts counts them. Says whether the Owner chose to keep each writable and whether it is locked writable (an Owner''s seat).';
revoke all on function private.over_limit_candidates(uuid) from public, anon, authenticated;

create or replace function private.over_limit_ranking(p_org_id uuid)
returns table (
  limit_code app.plan_limit_code,
  project_id uuid,
  membership_id uuid,
  created_at timestamptz,
  chosen boolean,
  locked boolean,
  rank bigint,
  limit_value bigint,
  read_only boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.limit_code, c.project_id, c.membership_id, c.created_at, c.chosen, c.locked, c.rank, l.limit_value,
    l.limit_value is not null and c.rank > l.limit_value and not c.locked
  from (
    select c.*, row_number() over (
      partition by c.limit_code
      order by c.locked desc, c.chosen desc, c.created_at, coalesce(c.project_id, c.membership_id)) as rank
    from private.over_limit_candidates(p_org_id) c
  ) c
  left join private.org_plan_limits l on l.org_id = p_org_id and l.limit_code = c.limit_code;
$$;

comment on function private.over_limit_ranking(uuid) is 'The selection rule of ADR 0081: within each object limit, Owners'' seats first, then what the Owner chose, then the oldest (created first), with the id as the tiebreak. Objects ranked past the limit in force are read-only, except an Owner''s seat, which never is. An unlimited limit makes nothing read-only.';
revoke all on function private.over_limit_ranking(uuid) from public, anon, authenticated;

-- Recompute ----------------------------------------------------------------------------------------------------------

create or replace function private.recompute_over_limit(p_org_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_lifted integer;
  v_added integer;
begin
  if p_org_id is null or private.in_tenant_purge(p_org_id)
     or not exists (select 1 from app.organizations o where o.id = p_org_id) then
    return 0;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('over-limit:' || p_org_id::text, 0));
  -- An org with nothing read-only and every count within its limit (or no limit set: Enterprise, grandfathered seats)
  -- has nothing to rank, so a role import or SCIM sync of many members only counts, never ranks, once per row.
  if not exists (select 1 from app.over_limit_objects x where x.org_id = p_org_id)
     and not exists (
       select 1
       from private.org_plan_limits l cross join private.membership_band_counts(p_org_id) b
       where l.org_id = p_org_id and l.limit_value is not null
         and l.limit_value < case l.limit_code
           when 'seats' then b.seats
           when 'field_members' then b.field_members
           when 'active_projects' then (
             select count(*) from app.projects p
             where p.org_id = p_org_id and p.deleted_at is null and p.archived_at is null
               and p.project_state in ('Proposed', 'Active', 'Blocked'))
         end) then
    return 0;
  end if;
  select distinct l.plan_code into v_plan from private.org_plan_limits l where l.org_id = p_org_id;

  delete from app.over_limit_objects x
  where x.org_id = p_org_id
    and not exists (select 1 from private.over_limit_ranking(p_org_id) r
                    where r.read_only and r.limit_code = x.limit_code
                      and r.project_id is not distinct from x.project_id
                      and r.membership_id is not distinct from x.membership_id);
  get diagnostics v_lifted = row_count;

  insert into app.over_limit_objects (org_id, limit_code, plan_code, project_id, membership_id)
  select p_org_id, r.limit_code, v_plan, r.project_id, r.membership_id
  from private.over_limit_ranking(p_org_id) r
  where r.read_only
    and not exists (select 1 from app.over_limit_objects x
                    where x.org_id = p_org_id and x.limit_code = r.limit_code
                      and x.project_id is not distinct from r.project_id
                      and x.membership_id is not distinct from r.membership_id);
  get diagnostics v_added = row_count;

  update app.over_limit_objects set plan_code = v_plan
  where org_id = p_org_id and plan_code is distinct from v_plan;
  return v_lifted + v_added;
end;
$$;

comment on function private.recompute_over_limit(uuid) is 'Rewrites an org''s read-only objects (app.over_limit_objects) from the plan in force and the objects its limits count, by the selection rule of private.over_limit_ranking (ADR 0081). An object back within its limit is writable at once. Serialized per org; skips an org being purged. Returns how many objects changed.';
revoke all on function private.recompute_over_limit(uuid) from public, anon, authenticated;

create or replace function private.recompute_over_limit_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.recompute_over_limit(
    ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'org_id')::uuid);
  return null;
end;
$$;

comment on function private.recompute_over_limit_after_change() is 'After trigger: recomputes the read-only objects of the row''s org when something an object limit depends on changed (ADR 0081).';
revoke all on function private.recompute_over_limit_after_change() from public, anon, authenticated;

create trigger t93_recompute_over_limit
  after insert or update of plan_code, subscription_state, extra_seats, seats_grandfathered, deleted_at on app.subscriptions
  for each row execute function private.recompute_over_limit_after_change();

create trigger t93_recompute_over_limit after update of archived_at, deleted_at, project_state on app.projects
  for each row
  when (old.archived_at is distinct from new.archived_at or old.deleted_at is distinct from new.deleted_at
        or old.project_state is distinct from new.project_state)
  execute function private.recompute_over_limit_after_change();

create trigger t93_recompute_over_limit after insert or update of deleted_at or delete on app.membership_roles
  for each row execute function private.recompute_over_limit_after_change();

create trigger t93_recompute_over_limit after update of valid_from, valid_to, deleted_at on app.memberships
  for each row
  when (old.valid_from is distinct from new.valid_from or old.valid_to is distinct from new.valid_to
        or old.deleted_at is distinct from new.deleted_at)
  execute function private.recompute_over_limit_after_change();

create trigger t93_recompute_over_limit after insert or update of ended_at, deleted_at on app.plan_overrides
  for each row
  when (new.override_kind in ('Plan', 'Limit'))
  execute function private.recompute_over_limit_after_change();

create or replace function private.recompute_over_limit_everywhere()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.recompute_over_limit(o.id) from app.organizations o where o.deleted_at is null;
  return null;
end;
$$;

comment on function private.recompute_over_limit_everywhere() is 'After a statement changes the plan limits (a plan seed migration): recomputes the read-only objects of every org (ADR 0081).';
revoke all on function private.recompute_over_limit_everywhere() from public, anon, authenticated;

create trigger t93_recompute_over_limit after insert or update or delete on private.plan_limits
  for each statement execute function private.recompute_over_limit_everywhere();

create or replace function private.refresh_over_limit(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_count integer := 0;
begin
  for v_org in
    select x.org_id from app.over_limit_objects x
    union
    select m.org_id from app.memberships m
    where m.deleted_at is null and m.valid_from > p_now - interval '2 hours' and m.valid_from <= p_now
    union
    select po.org_id from app.plan_overrides po
    where po.override_kind in ('Plan', 'Limit') and po.deleted_at is null
      and ((po.starts_at > p_now - interval '2 hours' and po.starts_at <= p_now)
           or (po.expires_at > p_now - interval '2 hours' and po.expires_at <= p_now))
  loop
    v_count := v_count + private.recompute_over_limit(v_org);
  end loop;
  return v_count;
end;
$$;

comment on function private.refresh_over_limit(timestamptz) is 'Over-limit step of the lifecycle job (ADR 0081): recomputes every org with read-only objects, so a membership that ended at its valid_to lifts a seat on time, every org whose memberships began in the last two hours, and every org whose console plan or limit override (1471) started or expired in the last two hours. Returns how many objects changed.';
revoke all on function private.refresh_over_limit(timestamptz) from public, anon, authenticated;

create or replace function private.run_org_lifecycle(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.run_trials(p_now) + private.expire_ownership_transfers(p_now) + private.revert_white_label(p_now)
    + private.schedule_deletions(p_now) + private.run_org_purges(5) + private.refresh_over_limit(p_now);
end;
$$;

comment on function private.run_org_lifecycle(timestamptz) is 'Hourly org lifecycle job (Section 12, Section 14.7, Section 16): trials, lapsed ownership offers, white label kept past a downgrade, certificates for orgs due for deletion, the purge of orgs whose storage objects the worker deleted, then read-only objects over plan limits (2070). Returns the actions taken.';
revoke all on function private.run_org_lifecycle(timestamptz) from public, anon, authenticated;

-- The guard ----------------------------------------------------------------------------------------------------------

create or replace function private.as_uuid(p_text text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_text::uuid end;
$$;

comment on function private.as_uuid(text) is 'The text as a uuid, or null when it is not one; for reading ids out of a row as JSON.';
revoke all on function private.as_uuid(text) from public, anon, authenticated;

create or replace function private.over_limit_row(p_table text, p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table regclass;
  v_id uuid := private.as_uuid(p_id);
  v_row jsonb;
begin
  if p_table !~ '^app\.[a-z][a-z0-9_]*$' or v_id is null then
    return null;
  end if;
  v_table := to_regclass(p_table);
  if v_table is null or not exists (select 1 from pg_catalog.pg_attribute a
                                    where a.attrelid = v_table and a.attname = 'id' and not a.attisdropped) then
    return null;
  end if;
  execute format('select to_jsonb(t) from %s t where t.id = $1', v_table) into v_row using v_id;
  return v_row;
end;
$$;

comment on function private.over_limit_row(text, text) is 'An app row as JSON by its table and id, or null when the table is not an app table with an id or the row is gone; for following a row to its project (ADR 0081).';
revoke all on function private.over_limit_row(text, text) from public, anon, authenticated;

create or replace function private.row_project_id(p_table text, p_row jsonb, p_depth integer default 0)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_pair text[];
  v_parent text;
  v_parent_column text;
  v_parent_row jsonb;
begin
  if p_row is null or p_depth > 6 then
    return null;
  end if;
  if p_table = 'app.projects' then
    return private.as_uuid(p_row ->> 'id');
  end if;
  v_project := private.as_uuid(p_row ->> 'project_id');
  if v_project is null and p_row ? 'record_id' then
    select r.project_id into v_project from app.records r where r.id = private.as_uuid(p_row ->> 'record_id');
  end if;
  if v_project is null and p_row ? 'engagement_id' then
    select e.project_id into v_project from app.engagements e where e.id = private.as_uuid(p_row ->> 'engagement_id');
  end if;
  -- A row about another row names it by table and id: comment threads, attachments, imports.
  foreach v_pair slice 1 in array array[array['subject_table', 'subject_id'], array['target_table', 'target_id']] loop
    exit when v_project is not null;
    if p_row ? v_pair[1] and p_row ? v_pair[2] then
      v_project := private.row_project_id(p_row ->> v_pair[1],
        private.over_limit_row(p_row ->> v_pair[1], p_row ->> v_pair[2]), p_depth + 1);
    end if;
  end loop;
  -- A child row follows the parent it takes its org from (install_domain_table's t10_derive_org_id): a budget line its
  -- budget, a comment its thread, a PO line its purchase order, as deep as the chain goes.
  if v_project is null then
    select split_part(encode(t.tgargs, 'escape'), '\000', 1), split_part(encode(t.tgargs, 'escape'), '\000', 2)
    into v_parent, v_parent_column
    from pg_catalog.pg_trigger t
    where t.tgrelid = to_regclass(p_table) and t.tgname = 't10_derive_org_id';
    if v_parent is not null and v_parent_column <> '' then
      v_parent_row := private.over_limit_row(v_parent, p_row ->> v_parent_column);
      v_project := private.row_project_id(v_parent, v_parent_row, p_depth + 1);
      -- A custom field value names its subject by target_id; its definition names the table.
      if v_project is null and v_parent_row ? 'target_table' and p_row ? 'target_id' and not p_row ? 'target_table' then
        v_project := private.row_project_id(v_parent_row ->> 'target_table',
          private.over_limit_row(v_parent_row ->> 'target_table', p_row ->> 'target_id'), p_depth + 1);
      end if;
    end if;
  end if;
  if v_project is null and p_table <> 'app.records' then
    select r.project_id into v_project from app.records r where r.id = private.as_uuid(p_row ->> 'id');
  end if;
  return v_project;
end;
$$;

comment on function private.row_project_id(text, jsonb, integer) is 'The project a row belongs to, for the over-limit guard (ADR 0081): the project itself, the row''s project_id, the project of the record or engagement it names (record_id, engagement_id), of the row it is about (subject_table and subject_id, target_table and target_id), of the parent it takes its org from (a budget line''s budget, a comment''s thread, a custom field value''s subject), followed up to six levels, or of the record it extends (a table keyed by the record''s id). Null for org-level rows.';
revoke all on function private.row_project_id(text, jsonb, integer) from public, anon, authenticated;

create or replace function private.over_limit_refusal(p_org_id uuid, p_limit app.plan_limit_code)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_limit bigint;
  v_count bigint;
begin
  select initcap(l.plan_code), l.limit_value into v_plan, v_limit
  from private.org_plan_limits l where l.org_id = p_org_id and l.limit_code = p_limit;
  select count(*) into v_count from private.over_limit_candidates(p_org_id) c where c.limit_code = p_limit;
  return case p_limit
    when 'active_projects' then format(
      'This project is read-only: the %s plan allows %s active %s and the organization has %s. An Owner can choose which projects stay writable in Settings, Billing and Plan, archive a project or upgrade the plan. No data is deleted.',
      v_plan, v_limit, case when v_limit = 1 then 'project' else 'projects' end, v_count)
    when 'seats' then format(
      'Your seat is read-only: the %s plan includes %s %s and %s members hold one. An Owner can choose who keeps a seat in Settings, Billing and Plan, buy extra seats or upgrade the plan. No data is deleted.',
      v_plan, v_limit, case when v_limit = 1 then 'seat' else 'seats' end, v_count)
    else format(
      'Your field seat is read-only: the %s plan includes Compass for %s field %s and the organization has %s. An Owner can choose who keeps one in Settings, Billing and Plan or upgrade the plan. No data is deleted.',
      v_plan, v_limit, case when v_limit = 1 then 'member' else 'members' end, v_count)
  end;
end;
$$;

comment on function private.over_limit_refusal(uuid, app.plan_limit_code) is 'The explanation of a plan_limit_read_only refusal: the plan, the limit, how many the org has and how to lift it (ADR 0081).';
revoke all on function private.over_limit_refusal(uuid, app.plan_limit_code) from public, anon, authenticated;

create or replace function private.refuse_over_limit_write(p_org_id uuid, p_table text, p_old jsonb, p_new jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit app.plan_limit_code;
  v_project uuid;
  v_personal boolean := exists (select 1 from private.over_limit_personal_tables t where t.table_name = p_table);
  v_membership uuid;
  v_audit constant text[] := array['archived_at', 'deleted_at', 'updated_at', 'updated_by'];
begin
  select x.limit_code into v_limit
  from app.over_limit_objects x join app.memberships m on m.id = x.membership_id
  where x.org_id = p_org_id and m.person_id = private.current_person_id()
  order by x.limit_code
  limit 1;
  if v_limit is not null then
    -- A read-only seat keeps the personal tables, but on memberships and roles only its own: it may leave the org or
    -- drop its own roles, never add a role or change another member's, so it cannot win itself a seat past the Owner's
    -- choice by demoting someone.
    if v_personal and p_table = 'app.memberships' then
      v_membership := private.as_uuid(coalesce(p_new, p_old) ->> 'id');
    elsif v_personal and p_table = 'app.membership_roles' then
      v_membership := private.as_uuid(coalesce(p_new, p_old) ->> 'membership_id');
    end if;
    if not v_personal
       or (p_table in ('app.memberships', 'app.membership_roles')
           and (p_old is null or not exists (select 1 from app.memberships m
                                             where m.id = v_membership and m.person_id = private.current_person_id()))) then
      perform private.refuse('plan_limit_read_only', private.over_limit_refusal(p_org_id, v_limit));
    end if;
  end if;
  if v_personal
     or not exists (select 1 from app.over_limit_objects x where x.org_id = p_org_id and x.project_id is not null) then
    return;
  end if;
  -- Archiving or deleting a read-only project, and nothing else, brings the org back under the limit.
  if p_table = 'app.projects' and p_old is not null and p_new is not null
     and (p_new - v_audit) = (p_old - v_audit)
     and ((p_old ->> 'archived_at' is null and p_new ->> 'archived_at' is not null)
          or (p_old ->> 'deleted_at' is null and p_new ->> 'deleted_at' is not null)) then
    return;
  end if;
  for v_project in
    select distinct private.row_project_id(p_table, r.data) from (values (p_old), (p_new)) as r (data) where r.data is not null
  loop
    if v_project is not null and exists (select 1 from app.over_limit_objects x where x.project_id = v_project) then
      perform private.refuse('plan_limit_read_only', private.over_limit_refusal(p_org_id, 'active_projects'));
    end if;
  end loop;
end;
$$;

comment on function private.refuse_over_limit_write(uuid, text, jsonb, jsonb) is 'Refuses a person''s write that touches what a plan limit made read-only (ADR 0081): any write of a person whose own seat is read-only, and any write to a read-only project or anything of it, however deep (private.row_project_id), except archiving or deleting that project. The personal tables (private.over_limit_personal_tables) stay writable; a read-only seat writes memberships and roles only to leave or drop its own roles. The refusal plan_limit_read_only names the limit and how to lift it.';
revoke all on function private.refuse_over_limit_write(uuid, text, jsonb, jsonb) from public, anon, authenticated;

create or replace function private.refuse_read_only_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'org_id')::uuid;
  v_reason text;
begin
  if private.current_person_id() is null or v_org is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_reason := private.org_read_only_reason(v_org);
  if v_reason = 'deletion' then
    perform private.refuse('org_read_only', 'This organization is waiting to be deleted and is read-only. The Owner can recover it in Settings, Danger zone, during the 7 days.');
  elsif v_reason = 'canceled' then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  elsif v_reason = 'dunning' then
    perform private.refuse('org_read_only', 'This organization is read-only because a payment is overdue. An Owner can update the payment method in Settings, Billing and plan; no data is deleted.');
  end if;
  if exists (select 1 from app.over_limit_objects x where x.org_id = v_org) then
    perform private.refuse_over_limit_write(v_org, tg_table_schema || '.' || tg_table_name,
      case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.refuse_read_only_org() is 'Refuses a person''s write to a row of a read-only org: canceled, waiting for deletion (Section 14.7) or past day 21 of dunning (Section 16), each with its fix; and a write to what a plan limit made read-only (Section 16, 2070). Workers, billing and retention (no person) still write.';
revoke all on function private.refuse_read_only_org() from public, anon, authenticated;

-- Restoring a project counts against the limit ------------------------------------------------------------------------

create or replace function private.guard_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_active bigint;
begin
  perform private.assert_time_zone(new.time_zone);
  if tg_op = 'INSERT' then
    perform 1 from app.organizations o where o.id = new.org_id for update;
    select count(*) into v_active from app.projects p
    where p.org_id = new.org_id and p.deleted_at is null and p.archived_at is null
      and p.project_state in ('Proposed', 'Active', 'Blocked');
    perform private.assert_within_plan_limit(new.org_id, 'active_projects', v_active + 1);
    return new;
  end if;
  if new.project_key <> old.project_key and not v_platform
     and not private.can_on_project(new.id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'projects.settings.write is required to change the project key';
  end if;
  if new.archived_at is distinct from old.archived_at and not v_platform
     and not private.can_on_project(new.id, 'projects.project.archive') then
    raise exception using errcode = '42501', message = 'projects.project.archive is required to archive a project';
  end if;
  if new.deleted_at is null and new.archived_at is null and new.project_state in ('Proposed', 'Active', 'Blocked')
     and not (old.deleted_at is null and old.archived_at is null and old.project_state in ('Proposed', 'Active', 'Blocked')) then
    perform 1 from app.organizations o where o.id = new.org_id for update;
    select count(*) into v_active from app.projects p
    where p.org_id = new.org_id and p.id <> new.id and p.deleted_at is null and p.archived_at is null
      and p.project_state in ('Proposed', 'Active', 'Blocked');
    perform private.assert_within_plan_limit(new.org_id, 'active_projects', v_active + 1);
  end if;
  return new;
end;
$$;

comment on function private.guard_project() is 'Projects: IANA time zone, the active_projects plan limit when a project is created, restored from the archive or the trash, or reopened (Section 16; restoring counts since 2070, so it never turns another project read-only), projects.settings.write to change the key and projects.project.archive to archive.';
revoke all on function private.guard_project() from public, anon, authenticated;

-- Every org as it stands ---------------------------------------------------------------------------------------------

select private.recompute_over_limit(o.id) from app.organizations o where o.deleted_at is null;
