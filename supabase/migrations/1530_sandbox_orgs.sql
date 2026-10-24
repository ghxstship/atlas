-- 1530_sandbox_orgs.sql
-- A96 (RRR-141), finding A65-022, Section 11.7 first run and Section 7.3 (sandbox_orgs), ADR 0052. "Each user can
-- open a private Northwind Live sandbox to explore":
--   * app.sandbox_orgs: one private org per person, with the instant it expires (an instant, never a business date)
--   * app.open_my_sandbox: creates the org on the Team plan with the person as its only member and fills it from the
--     sandbox template, a copy of the demo seed's core (supabase/seeds/0010, 0107, 0108, 0230: the Northwind Summer
--     Series and Northwind Winter Gala projects, their scope tree, gate 1 and a load-in to strike run of records),
--     dated from the day it opens. Production carries no demo tenant (ADR 0033 decision 1), so the template lives here
--   * plainly a sandbox: the org is named as one, app.my_sandbox and the shell banner show when it ends
--   * never billed: no Stripe subscription link may be written for a sandbox (private.refuse_sandbox_billing)
--   * never sends email or SMS: its Email and SMS deliveries are recorded Suppressed, never join a digest or a text
--     summary, and its scheduled reports are never emailed (private.sandbox_sends_nothing and friends)
--   * nobody else gets in: invitations, invite links, join requests, memberships of anyone but its owner, project
--     shares, advance and document links, offers, integrations and webhooks are refused
--   * expired sandboxes are purged every hour (xos_purge_expired_sandboxes) through the sanctioned tenant purge
--     (1270, private.begin_tenant_purge). Storage objects cannot be deleted in SQL, so their names are kept in
--     private.sandbox_leftover_objects for the Storage API sweep.

-- Sandboxes -----------------------------------------------------------------------------------------------------------

create table app.sandbox_orgs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  expires_at timestamptz not null,
  purge_error text,
  constraint sandbox_orgs_purge_error_length check (purge_error is null or char_length(purge_error) <= 2000)
);

create unique index sandbox_orgs_org_key on app.sandbox_orgs (org_id);
create index sandbox_orgs_person_idx on app.sandbox_orgs (person_id);
create index sandbox_orgs_expires_idx on app.sandbox_orgs (expires_at);

call private.install_domain_table('app.sandbox_orgs');
create unique index sandbox_orgs_one_per_person on app.sandbox_orgs (person_id) where deleted_at is null;

call private.describe('app.sandbox_orgs', 'A private sandbox org (Section 11.7, A65-022): one per person, filled from the sandbox template, never billed, sending no email or SMS and open to nobody else. It is purged with all its rows once expires_at passes. Written only by app.open_my_sandbox and the purge.', array[
  'org_id', 'The sandbox org.',
  'person_id', 'Person the sandbox belongs to, its only member.',
  'expires_at', 'Instant the sandbox ends; the hourly purge removes it after this.',
  'purge_error', 'Why the last purge attempt failed, for the platform team; null while none has.'
]);

call private.install_policies('app.sandbox_orgs', $$person_id = (select private.current_person_id())$$);
call private.install_audit_trail('app.sandbox_orgs');
-- The purge deletes a sandbox's row with the org; a row soft deleted by hand leaves after 30 days.
call private.install_default_retention('app.sandbox_orgs', interval '30 days');

create table private.sandbox_leftover_objects (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null,
  bucket_id text not null,
  object_name text not null,
  recorded_at timestamptz not null default now(),
  constraint sandbox_leftover_objects_bucket_length check (char_length(bucket_id) between 1 and 100),
  constraint sandbox_leftover_objects_name_length check (char_length(object_name) between 1 and 1024)
);

create unique index sandbox_leftover_objects_key on private.sandbox_leftover_objects (bucket_id, object_name);

comment on table private.sandbox_leftover_objects is 'Storage objects of purged sandboxes. SQL cannot delete storage objects (storage.protect_objects_delete), so the purge records their names and the Storage API sweep deletes each object and then its row.';
comment on column private.sandbox_leftover_objects.id is 'Primary key, UUID v7.';
comment on column private.sandbox_leftover_objects.org_id is 'The purged sandbox org; no foreign key, the org row is gone.';
comment on column private.sandbox_leftover_objects.bucket_id is 'Storage bucket of the object.';
comment on column private.sandbox_leftover_objects.object_name is 'Object name (path) in the bucket.';
comment on column private.sandbox_leftover_objects.recorded_at is 'When the purge recorded it.';

