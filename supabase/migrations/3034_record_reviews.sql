-- 3034_record_reviews.sql
-- B14 Event types and project setup (RRR-238; parity gap G-268; ADR 0153 decision D5; block 3030 to 3039). Task
-- reviews as a done-gate: a record flagged requires_review reaches Complete only after the latest Approval record
-- about it is decided Approved. Invariant 18 is unchanged: private.guard_record_approval (0311) still refuses the
-- requester (sod_approval_requester) and anyone who cannot write the project's records (approval_not_eligible), so any
-- eligible approver other than the requester may decide, the named reviewer or another.
--
--   * app.records.requires_review and app.template_items.requires_review (Record items only). The v1 API selects
--     explicit columns, so the frozen contract does not change. app.apply_template and
--     app.create_template_from_project are restated from P8's 2851 and carry the flag both ways.
--   * app.request_record_review: an Active record gets an Approval record "Review of KEY-n", owned by the reviewer,
--     whose record_approval names the record and the requester; the Approval record goes to Active and the record to
--     In Review. The named reviewer, who must be able to decide, gets approval.requested.
--   * app.decide_record_review: the decision through record_approval (the guard stamps the approver and keeps SoD), the
--     Approval record to Complete, the subject back to Active on Rejected while it is still In Review, the reviewer's
--     open request archived, and approval.decided to the requester.
--   * t47_record_review_gate refuses Complete without an approved latest review (record_review_required,
--     record_review_pending, record_review_changes_requested) on every path: app.transition_record, the bulk RPCs and
--     direct writes. Clearing the flag needs projects.settings.write (record_review_flag_locked).
--   * Only an independent decision counts (ADR 0153 D5): the guard counts an Approved review only when its approver is neither
--     the record's owner nor the person completing it, it was decided after the record last entered Active, and it
--     is in the record's project. The record's owner is never its reviewer (sod_record_review_owner, a new built-in
--     rule), so an Approval record inserted by hand with a borrowed requester cannot carry a record to Complete.
--   * app.act_on_notification is restated from A127's 2200, the latest definition, so Approve and Reject on an
--     approval.requested about app.records decide the review from Inbox and from Compass's push actions; Reject needs a
--     comment. private.notification_link_actions (2200) is not restated, so email one-tap links are not offered for
--     record reviews.
-- No notification kind is added: request and decision reuse approval.requested and approval.decided, with subject_id
-- the Approval record (what app.decide_record_review takes) and recordKey the reviewed record's key. The seed is
-- regenerated as 3039 for the two new emitters.

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_record_review_owner', 'Record reviews', 'The owner of a record cannot review it.');

-- Columns ------------------------------------------------------------------------------------------------------------------

alter table app.records add column requires_review boolean not null default false;
comment on column app.records.requires_review is 'True when the record reaches Complete only after the latest Approval record about it is decided Approved (G-268, ADR 0153 D5). Turning it on needs work.record.write; turning it off needs projects.settings.write.';

alter table app.template_items add column requires_review boolean not null default false;
alter table app.template_items add constraint template_items_review_records check (item_kind = 'Record' or not requires_review);
comment on column app.template_items.requires_review is 'For a Record item: the records it creates require an approved review before they are Complete (G-268). Always false on a Scope Node item.';

-- Templates carry the flag -------------------------------------------------------------------------------------------------
-- Restated from P8's 2851, the latest definitions, with requires_review on Record items.

