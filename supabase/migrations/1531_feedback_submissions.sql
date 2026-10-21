-- 1531_feedback_submissions.sql
-- A96 (RRR-141), finding A65-022, Section 11.7 ("The feedback widget sends a message and an optional screenshot to the
-- platform team. It never captures data the user did not approve.") and Section 7.3 (feedback_submissions), ADR 0052:
--   * platform staff are private.is_platform_staff(), which A90's operator console defines (1470); until it lands a
--     stand-in roster, private.platform_staff, written by the service role only, answers it
--   * app.feedback_submissions: the message, the page it was sent from (its path, never its query string), the app
--     and version, locale and window size the widget shows the person before they send, and an optional screenshot
--     the person chose, uploaded through the support screenshot path (1034: bucket support-screenshots, owner-only)
--   * app.send_feedback (at most 10 an hour), app.feedback_triage_list and app.triage_feedback for platform staff
--   * staff may open a feedback screenshot only once the upload scan found it Clean (1240)
--   * kept two years, like support diagnostics (0643)

-- Platform staff -------------------------------------------------------------------------------------------------------
-- A90's operator console (1470, app.platform_operators) defines private.is_platform_staff(): a signed-in person with a
-- live operator grant. Until it lands, a minimal roster the service role writes stands in under the same function;
-- once 1470 is present (it runs first), this block creates nothing and A90's definition is the one in force.

do $do$
begin
  if to_regprocedure('private.is_platform_staff()') is null then
    create table private.platform_staff (
      person_id uuid primary key references app.people (id),
      reason text not null,
      granted_at timestamptz not null default now(),
      revoked_at timestamptz,
      constraint platform_staff_reason_length check (char_length(btrim(reason)) between 1 and 300),
      constraint platform_staff_revoked_after_grant check (revoked_at is null or revoked_at >= granted_at)
    );
    comment on table private.platform_staff is 'Stand-in roster of the platform team until A90''s app.platform_operators (1470) lands: people who triage feedback in Atlas (1531). Written only by the service role, an owner step; a revoked row ends access at once.';
    comment on column private.platform_staff.person_id is 'Person on the platform team.';
    comment on column private.platform_staff.reason is 'Why the person has platform access, for the access review.';
    comment on column private.platform_staff.granted_at is 'When access was granted.';
    comment on column private.platform_staff.revoked_at is 'When access was revoked; null while it stands.';
    alter table private.platform_staff enable row level security;
    revoke all on private.platform_staff from public, anon, authenticated;
    grant select, insert, update on private.platform_staff to service_role;

    create function private.is_platform_staff()
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $f$
      select exists (select 1 from private.platform_staff s
                     where s.person_id = private.current_person_id() and s.revoked_at is null);
    $f$;
    comment on function private.is_platform_staff() is 'True when the signed-in person is on the platform team (stand-in roster private.platform_staff, 1531, until A90''s 1470 defines it over app.platform_operators). Names a person, never the service role.';
    revoke all on function private.is_platform_staff() from public, anon;
    grant execute on function private.is_platform_staff() to authenticated, service_role;
  end if;
end;
$do$;

create or replace function app.am_i_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_person_id() is not null and private.is_platform_staff();
$$;

comment on function app.am_i_platform_staff() is 'True when the signed-in person is on the platform team, so Atlas offers the feedback triage list.';
revoke all on function app.am_i_platform_staff() from public, anon;
grant execute on function app.am_i_platform_staff() to authenticated;

-- Feedback ------------------------------------------------------------------------------------------------------------

create sequence private.feedback_submission_number_seq;
comment on sequence private.feedback_submission_number_seq is 'Numbers feedback submissions FB-000001 and up.';

create table app.feedback_submissions (
  id uuid primary key default private.uuid_v7(),
  submission_number text not null default 'FB-' || lpad(nextval('private.feedback_submission_number_seq')::text, 6, '0'),
  person_id uuid not null references app.people (id),
  context_org_id uuid references app.organizations (id) on delete set null,
  app_code text not null,
  message text not null,
  route text,
  app_version text,
  locale text,
  viewport text,
  screenshot_path text,
  triage_state text not null default 'New',
  triage_note text,
  triaged_at timestamptz,
  triaged_by uuid references app.people (id),
  constraint feedback_submissions_app check (app_code in ('Atlas', 'Gateway')),
  constraint feedback_submissions_message_length check (char_length(btrim(message)) between 1 and 4000),
  constraint feedback_submissions_route_format check (route is null or (char_length(route) <= 500 and route ~ '^/[^?#[:space:]]*$')),
  constraint feedback_submissions_app_version_length check (app_version is null or char_length(app_version) <= 50),
  constraint feedback_submissions_locale_format check (locale is null or locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  constraint feedback_submissions_viewport_format check (viewport is null or viewport ~ '^[0-9]{2,5}x[0-9]{2,5}$'),
  constraint feedback_submissions_screenshot_path check (screenshot_path is null or (char_length(screenshot_path) <= 500
    and screenshot_path ~ '^[a-z0-9][a-z0-9/_.-]*$')),
  constraint feedback_submissions_triage_state check (triage_state in ('New', 'Read', 'Planned', 'Closed')),
  constraint feedback_submissions_triage_note_length check (triage_note is null or char_length(triage_note) <= 2000),
  constraint feedback_submissions_triaged check ((triage_state = 'New') = (triaged_at is null))
);

create unique index feedback_submissions_number_key on app.feedback_submissions (submission_number);
create index feedback_submissions_context_org_idx on app.feedback_submissions (context_org_id);
create index feedback_submissions_triaged_by_idx on app.feedback_submissions (triaged_by);

call private.install_person_table('app.feedback_submissions');
create index feedback_submissions_triage_idx on app.feedback_submissions (triage_state, created_at desc);
-- Writes go through app.send_feedback and app.triage_feedback only.
revoke insert, update on app.feedback_submissions from authenticated;
drop policy feedback_submissions_owner_insert on app.feedback_submissions;
drop policy feedback_submissions_owner_update on app.feedback_submissions;
create policy feedback_submissions_staff_read on app.feedback_submissions for select to authenticated
  using ((select private.is_platform_staff()));

call private.describe('app.feedback_submissions', 'Feedback a person sent the platform team from the widget in Atlas or Gateway (Section 11.7, A65-022): their message, the page context the widget showed them before sending and an optional screenshot they chose. Never anything they did not see. Read by the sender and platform staff; written only through app.send_feedback and app.triage_feedback.', array[
  'id', 'Primary key, UUID v7.',
  'submission_number', 'Reference the platform team quotes, FB-000001 and up. Set by the database.',
  'person_id', 'Person who sent the feedback.',
  'context_org_id', 'Org the person was working in when they sent it, if any; cleared when that org is purged.',
  'app_code', 'App the feedback came from: Atlas or Gateway.',
  'message', 'What the person wrote.',
  'route', 'Path of the page it was sent from, without the query string.',
  'app_version', 'App version the person was running.',
  'locale', 'Language the person was using.',
  'viewport', 'Window size in CSS pixels, width x height.',
  'screenshot_path', 'Screenshot the person chose to attach: <person_id>/<file> in the support-screenshots bucket (1034).',
  'triage_state', 'New until platform staff read it, then Read, Planned or Closed.',
  'triage_note', 'Platform staff note on what was decided.',
  'triaged_at', 'When platform staff last triaged it; null while New.',
  'triaged_by', 'Platform staff member who last triaged it.'
]);

create or replace function app.send_feedback(
  p_app_code text,
  p_message text,
  p_route text default null,
  p_org_id uuid default null,
  p_app_version text default null,
  p_locale text default null,
  p_viewport text default null,
  p_screenshot_path text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_number text;
begin
  if p_org_id is not null and not exists (
    select 1 from app.memberships m
    where m.org_id = p_org_id and m.person_id = v_person and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('feedback_org_not_member', 'Feedback can name only an org you belong to.');
  end if;
  if p_screenshot_path is not null and private.support_screenshot_owner(p_screenshot_path) is distinct from v_person then
    perform private.refuse('feedback_screenshot_not_yours', 'The screenshot must be one you uploaded.');
  end if;
  if (select count(*) from app.feedback_submissions f
      where f.person_id = v_person and f.created_at > now() - interval '1 hour') >= 10 then
    perform private.refuse('feedback_limit', 'You have sent 10 messages in the last hour. Try again later.');
  end if;
  insert into app.feedback_submissions (person_id, context_org_id, app_code, message, route, app_version, locale, viewport,
    screenshot_path)
  values (v_person, p_org_id, p_app_code, btrim(p_message), nullif(btrim(p_route), ''), nullif(btrim(p_app_version), ''),
    nullif(btrim(p_locale), ''), nullif(btrim(p_viewport), ''), p_screenshot_path)
  returning submission_number into v_number;
  return v_number;
end;
$$;

comment on function app.send_feedback(text, text, text, uuid, text, text, text, text) is 'Sends feedback to the platform team from Atlas or Gateway with the page context the widget showed and an optional screenshot the person uploaded themselves (support-screenshots, 1034). An org is named only by a member. At most 10 an hour per person. Returns the submission number.';
revoke all on function app.send_feedback(text, text, text, uuid, text, text, text, text) from public, anon;
grant execute on function app.send_feedback(text, text, text, uuid, text, text, text, text) to authenticated;

create or replace function app.feedback_triage_list(p_state text default null, p_limit integer default 100)
returns table (
  id uuid, submission_number text, app_code text, message text, route text, app_version text, locale text,
  viewport text, context_org_slug text, sender_name text, screenshot_path text, screenshot_scan text,
  triage_state text, triage_note text, triaged_at timestamptz, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.is_platform_staff() or private.is_platform_operator()) then
    raise exception using errcode = '42501', message = 'platform staff only';
  end if;
  return query
  select f.id, f.submission_number, f.app_code, f.message, f.route, f.app_version, f.locale, f.viewport, o.slug,
    p.full_name, f.screenshot_path,
    (select s.scan_status::text from private.object_scans s
     where s.bucket_id = 'support-screenshots' and s.object_name = f.screenshot_path),
    f.triage_state, f.triage_note, f.triaged_at, f.created_at
  from app.feedback_submissions f
  join app.people p on p.id = f.person_id
  left join app.organizations o on o.id = f.context_org_id
  where f.deleted_at is null and (p_state is null or f.triage_state = p_state)
  order by f.created_at desc
  limit least(greatest(p_limit, 1), 500);
end;
$$;

comment on function app.feedback_triage_list(text, integer) is 'Platform staff: feedback newest first, optionally in one triage state, with the sender''s name, the org they were in and the screenshot''s upload scan status (a screenshot opens only once Clean). Anyone else gets an insufficient privilege error.';
revoke all on function app.feedback_triage_list(text, integer) from public, anon;
grant execute on function app.feedback_triage_list(text, integer) to authenticated;

create or replace function app.triage_feedback(p_id uuid, p_state text, p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (private.is_platform_staff() or private.is_platform_operator()) then
    raise exception using errcode = '42501', message = 'platform staff only';
  end if;
  if p_state is null or p_state not in ('Read', 'Planned', 'Closed') then
    perform private.refuse('feedback_state_unknown', 'Triage moves feedback to Read, Planned or Closed.');
  end if;
  update app.feedback_submissions
  set triage_state = p_state, triage_note = nullif(btrim(p_note), ''), triaged_at = now(),
    triaged_by = private.current_person_id()
  where id = p_id and deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'no such feedback';
  end if;
end;
$$;

comment on function app.triage_feedback(uuid, text, text) is 'Platform staff: moves feedback to Read, Planned or Closed with an optional note, recording who and when.';
revoke all on function app.triage_feedback(uuid, text, text) from public, anon;
grant execute on function app.triage_feedback(uuid, text, text) to authenticated;

-- Screenshots: staff read a feedback screenshot once it scans Clean ----------------------------------------------------

create or replace function private.staff_may_read_feedback_screenshot(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_staff()
    and exists (select 1 from app.feedback_submissions f where f.screenshot_path = p_object_name and f.deleted_at is null)
    and exists (select 1 from private.object_scans s
                where s.bucket_id = 'support-screenshots' and s.object_name = p_object_name and s.scan_status = 'Clean');
$$;

comment on function private.staff_may_read_feedback_screenshot(text) is 'True when the caller is platform staff, the object is a feedback screenshot and its upload scan found it Clean (1240), so staff never open an unscanned or infected file.';
revoke all on function private.staff_may_read_feedback_screenshot(text) from public, anon;
grant execute on function private.staff_may_read_feedback_screenshot(text) to authenticated;

create policy support_screenshots_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'support-screenshots' and private.staff_may_read_feedback_screenshot(name));

-- Retention -----------------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.feedback_submissions', 'Age', 'created_at', interval '2 years', 'Delete',
   'Feedback is read and triaged within days; two years, like support diagnostics, covers trend reviews.');