alter table private.sandbox_leftover_objects enable row level security;
revoke all on private.sandbox_leftover_objects from public, anon, authenticated;
grant select, delete on private.sandbox_leftover_objects to service_role;

create or replace function private.is_sandbox_org(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_org_id is not null and exists (select 1 from app.sandbox_orgs s where s.org_id = p_org_id);
$$;

comment on function private.is_sandbox_org(uuid) is 'True when the org is a person''s sandbox (1530).';
revoke all on function private.is_sandbox_org(uuid) from public, anon;
grant execute on function private.is_sandbox_org(uuid) to authenticated, service_role;

-- Nobody else gets in -------------------------------------------------------------------------------------------------

create or replace function private.refuse_outside_people_in_sandbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select s.person_id into v_owner from app.sandbox_orgs s where s.org_id = new.org_id;
  if v_owner is null then
    return new;
  end if;
  if tg_table_name = 'memberships' then
    if new.person_id = v_owner then
      return new;
    end if;
  end if;
  if tg_table_name in ('integration_connections', 'webhook_endpoints') then
    perform private.refuse('sandbox_no_connections', 'A sandbox connects to no outside service.');
  end if;
  perform private.refuse('sandbox_private', 'A sandbox is private: nobody else can be invited, join or be sent a link.');
  return null;
end;
$$;

comment on function private.refuse_outside_people_in_sandbox() is 'Trigger: refuses, in a sandbox org, any way in for someone other than its owner (invitations, invite links, join requests, memberships, project shares, advance and document links, offers) and any connection to an outside service (integrations, webhooks).';
revoke all on function private.refuse_outside_people_in_sandbox() from public, anon, authenticated;

create trigger t05_sandbox_private before insert on app.invites
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.invite_links
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.join_requests
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.memberships
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.project_shares
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.advance_recipient_tokens
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.engagement_document_tokens
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.offers
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.integration_connections
  for each row execute function private.refuse_outside_people_in_sandbox();
create trigger t05_sandbox_private before insert on app.webhook_endpoints
  for each row execute function private.refuse_outside_people_in_sandbox();

-- Never billed --------------------------------------------------------------------------------------------------------

create or replace function private.refuse_sandbox_billing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.is_sandbox_org(new.org_id) then
    perform private.refuse('sandbox_not_billable', 'A sandbox is never billed.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_sandbox_billing() is 'Trigger: refuses a Stripe subscription link for a sandbox org, so a sandbox is never billed.';
revoke all on function private.refuse_sandbox_billing() from public, anon, authenticated;

create trigger t05_sandbox_not_billable before insert or update on app.stripe_subscription_links
  for each row execute function private.refuse_sandbox_billing();

-- Never sends email or SMS ----------------------------------------------------------------------------------------------

create or replace function private.sandbox_sends_nothing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.channel in ('Email', 'SMS') and new.message_status in ('Queued', 'Deferred', 'Digest')
     and private.is_sandbox_org(new.org_id) then
    new.message_status := 'Suppressed';
    new.last_error := 'Sandbox orgs send no email or text messages.';
  end if;
  return new;
end;
$$;

comment on function private.sandbox_sends_nothing() is 'Trigger: records every Email and SMS delivery of a sandbox org Suppressed, whether private.notify queues, defers or holds it, so nothing reaches a real address.';
revoke all on function private.sandbox_sends_nothing() from public, anon, authenticated;

create trigger t50_sandbox_sends_nothing before insert or update of message_status on app.notification_deliveries
  for each row execute function private.sandbox_sends_nothing();

create or replace function private.sandbox_queues_nothing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.is_sandbox_org(new.org_id) then
    return null;
  end if;
  return new;
end;
$$;

comment on function private.sandbox_queues_nothing() is 'Trigger: a sandbox org''s suppressed deliveries never join an email digest or an SMS summary; the row is skipped.';
revoke all on function private.sandbox_queues_nothing() from public, anon, authenticated;

create trigger t50_sandbox_queues_nothing before insert on app.email_digest_queue
  for each row execute function private.sandbox_queues_nothing();
create trigger t50_sandbox_queues_nothing before insert on app.sms_summary_queue
  for each row execute function private.sandbox_queues_nothing();

create or replace function private.sandbox_emails_no_reports()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.delivery_status = 'Queued' and private.is_sandbox_org(new.org_id) then
    new.delivery_status := 'Failed';
    new.last_error := 'Sandbox orgs send no email.';
  end if;
  return new;
end;
$$;

comment on function private.sandbox_emails_no_reports() is 'Trigger: a scheduled report delivery in a sandbox org is recorded Failed with the reason, so no report.deliver job ever emails it.';
revoke all on function private.sandbox_emails_no_reports() from public, anon, authenticated;

create trigger t50_sandbox_emails_no_reports before insert on app.report_deliveries
  for each row execute function private.sandbox_emails_no_reports();

-- The sandbox template ------------------------------------------------------------------------------------------------

create or replace function private.fill_sandbox(p_org_id uuid, p_owner_person_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_zone constant text := 'America/New_York';
  v_membership uuid;
  v_workspace uuid;
  v_team uuid;
  v_project uuid;
  v_day date := (now() at time zone c_zone)::date + 45;
  v_root uuid;
  v_pier uuid;
  v_park uuid;
  v_show uuid;
  v_window uuid;
  v_deck uuid;
  v_truss uuid;
  v_rehearsal uuid;
  v_event uuid;
  v_strike uuid;
  v_milestone uuid;
  v_permit uuid;
  v_risk uuid;
  v_meeting uuid;
begin
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = p_owner_person_id and m.deleted_at is null;

  -- The org calendar and the Miami workspace and Production team (0010, 0230).
  insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text)
  values (p_org_id, 'locale.time_zone', 'Organization', p_org_id, c_zone);
  insert into app.workspaces (org_id, slug, name) values (p_org_id, 'miami', 'Miami') returning id into v_workspace;
  insert into app.workspace_members (org_id, workspace_id, membership_id) values (p_org_id, v_workspace, v_membership);
  insert into app.teams (org_id, name, description)
  values (p_org_id, 'Production', 'Plans and runs the shows the org produces.') returning id into v_team;
  insert into app.team_members (org_id, team_id, membership_id) values (p_org_id, v_team, v_membership);

  -- The Northwind Summer Series, a fictional waterfront festival, with gate 1 passed (0107).
  insert into app.projects (org_id, project_key, name, jurisdiction_id, region_code, tier_code, time_zone, starts_on, ends_on)
  values (p_org_id, 'NWS', 'Northwind Summer Series', 'US-FL-MIAMI-DADE', 'NA-SE-MIA', '05', c_zone, v_day - 1, v_day + 2)
  returning id into v_project;

  insert into app.scope_nodes (project_id, scope_kind, scope_code, name, path)
  values (v_project, 'Engagement Root', 'NWS-E01', 'Northwind Summer Series', 'NWS_E01')
  returning id into v_root;
  insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, path)
  values (v_project, v_root, 'Standing Venue', 'NWS-V01', 'Bayfront Pier Stage', 'NWS_V01')
  returning id into v_pier;
  insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, path)
  values (v_project, v_root, 'Standing Venue', 'NWS-V02', 'Harborside Park Lawn', 'NWS_V02')
  returning id into v_park;
  insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, path) values
    (v_project, v_pier, 'Show', 'NWS-S01', 'Opening Night Concert', 'NWS_S01'),
    (v_project, v_pier, 'Show', 'NWS-S02', 'Closing Night Concert', 'NWS_S02'),
    (v_project, v_park, 'Show', 'NWS-S03', 'Family Day Program', 'NWS_S03'),
    (v_project, v_park, 'Show', 'NWS-S04', 'Sunset Cinema Screening', 'NWS_S04');
  select n.id into v_show from app.scope_nodes n where n.project_id = v_project and n.scope_code = 'NWS-S01';

  -- The owner is the org's Owner and sees every project; adding themselves as a project member is a self-grant
  -- (Section 8.2, private.guard_project_member), so the template does not.

  insert into app.gate_evidence (project_id, criterion_id, evidence_uri, note, assertion_rank) values
    (v_project, 'G1.BUDGET_ENVELOPE', 'https://docs.example.com/nws/budget-envelope-v2.pdf',
      'Budget envelope approved by the client steering group.', 4),
    (v_project, 'G1.GONOGO', 'https://docs.example.com/nws/go-decision.pdf',
      'Go decision ratified by the executive producer.', 4),
    (v_project, 'G1.OBJECTIVES_STATED', 'https://docs.example.com/nws/objectives.pdf',
      'Attendance, sponsor reach and sentiment targets recorded.', 3),
    (v_project, 'G1.JURISDICTION', 'https://docs.example.com/nws/jurisdiction-memo.pdf',
      'Miami-Dade County confirmed as the authority having jurisdiction.', 4),
    (v_project, 'G1.SCOPE_LOCK', 'https://docs.example.com/nws/scope-lock.pdf',
      'Stage plots, site plan and sample approvals signed off.', 4);

  perform app.transition_project(v_project, 'Proposed', 'Active', 'Client signed the engagement letter.');
  perform app.transition_production(v_project, 'Proposed', 'Active', 'Production budget released.');
  perform app.pass_gate(v_project, 'SCP', 'Go decision ratified; scope locked with the client.');

  insert into app.gate_evidence (project_id, criterion_id, evidence_uri, note, assertion_rank) values
    (v_project, 'G2.CONTRACTS', 'https://docs.example.com/nws/executed-contracts.pdf',
      'Staging, audio and lighting vendors awarded and countersigned.', 4);

  -- Load-in to strike on the Opening Night show (0108), on the project's calendar.
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (v_project, 'Timeline', 'Show Cycle', 'Load-In Window', 'Z', 'Declared', 'INS', p_owner_person_id,
    ((v_day - 3) + time '08:00') at time zone c_zone, ((v_day - 1) + time '18:00') at time zone c_zone)
  returning id into v_window;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (v_project, v_show, 'Build', 'Structural', 'Install the stage deck', 'Y', 'Declared', 'BLD', p_owner_person_id,
    ((v_day - 3) + time '09:00') at time zone c_zone, ((v_day - 3) + time '17:00') at time zone c_zone)
  returning id into v_deck;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (v_project, v_show, 'Task', 'Execute', 'Hang the main truss', 'Y', 'Declared', 'INS', p_owner_person_id,
    ((v_day - 2) + time '09:00') at time zone c_zone, ((v_day - 2) + time '16:00') at time zone c_zone)
  returning id into v_truss;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (v_project, v_show, 'Rehearsal', 'Full Run', 'Run the full show', 'Y', 'Declared', 'INS', p_owner_person_id,
    ((v_day - 1) + time '14:00') at time zone c_zone, ((v_day - 1) + time '17:00') at time zone c_zone)
  returning id into v_rehearsal;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (v_project, v_show, 'Event', 'Flagship Activation', 'Opening Night Concert', 'Z', 'Declared', 'OPR', p_owner_person_id,
    (v_day + time '19:00') at time zone c_zone, (v_day + time '23:00') at time zone c_zone)
  returning id into v_event;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (v_project, v_show, 'Strike', 'Show Strike', 'Strike the pier stage', 'Y', 'Declared', 'CLS', p_owner_person_id,
    ((v_day + 2) + time '10:00') at time zone c_zone, ((v_day + 2) + time '18:00') at time zone c_zone)
  returning id into v_strike;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (v_project, 'Milestone', 'Handover', 'Stage Load-In Complete', 'Z', 'Declared', 'INS', p_owner_person_id,
    ((v_day - 1) + time '18:00') at time zone c_zone)
  returning id into v_milestone;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (v_project, 'Permit', 'Special Event', 'Special Event Permit', 'Y', 'Declared', 'ADV', p_owner_person_id,
    ((v_day - 15) + time '16:00') at time zone c_zone)
  returning id into v_permit;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (v_project, 'Meeting', 'Recurring', 'Production Meeting', 'Z', 'Declared', 'ADV', p_owner_person_id,
    ((v_day - 20) + time '10:00') at time zone c_zone, ((v_day - 20) + time '11:00') at time zone c_zone)
  returning id into v_meeting;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id)
  values (v_project, 'Risk', 'Safety', 'Afternoon Thunderstorm', 'Z', 'Declared', 'OPR', p_owner_person_id)
  returning id into v_risk;

  insert into app.record_timeline (record_id) values (v_window);
  insert into app.record_build (record_id, engineering_stamp_required) values (v_deck, true);
  insert into app.record_task (record_id, progress_pct, effort_hours) values (v_truss, 0, 7);
  insert into app.record_rehearsal (record_id, run_number) values (v_rehearsal, 1);
  insert into app.record_event (record_id, capacity) values (v_event, 4500);
  insert into app.record_strike (record_id, restoration_required) values (v_strike, true);
  insert into app.record_milestone (record_id) values (v_milestone);
  insert into app.record_permit (record_id, permit_identifier) values (v_permit, 'SEP-2027-0413');
  insert into app.record_meeting (record_id, location_text) values (v_meeting, 'Production office, Pier 3');
  insert into app.record_risk (record_id, likelihood, impact, mitigation)
  values (v_risk, 3, 4, 'Lightning detection on site; hold the show at 8 miles and clear the lawn at 6.');

  -- The Northwind Winter Gala, still in Scope (0107).
  perform app.create_project(p_org_id, 'NWG', 'Northwind Winter Gala', c_zone, 'US-FL-MIAMI-DADE', 'NA-SE-MIA', '06', null,
    v_day + 270, v_day + 270);