create or replace function app.apply_template(
  p_template_id uuid,
  p_project_key text,
  p_name text,
  p_time_zone text default null,
  p_starts_on date default null,
  p_venue_id uuid default null,
  p_without_dates boolean default false
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_template app.templates;
  v_version app.template_versions;
  v_project uuid;
  v_root uuid;
  v_key text := upper(btrim(p_project_key));
  v_zone text;
  v_item app.template_items;
  v_nodes integer := 0;
  v_records integer := 0;
  v_application uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_template from app.templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null then
    raise exception using errcode = '42501', message = 'template not found';
  end if;
  if v_template.current_version_id is null then
    raise exception using errcode = 'XR001', hint = 'template_unpublished',
      message = 'template_unpublished: Publish a version of the template before creating projects from it.';
  end if;
  select * into v_version from app.template_versions v where v.id = v_template.current_version_id;
  v_zone := coalesce(nullif(btrim(p_time_zone), ''), v_version.default_time_zone);
  if v_zone is null then
    raise exception using errcode = 'XR001', hint = 'template_time_zone_required',
      message = 'template_time_zone_required: Choose the project''s time zone; the template does not set one.';
  end if;

  v_project := app.create_project(v_template.org_id, v_key, p_name, v_zone, v_version.default_jurisdiction_id,
    v_version.default_region_code, v_version.default_tier_code, p_venue_id, p_starts_on,
    case when p_starts_on is not null and v_version.duration_days is not null then p_starts_on + v_version.duration_days - 1 end,
    v_version.default_currency_code, v_template.description);
  select n.id into v_root from app.scope_nodes n where n.project_id = v_project and n.parent_id is null and n.deleted_at is null;

  for v_item in
    select * from app.template_items i
    where i.template_version_id = v_version.id and i.deleted_at is null
    order by i.sort_order, i.id
  loop
    if v_item.item_kind = 'Scope Node' then
      insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, venue_id)
      values (v_project, v_root, v_item.scope_kind, v_key || '-' || v_item.scope_code_suffix, v_item.name,
        case when v_item.scope_kind = 'Show' then p_venue_id end);
      v_nodes := v_nodes + 1;
    else
      insert into app.records (project_id, scope_node_id, record_kind, title, phase_code, xyz, xyz_basis, due_at, time_zone,
        requires_review)
      values (v_project, v_root, v_item.record_kind, v_item.name, v_item.phase_code, v_item.xyz, 'Declared',
        case when not coalesce(p_without_dates, false) and p_starts_on is not null and v_item.due_offset_days is not null
          then ((p_starts_on + v_item.due_offset_days)::timestamp + time '17:00') at time zone v_zone end,
        v_zone, v_item.requires_review);
      v_records := v_records + 1;
    end if;
  end loop;

  insert into app.template_applications (template_id, template_version_id, project_id, scope_nodes_created, records_created)
  values (v_template.id, v_version.id, v_project, v_nodes, v_records)
  returning id into v_application;
  return v_application;
end;
$$;

comment on function app.apply_template(uuid, text, text, text, date, uuid, boolean) is 'Creates a project from a template''s current version as the caller: app.create_project with the version''s defaults (the given time zone wins), then its scope nodes under the engagement root ({KEY}-{suffix}) and its records, due at 17:00 project time on the start date plus their offset, or undated when p_without_dates is true (they wait in the schedule''s Unscheduled list; the project still takes the start date). A Record item marked requires_review creates records that need an approved review before they are Complete (B14). Row level security and the guards of every table decide. Records the application and returns its id.';
revoke all on function app.apply_template(uuid, text, text, text, date, uuid, boolean) from public, anon;
grant execute on function app.apply_template(uuid, text, text, text, date, uuid, boolean) to authenticated, service_role;

create or replace function app.create_template_from_project(
  p_project_id uuid,
  p_name text,
  p_description text default null,
  p_keep_dates boolean default true
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project app.projects;
  v_template uuid;
  v_version uuid;
  v_order integer := 0;
  v_node record;
  v_record record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  insert into app.templates (org_id, name, description) values (v_project.org_id, btrim(p_name), nullif(btrim(p_description), ''))
  returning id into v_template;
  insert into app.template_versions (template_id, notes, default_time_zone, default_tier_code, default_region_code,
    default_jurisdiction_id, default_currency_code, duration_days)
  values (v_template, 'Saved from project ' || v_project.project_key || '.', v_project.time_zone, v_project.tier_code,
    v_project.region_code, v_project.jurisdiction_id, v_project.currency,
    case when v_project.starts_on is not null and v_project.ends_on is not null then v_project.ends_on - v_project.starts_on + 1 end)
  returning id into v_version;
  for v_node in
    select n.scope_kind, n.scope_code, n.name from app.scope_nodes n
    where n.project_id = v_project.id and n.parent_id is not null and n.deleted_at is null
      and n.scope_kind in ('Standing Venue', 'Show')
      and n.scope_code like v_project.project_key || '-%'
    order by n.path
  loop
    v_order := v_order + 1;
    insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix)
    values (v_version, 'Scope Node', v_order, v_node.name, v_node.scope_kind,
      left(substr(v_node.scope_code, char_length(v_project.project_key) + 2), 16));
  end loop;
  for v_record in
    select r.record_kind, r.title, r.phase_code, r.xyz, r.due_at, r.requires_review from app.records r
    where r.project_id = v_project.id and r.deleted_at is null and r.record_state not in ('Canceled', 'Complete')
    order by r.record_number
  loop
    v_order := v_order + 1;
    insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, phase_code, due_offset_days,
      requires_review)
    values (v_version, 'Record', v_order, v_record.title, v_record.record_kind, v_record.xyz, v_record.phase_code,
      case when coalesce(p_keep_dates, true) and v_project.starts_on is not null and v_record.due_at is not null
        then greatest(least((v_record.due_at at time zone v_project.time_zone)::date - v_project.starts_on, 3660), -3660) end,
      v_record.requires_review);
  end loop;
  perform app.publish_template_version(v_version);
  return v_template;