end;
$$;

comment on function private.fill_sandbox(uuid, uuid) is 'The sandbox template: a copy of the demo seed''s core (0010 workspace and team, 0107 projects, scope tree and gate 1, 0108 load-in to strike records, 0230 time zone) written as the sandbox''s owner, dated from the day the sandbox opens on the America/New_York calendar of the projects.';
revoke all on function private.fill_sandbox(uuid, uuid) from public, anon, authenticated;

-- Opening a sandbox -----------------------------------------------------------------------------------------------------

create or replace function private.sandbox_days()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 14;
$$;

comment on function private.sandbox_days() is 'How long a sandbox lasts, in days from the instant it opens (ADR 0052).';
revoke all on function private.sandbox_days() from public, anon;
grant execute on function private.sandbox_days() to authenticated, service_role;

create or replace function app.my_sandbox()
returns table (org_id uuid, slug text, name text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.slug, o.name, s.expires_at
  from app.sandbox_orgs s join app.organizations o on o.id = s.org_id
  where s.person_id = private.current_person_id() and s.deleted_at is null and s.expires_at > now();
$$;

comment on function app.my_sandbox() is 'The signed-in person''s open sandbox: its org, slug, name and the instant it ends. No row when they have none.';
revoke all on function app.my_sandbox() from public, anon;
grant execute on function app.my_sandbox() to authenticated;

create or replace function app.open_my_sandbox()
returns table (org_id uuid, slug text, name text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_existing app.sandbox_orgs;
  v_org uuid;
  v_slug text;
  v_name constant text := 'Northwind Live Sandbox';
  v_membership uuid;
  v_expires timestamptz := now() + make_interval(days => private.sandbox_days());
begin
  select * into v_existing from app.sandbox_orgs s where s.person_id = v_person and s.deleted_at is null for update;
  if v_existing.id is not null and v_existing.expires_at > now() then
    return query select o.id, o.slug, o.name, v_existing.expires_at from app.organizations o where o.id = v_existing.org_id;
    return;
  end if;
  if v_existing.id is not null then
    -- The last sandbox ended but the hourly purge has not reached it yet: remove it now.
    begin
      perform private.purge_sandbox_org(v_existing.org_id);
    exception when others then
      perform private.refuse('sandbox_removing', 'Your last sandbox is still being removed. Try again in an hour.');
    end;
  end if;

  loop
    v_slug := 'sandbox-' || encode(extensions.gen_random_bytes(5), 'hex');
    exit when not exists (select 1 from app.organizations o where o.slug = v_slug);
  end loop;
  perform private.assert_org_slug_available(v_slug);

  insert into app.organizations (name, slug) values (v_name, v_slug) returning id into v_org;
  insert into app.sandbox_orgs (org_id, person_id, expires_at) values (v_org, v_person, v_expires);
  -- The Team plan, as the demo tenant has, with no Stripe link: nothing is ever billed.
  perform private.create_subscription(v_org, 'team');

  perform private.begin_trusted_operation('membership_write');
  insert into app.memberships (org_id, person_id) values (v_org, v_person) returning id into v_membership;
  insert into app.membership_roles (membership_id, role_id, granted_by)
  values (v_membership, private.system_role_id('owner'), null);
  perform private.end_trusted_operation('membership_write');

  perform private.fill_sandbox(v_org, v_person);
  return query select v_org, v_slug, v_name, v_expires;
end;
$$;

comment on function app.open_my_sandbox() is 'Opens the signed-in person''s sandbox (Section 11.7): their open one if they have it, otherwise a new private org on the Team plan with them as its only Owner, filled from the sandbox template and ending after private.sandbox_days(). A sandbox that ended but is not purged yet is purged first.';
revoke all on function app.open_my_sandbox() from public, anon;
grant execute on function app.open_my_sandbox() to authenticated;

-- The purge -------------------------------------------------------------------------------------------------------------

create or replace function private.sandbox_key_expr(p_rel regclass, p_alias text)
returns text
language sql
stable
set search_path = ''
as $$
  select 'jsonb_build_object(' || string_agg(format('%L, %I.%I', a.attname, p_alias, a.attname), ', '
           order by array_position(k.conkey, a.attnum)) || ')'
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
  where k.conrelid = p_rel and k.contype = 'p';
$$;

comment on function private.sandbox_key_expr(regclass, text) is 'SQL expression of a table''s primary key as jsonb, for the sandbox purge''s row marks.';
revoke all on function private.sandbox_key_expr(regclass, text) from public, anon, authenticated;

create or replace function private.purge_sandbox_org(p_org_id uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scope record;
  v_edge record;
  v_rel regclass;
  v_pass integer := 0;
  v_added bigint;
  v_progress integer;
  v_rows bigint;
  v_total bigint := 0;
  v_bad text;
  v_sql text;
  v_ord integer := 0;
  v_count bigint;
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  if not private.is_sandbox_org(p_org_id) then
    perform private.refuse('sandbox_unknown', 'Only a sandbox org is purged this way.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  -- The purge acts as the platform, as the hourly job does: guards that keep a signed-in person from deleting
  -- memberships or ending the last Owner let the sanctioned purge through. Restored before returning.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  set local client_min_messages = warning;
  drop table if exists pg_temp.sandbox_scope, pg_temp.sandbox_edges, pg_temp.sandbox_marks, pg_temp.sandbox_order;
  create temp table sandbox_scope on commit drop as
  select c.oid::regclass as rel,
    exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id'
            and not a.attisdropped and a.atttypid = 'uuid'::regtype) as has_org
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('app', 'private') and c.relkind in ('r', 'p') and not c.relispartition
    and c.oid not in ('private.tenant_purge_scope'::regclass, 'private.sandbox_leftover_objects'::regclass);

  create temp table sandbox_edges on commit drop as
  select k.conrelid::regclass as child, k.confrelid::regclass as parent, k.confdeltype::text as on_delete,
    (select string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' and ' order by u.ord)
     from unnest(k.conkey, k.confkey) with ordinality as u (ck, pk, ord)
     join pg_catalog.pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = u.ck
     join pg_catalog.pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = u.pk) as join_condition
  from pg_catalog.pg_constraint k
  where k.contype = 'f' and k.conparentid = 0
    and k.conrelid in (select s.rel from pg_temp.sandbox_scope s) and k.confrelid in (select s.rel from pg_temp.sandbox_scope s)
    and not (k.conrelid = 'app.organizations'::regclass and k.confrelid = 'app.organizations'::regclass);

  create temp table sandbox_marks (rel regclass not null, key jsonb not null, org_id uuid, pass integer not null default 0,
    primary key (rel, key)) on commit drop;

  -- Every row of the sandbox, then every row that references a marked row and would block or follow its delete.
  for v_scope in select * from pg_temp.sandbox_scope s where s.has_org loop
    execute format('insert into pg_temp.sandbox_marks (rel, key, org_id) select %L::regclass, %s, c.org_id from %s c where c.org_id = $1 on conflict do nothing',
      v_scope.rel, private.sandbox_key_expr(v_scope.rel, 'c'), v_scope.rel) using p_org_id;
  end loop;
  insert into pg_temp.sandbox_marks (rel, key, org_id) values ('app.organizations'::regclass, jsonb_build_object('id', p_org_id), p_org_id)
  on conflict do nothing;
  loop
    v_pass := v_pass + 1;
    v_added := 0;
    -- Only the edges out of rows the last pass marked: earlier marks were followed already.
    for v_edge in
      select e.* from pg_temp.sandbox_edges e
      where e.on_delete in ('a', 'r', 'c')
        and exists (select 1 from pg_temp.sandbox_marks m where m.rel = e.parent and m.pass = v_pass - 1)
    loop
      execute format(
        'insert into pg_temp.sandbox_marks (rel, key, org_id, pass) select %L::regclass, %s, %s, %s from %s c where exists (select 1 from %s p join pg_temp.sandbox_marks m on m.rel = %L::regclass and m.pass = %s and m.key = %s where %s) on conflict do nothing',
        v_edge.child, private.sandbox_key_expr(v_edge.child, 'c'),
        case when (select s.has_org from pg_temp.sandbox_scope s where s.rel = v_edge.child) then 'c.org_id' else 'null::uuid' end,
        v_pass, v_edge.child, v_edge.parent, v_edge.parent, v_pass - 1, private.sandbox_key_expr(v_edge.parent, 'p'),
        v_edge.join_condition);
      get diagnostics v_rows = row_count;
      v_added := v_added + v_rows;
    end loop;
    exit when v_added = 0 or v_pass > 50;
  end loop;

  -- A sandbox is closed, so nothing outside it should reference it. If something does, stop and say what.
  select string_agg(distinct m.rel::text, ', ') into v_bad
  from pg_temp.sandbox_marks m where (m.org_id is not null and m.org_id <> p_org_id)
    or (m.org_id is null and m.rel <> 'app.organizations'::regclass);
  if v_bad is not null then
    perform private.refuse('sandbox_purge_blocked', left(format('Rows outside the sandbox reference it: %s.', v_bad), 1900));
  end if;

  -- Children before parents; a foreign key cycle goes last.
  create temp table sandbox_order (rel regclass primary key, ord integer not null, done boolean not null default false) on commit drop;
  loop
    insert into pg_temp.sandbox_order (rel, ord)
    select r.rel, v_ord from (select distinct m.rel from pg_temp.sandbox_marks m) r
    where r.rel not in (select o.rel from pg_temp.sandbox_order o)
      and not exists (select 1 from pg_temp.sandbox_edges e
                      where e.parent = r.rel and e.child <> r.rel
                        and e.child in (select m.rel from pg_temp.sandbox_marks m)
                        and e.child not in (select o.rel from pg_temp.sandbox_order o));
    get diagnostics v_rows = row_count;
    exit when v_rows = 0;
    v_ord := v_ord + 1;
  end loop;
  insert into pg_temp.sandbox_order (rel, ord)
  select distinct m.rel, v_ord from pg_temp.sandbox_marks m where m.rel not in (select o.rel from pg_temp.sandbox_order o);

  -- Storage objects cannot be deleted in SQL: keep their names for the Storage API sweep. A79's org deletion (1351)
  -- finds every object of an org, including onboarding uploads and objects its rows name, while the rows still exist.
  insert into private.sandbox_leftover_objects (org_id, bucket_id, object_name)
  select p_org_id, o.bucket_id, o.name from private.org_storage_objects(p_org_id) o
  on conflict do nothing;

  -- The sanctioned tenant purge (1270): guards let deletes of this org's rows through, and refuse a legal hold.
  perform private.begin_tenant_purge(array[p_org_id]);
  v_pass := 0;
  loop
    v_pass := v_pass + 1;
    v_progress := 0;
    for v_rel in select o.rel from pg_temp.sandbox_order o where not o.done order by o.ord, o.rel::text loop
      begin
        execute format('delete from %s t where %s in (select m.key from pg_temp.sandbox_marks m where m.rel = %L::regclass)',
          v_rel, private.sandbox_key_expr(v_rel, 't'), v_rel);
        get diagnostics v_rows = row_count;
        v_total := v_total + v_rows;
        update pg_temp.sandbox_order set done = true where rel = v_rel;
        v_progress := v_progress + 1;
      exception when others then
        null;
      end;
    end loop;
    exit when not exists (select 1 from pg_temp.sandbox_order where not done);
    if v_progress = 0 then
      select 'with ' || string_agg(format('d%s as (delete from %s t where %s in (select m.key from pg_temp.sandbox_marks m where m.rel = %L::regclass) returning 1)',
               o.ord_no, o.rel, private.sandbox_key_expr(o.rel, 't'), o.rel), ', ')
             || ' select ' || string_agg(format('(select count(*) from d%s)', o.ord_no), ' + ')
        into v_sql
      from (select r.rel, row_number() over (order by r.ord, r.rel::text) as ord_no
            from pg_temp.sandbox_order r where not r.done) o;
      execute v_sql into v_rows;
      v_total := v_total + v_rows;
      update pg_temp.sandbox_order set done = true where not done;
    end if;
  end loop;
  delete from private.object_scans s where split_part(s.object_name, '/', 1) = p_org_id::text;
  perform private.end_tenant_purge();

  for v_scope in select * from pg_temp.sandbox_scope s where s.has_org loop
    execute format('select count(*) from %s where org_id = $1', v_scope.rel) into v_count using p_org_id;
    if v_count > 0 then
      perform private.refuse('sandbox_purge_incomplete', format('%s still holds %s rows of the sandbox.', v_scope.rel, v_count));
    end if;
  end loop;
  if exists (select 1 from app.organizations o where o.id = p_org_id) then
    perform private.refuse('sandbox_purge_incomplete', 'The sandbox org row remains.');
  end if;
  drop table if exists pg_temp.sandbox_scope, pg_temp.sandbox_edges, pg_temp.sandbox_marks, pg_temp.sandbox_order;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return v_total;
end;
$$;

comment on function private.purge_sandbox_org(uuid) is 'Deletes every row of a sandbox org, the org itself last, through the sanctioned tenant purge (1270): every row carrying the org, then every row that references one, children before parents. Refuses when a row outside the sandbox references it, when it is under a legal hold, or when anything remains. Records the org''s storage objects in private.sandbox_leftover_objects. Returns how many rows it deleted.';
revoke all on function private.purge_sandbox_org(uuid) from public, anon, authenticated;

create or replace function private.purge_expired_sandboxes(p_limit integer default 5)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sandbox record;
  v_purged integer := 0;
  v_error text;
begin
  for v_sandbox in
    select s.id, s.org_id from app.sandbox_orgs s
    where s.expires_at <= now()
    order by s.expires_at
    limit least(greatest(p_limit, 1), 50)
  loop
    begin
      perform private.purge_sandbox_org(v_sandbox.org_id);
      v_purged := v_purged + 1;
    exception when others then
      get stacked diagnostics v_error = message_text;
      update app.sandbox_orgs set purge_error = left(v_error, 2000) where id = v_sandbox.id;
    end;
  end loop;
  return v_purged;
end;
$$;

comment on function private.purge_expired_sandboxes(integer) is 'Hourly job (xos_purge_expired_sandboxes): purges up to p_limit sandboxes whose expires_at has passed, oldest first. A purge that fails rolls back on its own and records why on the sandbox (purge_error) for the platform team. Returns how many it purged.';
revoke all on function private.purge_expired_sandboxes(integer) from public, anon, authenticated;
grant execute on function private.purge_expired_sandboxes(integer) to service_role;

select cron.schedule('xos_purge_expired_sandboxes', '37 * * * *', 'select private.purge_expired_sandboxes()');