end;
$$;

comment on function app.create_template_from_project(uuid, text, text, boolean) is 'Saves a project as a new template, as the caller: its defaults, its show and standing venue scope nodes and its open records (due dates kept relative to the project start, or none when p_keep_dates is false, and each record''s requires_review flag, B14) become a published first version. Needs projects.template.write. Returns the template id.';
revoke all on function app.create_template_from_project(uuid, text, text, boolean) from public, anon;
grant execute on function app.create_template_from_project(uuid, text, text, boolean) to authenticated, service_role;

-- Who may decide a review -----------------------------------------------------------------------------------------------------

create or replace function private.can_decide_record_review(p_person_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and exists (
    select 1 from app.projects p
    where p.id = p_project_id
      and exists (select 1 from app.memberships m
                  where m.org_id = p.org_id and m.person_id = p_person_id and m.deleted_at is null
                    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
      and (private.person_capability_reach(p_person_id, p.org_id, 'work.record.write', true) = 'organization'
           or (private.person_capability_reach(p_person_id, p.org_id, 'work.record.write', true) = 'assigned'
               and exists (select 1 from app.project_members pm
                           join app.memberships m on m.id = pm.membership_id and m.person_id = p_person_id and m.deleted_at is null
                           where pm.project_id = p.id and pm.deleted_at is null))));
$$;

comment on function private.can_decide_record_review(uuid, uuid) is 'True when the person is a live member of the project''s org who reaches work.record.write on the project, at organization reach or at assigned reach as a project member, and so can decide an Approval record there (guard_record_approval, invariant 18). A review is never requested of anyone else (approval_not_eligible).';
revoke all on function private.can_decide_record_review(uuid, uuid) from public, anon, authenticated;

-- Requesting a review --------------------------------------------------------------------------------------------------------

create or replace function app.request_record_review(
  p_record_id uuid,
  p_reviewer_person_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_record app.records;
  v_key text;
  v_reason text := coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Review requested');
  v_approval uuid;
begin
  select * into v_record from app.records r where r.id = p_record_id and r.deleted_at is null for update;
  if v_record.id is null or not private.can_on_project(v_record.project_id, 'work.record.write') then
    raise exception using errcode = '42501', message = 'work.record.write is required on the project';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'a review note is at most 1000 characters';
  end if;
  if v_record.record_kind = 'Approval' then
    perform private.refuse('record_review_kind', 'An approval is decided, not reviewed.');
  end if;
  if v_record.record_state <> 'Active' then
    perform private.refuse('record_review_state', 'Start the work before asking for a review.');
  end if;
  if exists (
      select 1 from app.record_approval a join app.records r on r.id = a.record_id
      where a.subject_record_id = v_record.id and a.decision is null and r.deleted_at is null and r.record_state <> 'Canceled') then
    perform private.refuse('record_review_open', 'A review of this record is still open; wait for its decision.');
  end if;
  -- A review always has someone to decide it and to tell.
  if p_reviewer_person_id is null then
    raise exception using errcode = '22023', message = 'a review names its reviewer';
  end if;
  if p_reviewer_person_id = v_me then
    perform private.refuse('sod_approval_requester', 'An approval is decided by an eligible approver, never the requester.');
  end if;
  if p_reviewer_person_id = v_record.owner_party_id then
    perform private.refuse('sod_record_review_owner', 'The owner of a record cannot review it.');
  end if;
  if not private.can_decide_record_review(p_reviewer_person_id, v_record.project_id) then
    perform private.refuse('approval_not_eligible', 'Only a person who may write the project''s records decides its approvals.');
  end if;

  v_key := private.record_key(v_record.id);
  insert into app.records (project_id, scope_node_id, record_kind, title, xyz, xyz_basis, owner_party_id, time_zone)
  values (v_record.project_id, v_record.scope_node_id, 'Approval', 'Review of ' || v_key, 'Y', 'Declared',
    p_reviewer_person_id, v_record.time_zone)
  returning id into v_approval;
  insert into app.record_approval (record_id, subject_record_id, requester_person_id)
  values (v_approval, v_record.id, v_me);
  perform private.transition_lifecycle('record', 'app.records', 'record_state', 'app.record_state_transitions', 'record_id',
    v_approval, 'Proposed', 'Ready', v_reason);
  perform private.transition_lifecycle('record', 'app.records', 'record_state', 'app.record_state_transitions', 'record_id',
    v_approval, 'Ready', 'Active', v_reason);
  perform private.transition_lifecycle('record', 'app.records', 'record_state', 'app.record_state_transitions', 'record_id',
    v_record.id, 'Active', 'In Review', v_reason);
  perform private.notify(v_record.org_id, p_reviewer_person_id, 'approval.requested', 'app.records', v_approval,
    v_record.project_id, jsonb_build_object('title', v_record.title, 'recordKey', v_key,
      'actorName', (select p.full_name from app.people p where p.id = v_me)));
  return v_approval;
end;
$$;

comment on function app.request_record_review(uuid, uuid, text) is 'Asks for a review of an Active record (G-268, ADR 0153 D5): creates an Approval record "Review of KEY-n" in the record''s project and scope node, owned by the reviewer, with its record_approval naming the record and the caller as requester; moves it Proposed, Ready, Active and the record Active to In Review with the note as reason; and sends the named reviewer approval.requested about the Approval record (subject app.records; title, recordKey of the reviewed record, actorName). Needs work.record.write on the project (42501) and a reviewer (22023). Refuses an Approval record (record_review_kind), a record that is not Active (record_review_state), a record with an undecided review (record_review_open), the caller as reviewer (sod_approval_requester), the record''s owner as reviewer (sod_record_review_owner) and a reviewer who could not decide it (approval_not_eligible). Returns the Approval record id.';
revoke all on function app.request_record_review(uuid, uuid, text) from public, anon;
grant execute on function app.request_record_review(uuid, uuid, text) to authenticated, service_role;

-- Deciding a review ----------------------------------------------------------------------------------------------------------

create or replace function app.decide_record_review(
  p_approval_record_id uuid,
  p_decision app.approval_decision,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_approval app.records;
  v_link app.record_approval;
  v_subject app.records;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_approval from app.records r
  where r.id = p_approval_record_id and r.record_kind = 'Approval' and r.deleted_at is null for update;
  select * into v_link from app.record_approval a where a.record_id = v_approval.id;
  if v_approval.id is null or v_link.subject_record_id is null
     or not private.can_on_project(v_approval.project_id, 'work.record.write') then
    raise exception using errcode = '42501', message = 'work.record.write is required on the project';
  end if;
  if p_decision is null then
    raise exception using errcode = '22023', message = 'a decision is Approved or Rejected';
  end if;
  if p_decision = 'Rejected' and v_note is null then
    perform private.refuse('record_review_note_required', 'Say what to change when you ask for changes.');
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    perform private.refuse('record_review_note_required', 'Keep the note to 1,000 characters.');
  end if;
  select * into v_subject from app.records r where r.id = v_link.subject_record_id for update;
  if v_me = v_subject.owner_party_id then
    perform private.refuse('sod_record_review_owner', 'The owner of a record cannot review it.');
  end if;

  -- The guard stamps the approver from the session and refuses the requester and anyone who cannot decide (0311).
  update app.record_approval set decision = p_decision where record_id = v_approval.id;
  perform private.transition_lifecycle('record', 'app.records', 'record_state', 'app.record_state_transitions', 'record_id',
    v_approval.id, 'Active', 'Complete', coalesce(v_note, p_decision::text));
  if p_decision = 'Rejected' and v_subject.record_state = 'In Review' and v_subject.deleted_at is null then
    perform private.transition_lifecycle('record', 'app.records', 'record_state', 'app.record_state_transitions', 'record_id',
      v_subject.id, 'In Review', 'Active', 'Changes requested: ' || v_note);
  end if;
  update app.notifications set archived_at = now()
  where subject_table = 'app.records' and subject_id = v_approval.id and kind = 'approval.requested'
    and archived_at is null and deleted_at is null;
  perform private.notify(v_approval.org_id, v_link.requester_person_id, 'approval.decided', 'app.records', v_approval.id,
    v_approval.project_id, jsonb_build_object('title', v_subject.title, 'recordKey', private.record_key(v_subject.id),
      'decision', case when p_decision = 'Approved' then 'approved' else 'rejected' end,
      'actorName', (select p.full_name from app.people p where p.id = v_me)));
  return v_approval.id;
end;
$$;

comment on function app.decide_record_review(uuid, app.approval_decision, text) is 'Decides a review an app.request_record_review Approval record asks for (G-268, ADR 0153 D5): records the decision on record_approval, where private.guard_record_approval stamps the session person as approver and refuses the requester (sod_approval_requester) and anyone who cannot write the project''s records (approval_not_eligible), so any eligible approver other than the requester and the record''s owner (sod_record_review_owner) decides; moves the Approval record Active to Complete; on Rejected, which needs a note (record_review_note_required), moves the record back In Review to Active with the note when it is still In Review, and otherwise leaves its state alone; archives the open approval.requested for the Approval record; and sends the requester approval.decided. Needs work.record.write on the project (42501). Returns the Approval record id.';
revoke all on function app.decide_record_review(uuid, app.approval_decision, text) from public, anon;
grant execute on function app.decide_record_review(uuid, app.approval_decision, text) to authenticated, service_role;

-- The done-gate ------------------------------------------------------------------------------------------------------------------

create or replace function private.guard_record_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := case when auth.uid() is not null then private.current_person_id() end;
  v_review record;
  v_found boolean;
  v_active_at timestamptz;
begin
  if old.requires_review and not new.requires_review and auth.uid() is not null
     and not private.can_on_project(new.project_id, 'projects.settings.write') then
    perform private.refuse('record_review_flag_locked', 'Only someone who may change the project''s settings turns off Requires review.');
  end if;
  if new.record_state = 'Complete' and old.record_state <> 'Complete' and new.requires_review then
    -- The latest live, not Canceled Approval record about the record, in its own project.
    select r.id, a.decision, a.approver_person_id, a.decided_at into v_review
    from app.record_approval a join app.records r on r.id = a.record_id
    where a.subject_record_id = new.id and r.project_id = new.project_id
      and r.deleted_at is null and r.record_state <> 'Canceled'
    order by r.created_at desc, r.record_number desc, r.id desc
    limit 1;
    v_found := found;
    -- When the record last entered Active: a decision before that (a reopened record, or an Approved review followed
    -- by a Rejected one that was later deleted) no longer stands.
    select max(t.created_at) into v_active_at
    from app.record_state_transitions t where t.record_id = new.id and t.to_state = 'Active';
    if not v_found then
      perform private.refuse('record_review_required', 'This record needs an approved review before it is Complete.');
    elsif v_review.decision is null then
      perform private.refuse('record_review_pending', 'The review is still open.');
    elsif v_review.decision = 'Rejected' then
      perform private.refuse('record_review_changes_requested', 'The reviewer asked for changes; ask for another review.');
    elsif v_review.approver_person_id is not distinct from new.owner_party_id
       or v_review.approver_person_id is not distinct from v_me
       or (v_active_at is not null and v_review.decided_at <= v_active_at) then
      -- An approval by the record's owner or by the person completing it, or one decided before the record last
      -- entered Active, is not an independent review of the work as it stands.
      perform private.refuse('record_review_required', 'This record needs an approved review before it is Complete.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_record_review() is 'The review done-gate (G-268, ADR 0153 D5): a record with requires_review moves to Complete only when the latest live, not Canceled Approval record about it in its own project is decided Approved (record_review_required with none, record_review_pending while undecided, record_review_changes_requested after Rejected), on every path that changes the state. An Approved review counts only when its approver is neither the record''s owner nor the person completing it and it was decided after the record last entered Active; otherwise record_review_required. Turning requires_review off needs projects.settings.write on the project (record_review_flag_locked); turning it on needs only the record''s write policy.';
revoke all on function private.guard_record_review() from public, anon, authenticated;

create trigger t47_record_review_gate before update of record_state, requires_review on app.records
  for each row execute function private.guard_record_review();

-- Acting on a review request from Inbox -------------------------------------------------------------------------------------------
-- Restated from A127's 2200_one_tap_actions.sql, the latest definition, with the app.records branch.

create or replace function app.act_on_notification(p_notification_id uuid, p_action text, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_note app.notifications;
  v_shift app.shifts;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_conversation uuid;
begin
  select * into v_note from app.notifications n
  where n.id = p_notification_id and n.recipient_person_id = v_person and n.deleted_at is null;
  -- Approving and rejecting are a member's. Done and answering a shift, an offer or a message are the recipient's while
  -- the notification is still theirs to see (private.is_my_notification: a member, an external party or an applicant
  -- the org works with, as row level security on notifications reads it) (A127).
  if v_note.id is null or not coalesce(case when p_action in ('approve', 'reject')
                                            then v_note.org_id in (select private.my_org_ids())
                                            else private.is_my_notification(v_note.id) end, false) then
    raise exception using errcode = '42501', message = 'notification not found';
  end if;
  if p_action is null or p_action not in ('approve', 'reject', 'done', 'accept', 'decline', 'reply') then
    perform private.refuse('inbox_action_unknown', 'An Inbox item is approved, rejected, accepted, declined, answered or marked Done.');
  end if;
  if p_action in ('approve', 'reject') then
    if v_note.kind <> 'approval.requested' or v_note.subject_table not in ('approval_instances', 'timesheets', 'app.records') then
      perform private.refuse('inbox_action_not_offered', 'Only an approval request is approved or rejected from the Inbox.');
    end if;
    if v_note.subject_table = 'timesheets' then
      if p_action = 'reject' and v_comment is null then
        perform private.refuse('timesheet_rejection_reason', 'Say why when you reject a timesheet.');
      end if;
      perform app.decide_timesheet(v_note.subject_id,
        (case when p_action = 'approve' then 'Approved' else 'Rejected' end)::app.approval_decision,
        coalesce(v_comment, 'Approved from a notification.'));
    elsif v_note.subject_table = 'app.records' then
      -- B14 (3034): a record review, by its Approval record; asking for changes needs a note
      -- (record_review_note_required).
      perform app.decide_record_review(v_note.subject_id,
        (case when p_action = 'approve' then 'Approved' else 'Rejected' end)::app.approval_decision, v_comment);
    else
      perform app.decide_approval(v_note.subject_id, p_action = 'approve', p_comment);
    end if;
  elsif p_action in ('accept', 'decline') then
    if v_note.kind in ('shift.assigned', 'shift.changed') and v_note.subject_table = 'app.shifts' then
      select * into v_shift from app.shifts s where s.id = v_note.subject_id;
      if p_action = 'decline' then
        perform app.decline_shift(v_note.subject_id, v_comment);
      elsif v_shift.membership_id is null and v_shift.engagement_id is not null then
        perform app.accept_engaged_shift(v_note.subject_id, 'Accepted from a notification.');
      else
        perform app.accept_shift(v_note.subject_id, 'Accepted from a notification.');
      end if;
    elsif v_note.kind = 'offer.sent' and v_note.subject_table = 'app.offers' then
      if p_action = 'accept' then
        perform app.accept_offer(v_note.subject_id);
      else
        perform app.decline_offer(v_note.subject_id, coalesce(v_comment, 'Declined from a notification.'));
      end if;
    else
      perform private.refuse('inbox_action_not_offered', 'Only a shift or an offer is accepted or declined from a notification.');
    end if;
  elsif p_action = 'reply' then
    v_conversation := case when v_note.message_args ->> 'conversation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (v_note.message_args ->> 'conversation_id')::uuid end;
    if v_note.kind <> 'message.received' or v_conversation is null then
      perform private.refuse('inbox_action_not_offered', 'Only a message is answered from a notification.');
    end if;
    if v_comment is null then
      perform private.refuse('notification_reply_empty', 'Write a reply first.');
    end if;
    perform app.send_chat_message(v_conversation, v_comment);
  end if;
  update app.notifications set read_at = coalesce(read_at, now()), archived_at = now()
  where id = v_note.id and created_at = v_note.created_at;
  return v_note.id;
end;
$$;
comment on function app.act_on_notification(uuid, text, text) is 'Acts on a notification where it arrives (Section 11.10 rule 5), for its recipient only, while it is still theirs to see (private.is_my_notification): approve or reject the approval, the timesheet or the record review (B14, app.records) an approval request asks for (a member''s; app.decide_approval, app.decide_timesheet and app.decide_record_review decide every rule); accept or decline a published shift (app.accept_shift, app.accept_engaged_shift, app.decline_shift) or an offer awaiting the applicant (app.accept_offer, app.decline_offer); reply to a message (app.send_chat_message, the reply in p_comment); or mark it Done. A refusal names its rule and the item stays; a handled or Done item leaves the Inbox. Push notification actions call it through the API (notifications.act) and one-tap email links through app.use_notification_action. Returns the notification id.';
revoke all on function app.act_on_notification(uuid, text, text) from public, anon;
grant execute on function app.act_on_notification(uuid, text, text) to authenticated, service_role;
