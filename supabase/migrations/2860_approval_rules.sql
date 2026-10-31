-- 2860_approval_rules.sql
-- P9 Approval rules (RRR-223, gap G-31, ADR 0138). A project names who approves a pass, a dock booking or an
-- equipment request before it takes effect, in ordered steps, and an outside approver on an engagement step decides
-- too. The spend approval engine of 1030 is keyed to spend documents and their amounts, so this is a second, smaller
-- engine on the same vocabulary (app.approval_policy_state, app.approval_state):
--
--   * app.approval_rules: per project, for one subject (Pass, Delivery or Equipment), with an optional filter used only
--     with its own subject (a credential category, a zone, an asset class). The most specific Active rule matches: a
--     rule with a filter wins over one without, and one Active rule per project, subject and filter.
--   * app.approval_rule_steps: 1 to 5 ordered steps, each naming a role, one member, or an engagement of the project.
--     An engagement step may let its approver decide from the email without signing in (signed_out_links, 2861).
--     Steps change only while the rule is a Draft, so an approval in flight keeps the steps it started with.
--   * app.subject_approvals: one row per pass or dock slot a rule matched, opened by the t91 triggers when the row is
--     created. Its state is never stored (ADR 0103): app.subject_approval_status computes it from the append-only
--     app.subject_approval_decisions and the cancel stamp.
--   * private.decide_subject_approval_as is the one decision path: app.decide_subject_approval for a signed-in
--     approver, app.act_on_notification for the Inbox and push, and api_public.use_approval_link (2861) for the
--     emailed link. Never the requester (sod_approval_requester), never the pass holder, one step per person.
--   * An access scan of a pass whose approval is not Approved records Denied (private.decide_access_scan, from 0352).
--     A Delivery approval does not gate the booking; its status shows on the dock schedule and in Gateway.
--   * Revoking or deleting the pass, or deleting the dock slot, cancels the approval. Equipment requests (R7's
--     allocations) come in 2863, after R7 and R9; until then an Equipment rule is kept as a Draft.
-- Rules, steps and approvals are kept out of Trash: a removed rule or step is a settings change, and an approval is
-- withdrawn by Cancel, never restored.

-- 1. Vocabulary ----------------------------------------------------------------------------------------------------------

create type app.approval_rule_subject as enum ('Pass', 'Delivery', 'Equipment');
comment on type app.approval_rule_subject is 'What an approval rule gates (P9): a Pass (a credential issued on the project), a Delivery (a dock slot booked on the project) or Equipment (an asset allocation of an advance, R7; from 2863).';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('approval_rule', 'Draft', 'Active'),
  ('approval_rule', 'Draft', 'Retired'),
  ('approval_rule', 'Active', 'Retired');

insert into private.domain_event_types (code, subject, description) values
  ('approval_rule.state_changed', 'approval_rules', 'An approval rule was activated or retired.'),
  ('subject_approval.requested', 'subject_approvals', 'A pass, dock booking or equipment request matched an approval rule.'),
  ('subject_approval.step_decided', 'subject_approval_decisions', 'An approver decided one step of a subject approval.')
on conflict (code) do nothing;

-- 2. Rules ---------------------------------------------------------------------------------------------------------------

create table app.approval_rules (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  subject app.approval_rule_subject not null,
  name text not null,
  description text,
  credential_category_id uuid references app.credential_categories (id),
  zone_id uuid references app.zones (id),
  asset_class_id uuid references app.asset_classes (id),
  rule_state app.approval_policy_state not null default 'Draft',
  deleted_at timestamptz,
  constraint approval_rules_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint approval_rules_description_length check (description is null or char_length(description) <= 2000),
  constraint approval_rules_filter_subject check (
    (credential_category_id is null or subject = 'Pass')
    and (zone_id is null or subject = 'Delivery')
    and (asset_class_id is null or subject = 'Equipment'))
);

create index approval_rules_project_id_idx on app.approval_rules (project_id, subject) where deleted_at is null;
create index approval_rules_credential_category_id_idx on app.approval_rules (credential_category_id);
create index approval_rules_zone_id_idx on app.approval_rules (zone_id);
create index approval_rules_asset_class_id_idx on app.approval_rules (asset_class_id);
-- One Active rule per project, subject and filter. NULL (no filter) is a value of the key here.
create unique index approval_rules_one_active on app.approval_rules (project_id, subject, credential_category_id, zone_id, asset_class_id)
  nulls not distinct where rule_state = 'Active' and deleted_at is null;

call private.install_domain_table('app.approval_rules', 'app.projects', 'project_id',
  array['app.credential_categories', 'credential_category_id', 'app.zones', 'zone_id', 'app.asset_classes', 'asset_class_id']);
call private.describe('app.approval_rules', 'Approval rules of a project (P9, G-31): who approves a pass, a dock booking or an equipment request before it takes effect, in ordered steps (app.approval_rule_steps). The most specific Active rule matches a new row: a rule with a filter wins over one without. Project readers read the rules; projects.settings.write on the project or org.approval_policies.write edits them.', array[
  'project_id', 'Project the rule gates. Outside approvers are engagements of this project.',
  'subject', 'What the rule gates: Pass, Delivery or Equipment.',
  'name', 'Rule name, shown to approvers and requesters.',
  'description', 'What the rule is for.',
  'credential_category_id', 'Pass rules only: the credential category the rule matches, of the same project; NULL for every category.',
  'zone_id', 'Delivery rules only: the dock zone the rule matches, of the same org; NULL for every zone.',
  'asset_class_id', 'Equipment rules only: the asset class the rule matches; NULL for every class.',
  'rule_state', 'Draft, Active or Retired. Changes only through app.transition_approval_rule.'
]);

create or replace function private.readable_approval_rule_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.approval_rules r where r.project_id in (select private.readable_project_ids());
$$;

comment on function private.readable_approval_rule_ids() is 'Approval rules the signed-in person may read: those of projects they read (P9). Used by the policies of the steps and the state ledger, never by app.approval_rules itself.';
revoke all on function private.readable_approval_rule_ids() from public, anon;
grant execute on function private.readable_approval_rule_ids() to authenticated, service_role;

call private.install_lifecycle('app.approval_rules', 'approval_rule_id', 'rule_state', 'approval_rule', 'Draft',
  $$approval_rule_id in (select private.readable_approval_rule_ids())$$);

create trigger t90_emit_approval_rule_state after insert on app.approval_rule_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('approval_rule.state_changed', 'approval_rules', 'approval_rule_id', 'from_state', 'to_state');

create or replace function private.can_write_approval_rule(p_org_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_project_id in (select private.project_ids_with('projects.settings.write'))
    or p_org_id in (select private.orgs_with_capability('org.approval_policies.write'));
$$;

comment on function private.can_write_approval_rule(uuid, uuid) is 'Who edits a project''s approval rules, from column values: projects.settings.write on the project, or org.approval_policies.write in the org (P9).';
revoke all on function private.can_write_approval_rule(uuid, uuid) from public, anon;
grant execute on function private.can_write_approval_rule(uuid, uuid) to authenticated, service_role;

create or replace function private.guard_approval_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.credential_category_id is not null and not exists (
      select 1 from app.credential_categories c where c.id = new.credential_category_id and c.project_id = new.project_id) then
    perform private.refuse('approval_rule_filter_project', 'A Pass rule matches a credential category of its own project.');
  end if;
  if tg_op = 'UPDATE' and old.rule_state <> 'Draft'
     and (new.subject is distinct from old.subject
          or new.credential_category_id is distinct from old.credential_category_id
          or new.zone_id is distinct from old.zone_id
          or new.asset_class_id is distinct from old.asset_class_id) then
    perform private.refuse('approval_rule_not_draft',
      format('%s keeps its subject and filter once activated; create a new rule and retire this one.', old.name));
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null and old.rule_state = 'Active' then
    perform private.refuse('approval_rule_active_delete', format('Retire %s before deleting it.', old.name));
  end if;
  return new;
end;
$$;

comment on function private.guard_approval_rule() is 'A Pass rule''s category is of its own project; an Active or Retired rule keeps its subject and filter, and an Active rule is retired before it is deleted (as private.guard_approval_policy does, P9).';
revoke all on function private.guard_approval_rule() from public, anon, authenticated;

create trigger t40_guard_approval_rule before insert or update on app.approval_rules
  for each row execute function private.guard_approval_rule();

call private.install_policies('app.approval_rules',
  $$project_id in (select private.readable_project_ids())$$,
  $$private.can_write_approval_rule(org_id, project_id)$$);

-- 3. Steps ---------------------------------------------------------------------------------------------------------------

create table app.approval_rule_steps (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  approval_rule_id uuid not null references app.approval_rules (id),
  step_order smallint not null,
  name text not null,
  approver_role_id uuid references app.roles (id),
  approver_membership_id uuid references app.memberships (id),
  approver_engagement_id uuid references app.engagements (id),
  signed_out_links boolean not null default false,
  deleted_at timestamptz,
  constraint approval_rule_steps_order_range check (step_order between 1 and 5),
  constraint approval_rule_steps_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint approval_rule_steps_one_approver check (num_nonnulls(approver_role_id, approver_membership_id, approver_engagement_id) = 1),
  constraint approval_rule_steps_signed_out_engagement check (not signed_out_links or approver_engagement_id is not null)
);

create index approval_rule_steps_rule_idx on app.approval_rule_steps (approval_rule_id, step_order);
create index approval_rule_steps_role_idx on app.approval_rule_steps (approver_role_id);
create index approval_rule_steps_membership_idx on app.approval_rule_steps (approver_membership_id);
create index approval_rule_steps_engagement_idx on app.approval_rule_steps (approver_engagement_id);
create unique index approval_rule_steps_order_key on app.approval_rule_steps (approval_rule_id, step_order) where deleted_at is null;

call private.install_domain_table('app.approval_rule_steps', 'app.approval_rules', 'approval_rule_id',
  array['app.roles', 'approver_role_id', 'app.memberships', 'approver_membership_id', 'app.engagements', 'approver_engagement_id']);
call private.describe('app.approval_rule_steps', 'Ordered steps of an approval rule (P9). Each names its approvers: everyone holding a role, one member, or an engagement of the rule''s project (the engaged person, or the Owner and Admin of the engaged account). Edited only while the rule is a Draft.', array[
  'approval_rule_id', 'Rule the step belongs to.',
  'step_order', 'Position of the step, 1 to 5; steps are decided in order.',
  'name', 'Step name, such as Production manager or Venue security.',
  'approver_role_id', 'Role whose holders decide the step; NULL otherwise.',
  'approver_membership_id', 'The one member who decides the step; NULL otherwise.',
  'approver_engagement_id', 'Engagement of the rule''s project, not Complete or Canceled, whose party decides the step; NULL otherwise.',
  'signed_out_links', 'Engagement steps only: the approver may decide from the email without signing in, with a 6-digit code emailed on demand (2861). They still need an XOS account to receive email.'
]);

create or replace function private.approval_rule_of(p_rule_id uuid)
returns app.approval_rules
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from app.approval_rules r where r.id = p_rule_id;
$$;

comment on function private.approval_rule_of(uuid) is 'An approval rule by id, for the step guard and the approval helpers (takes the rule id as a value).';
revoke all on function private.approval_rule_of(uuid) from public, anon, authenticated;

create or replace function private.guard_approval_rule_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule app.approval_rules := private.approval_rule_of(new.approval_rule_id);
  v_old_rule app.approval_rules;
begin
  if tg_op = 'UPDATE' then
    v_old_rule := private.approval_rule_of(old.approval_rule_id);
  end if;
  if v_rule.rule_state is distinct from 'Draft' or (tg_op = 'UPDATE' and v_old_rule.rule_state is distinct from 'Draft') then
    perform private.refuse('approval_rule_step_not_draft',
      format('Steps of %s change only while it is a Draft, so approvals in flight keep the steps they started with.',
        coalesce(v_rule.name, v_old_rule.name)));
  end if;
  if new.approver_engagement_id is not null and new.deleted_at is null and not exists (
      select 1 from app.engagements e
      where e.id = new.approver_engagement_id and e.project_id = v_rule.project_id and e.deleted_at is null
        and e.engagement_state not in ('Complete', 'Canceled')) then
    perform private.refuse('approval_step_engagement', 'An engagement step names an open engagement of the rule''s project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_approval_rule_step() is 'Steps are added, edited and removed only while their rule is a Draft (the refusal names the rule), and an engagement step names an engagement of the rule''s project that is not Complete or Canceled (P9).';
revoke all on function private.guard_approval_rule_step() from public, anon, authenticated;

create trigger t40_guard_approval_rule_step before insert or update on app.approval_rule_steps
  for each row execute function private.guard_approval_rule_step();

create or replace function private.can_write_approval_rule_id(p_rule_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.approval_rules r where r.id = p_rule_id and private.can_write_approval_rule(r.org_id, r.project_id));
$$;

comment on function private.can_write_approval_rule_id(uuid) is 'True when the signed-in person edits the rule (private.can_write_approval_rule), for the step policies (P9).';
revoke all on function private.can_write_approval_rule_id(uuid) from public, anon;
grant execute on function private.can_write_approval_rule_id(uuid) to authenticated, service_role;

call private.install_policies('app.approval_rule_steps',
  $$approval_rule_id in (select private.readable_approval_rule_ids())$$,
  $$private.can_write_approval_rule_id(approval_rule_id)$$);

-- 4. Approvers ------------------------------------------------------------------------------------------------------------

create or replace function private.approval_subject_read_capability(p_subject app.approval_rule_subject)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_subject
    when 'Pass' then 'credentials.credential.read'
    when 'Delivery' then 'logistics.shipment.read'
    when 'Equipment' then 'assets.asset.read'
  end;
$$;

comment on function private.approval_subject_read_capability(app.approval_rule_subject) is 'The capability that reads an approval rule''s subject on the project: credentials.credential.read (Pass), logistics.shipment.read (Delivery) or assets.asset.read (Equipment). A member approver must hold it (P9).';
revoke all on function private.approval_subject_read_capability(app.approval_rule_subject) from public, anon, authenticated;
grant execute on function private.approval_subject_read_capability(app.approval_rule_subject) to authenticated, service_role;

create or replace function private.rule_step_person_ids(p_step_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with step as (
    select s.*, r.subject, r.org_id as rule_org_id from app.approval_rule_steps s
    join app.approval_rules r on r.id = s.approval_rule_id
    where s.id = p_step_id and s.deleted_at is null
  )
  -- A role or member step: active members holding the role, or the member, who also read the subject.
  select distinct m.person_id from step s
  join app.memberships m on m.org_id = s.rule_org_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where s.approver_engagement_id is null
    and (m.id = s.approver_membership_id
         or (s.approver_role_id is not null and exists (select 1 from app.membership_roles mr
             where mr.membership_id = m.id and mr.role_id = s.approver_role_id and mr.deleted_at is null)))
    and private.person_capability_reach(m.person_id, s.rule_org_id, private.approval_subject_read_capability(s.subject), false) is not null
  union
  -- An engagement step: the engaged person, or the Owner and Admin of the engaged account.
  select x from step s
  join app.engagements e on e.id = s.approver_engagement_id and e.deleted_at is null
    and e.engagement_state not in ('Complete', 'Canceled')
  left join app.counterparties c on c.id = e.counterparty_id
  cross join lateral private.party_recipient_ids(e.person_id, case when e.person_id is null then c.organization_id end) x;
$$;

comment on function private.rule_step_person_ids(uuid) is 'Everyone a step of an approval rule names now (P9). A role or member step: active members of the org who hold the role, or the member, and who hold the subject''s read capability (private.approval_subject_read_capability). An engagement step: the engaged person, or, for an engagement of an external account with no person, the account''s Owner and Admin members (private.party_recipient_ids). Nobody for a removed step or a Complete or Canceled engagement.';
revoke all on function private.rule_step_person_ids(uuid) from public, anon, authenticated;

create or replace function private.approval_step_reachable(p_step_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.rule_step_person_ids(p_step_id) x
                 join app.people p on p.id = x where p.user_id is not null);
$$;

comment on function private.approval_step_reachable(uuid) is 'True when a step names at least one person with an XOS account, the only people notifications reach by email (private.recipient_address). An engagement step without one cannot be activated (approval_step_no_approver, P9).';
revoke all on function private.approval_step_reachable(uuid) from public, anon, authenticated;

-- 5. Subject approvals --------------------------------------------------------------------------------------------------------

create table app.subject_approvals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  approval_rule_id uuid not null references app.approval_rules (id),
  credential_id uuid references app.credentials (id),
  dock_slot_id uuid references app.dock_slots (id),
  requested_by uuid references app.people (id),
  canceled_at timestamptz,
  canceled_by uuid references app.people (id),
  cancel_reason text,
  deleted_at timestamptz,
  constraint subject_approvals_one_subject check (num_nonnulls(credential_id, dock_slot_id) = 1),
  constraint subject_approvals_cancel_reason_length check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500),
  constraint subject_approvals_cancel_pair check ((canceled_at is null) = (cancel_reason is null))
);

create index subject_approvals_project_id_idx on app.subject_approvals (project_id);
create index subject_approvals_rule_idx on app.subject_approvals (approval_rule_id);
create index subject_approvals_requested_by_idx on app.subject_approvals (requested_by);
create index subject_approvals_canceled_by_idx on app.subject_approvals (canceled_by);
create unique index subject_approvals_one_live_credential on app.subject_approvals (credential_id)
  where credential_id is not null and canceled_at is null and deleted_at is null;
create unique index subject_approvals_one_live_dock_slot on app.subject_approvals (dock_slot_id)
  where dock_slot_id is not null and canceled_at is null and deleted_at is null;

call private.install_domain_table('app.subject_approvals', 'app.approval_rules', 'approval_rule_id',
  array['app.projects', 'project_id', 'app.credentials', 'credential_id', 'app.dock_slots', 'dock_slot_id']);
call private.describe('app.subject_approvals', 'A pass or a dock booking going through the approval rule it matched (P9), opened when the row was created. Its state is computed, never stored (ADR 0103): app.subject_approval_status reads the decisions and the cancel stamp. Written only by the approval functions.', array[
  'project_id', 'Project of the subject, stamped from it on insert (private.copy_parent_project) and never changed.',
  'approval_rule_id', 'Rule the subject matched.',
  'credential_id', 'Pass rules: the credential (pass) awaiting approval.',
  'dock_slot_id', 'Delivery rules: the dock slot awaiting approval.',
  'requested_by', 'Who created the subject row, never an approver of it (sod_approval_requester); NULL when the service, an import or a trusted operation created it.',
  'canceled_at', 'When the approval was withdrawn: by Cancel, or because its subject was revoked or deleted.',
  'canceled_by', 'Who withdrew it; NULL when the database did.',
  'cancel_reason', 'Why it was withdrawn; set exactly when canceled_at is.'
]);

create trigger t15_subject_approvals_credential_project before insert or update of credential_id, project_id on app.subject_approvals
  for each row when (new.credential_id is not null)
  execute function private.copy_parent_project('app.credentials', 'credential_id');
create trigger t15_subject_approvals_dock_slot_project before insert or update of dock_slot_id, project_id on app.subject_approvals
  for each row when (new.dock_slot_id is not null)
  execute function private.copy_parent_project('app.dock_slots', 'dock_slot_id');

create or replace function private.guard_subject_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule app.approval_rules := private.approval_rule_of(new.approval_rule_id);
begin
  if not private.in_trusted_operation('subject_approval') and auth.uid() is not null then
    perform private.refuse('subject_approval_rpc_only', 'An approval changes only through its functions.');
  end if;
  if tg_op = 'INSERT' then
    if (v_rule.subject = 'Pass') is distinct from (new.credential_id is not null)
       or (v_rule.subject = 'Delivery') is distinct from (new.dock_slot_id is not null) then
      perform private.refuse('subject_approval_subject', 'An approval''s subject is the kind its rule gates.');
    end if;
    return new;
  end if;
  if new.approval_rule_id is distinct from old.approval_rule_id or new.credential_id is distinct from old.credential_id
     or new.dock_slot_id is distinct from old.dock_slot_id or new.requested_by is distinct from old.requested_by
     or (old.canceled_at is not null and (new.canceled_at is distinct from old.canceled_at
         or new.canceled_by is distinct from old.canceled_by or new.cancel_reason is distinct from old.cancel_reason)) then
    perform private.refuse('subject_approval_rpc_only', 'An approval keeps its rule, subject and requester, and a cancel is final.');
  end if;
  return new;
end;
$$;

comment on function private.guard_subject_approval() is 'Subject approvals change only inside the approval functions (trusted operation subject_approval): an approval''s subject is the kind its rule gates, it keeps its rule, subject and requester, and a cancel is final (P9).';
revoke all on function private.guard_subject_approval() from public, anon, authenticated;

create trigger t40_guard_subject_approval before insert or update on app.subject_approvals
  for each row execute function private.guard_subject_approval();

create trigger t90_emit_subject_approval_requested after insert on app.subject_approvals
  for each row execute function private.emit_subject_event('subject_approval.requested', 'subject_approvals', 'id',
    'approval_rule_id', 'credential_id', 'dock_slot_id');

-- 6. Decisions --------------------------------------------------------------------------------------------------------------

create table app.subject_approval_decisions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_approval_id uuid not null references app.subject_approvals (id),
  step_order smallint not null,
  approver_person_id uuid not null references app.people (id),
  approved boolean not null,
  comment text,
  decided_via text not null,
  decided_at timestamptz not null default now(),
  constraint subject_approval_decisions_step_range check (step_order between 1 and 5),
  constraint subject_approval_decisions_comment_length check (comment is null or char_length(comment) <= 2000),
  constraint subject_approval_decisions_rejection_reason check (approved or (comment is not null and char_length(btrim(comment)) > 0)),
  constraint subject_approval_decisions_via check (decided_via in ('App', 'Email link'))
);

create index subject_approval_decisions_approval_idx on app.subject_approval_decisions (subject_approval_id, step_order);
create index subject_approval_decisions_approver_idx on app.subject_approval_decisions (approver_person_id);
create unique index subject_approval_decisions_one_per_step on app.subject_approval_decisions (subject_approval_id, step_order);
create unique index subject_approval_decisions_one_per_approver on app.subject_approval_decisions (subject_approval_id, approver_person_id);

call private.install_domain_table('app.subject_approval_decisions', 'app.subject_approvals', 'subject_approval_id', '{}', true);
call private.describe('app.subject_approval_decisions', 'Append-only decisions on the steps of subject approvals (P9), written only by private.decide_subject_approval_as: one per step, one step per approver, never by the requester or the pass holder.', array[
  'subject_approval_id', 'Approval decided.',
  'step_order', 'Step decided.',
  'approver_person_id', 'Person who decided: the signed-in approver, or the recipient of the emailed link.',
  'approved', 'True when the step was approved; false rejects the approval.',
  'comment', 'Why; required when rejecting.',
  'decided_via', 'App (Atlas, Gateway, the Inbox or a push) or Email link (signed out, with an emailed code).',
  'decided_at', 'When it was decided.'
]);

create trigger t90_emit_subject_approval_step_decided after insert on app.subject_approval_decisions
  for each row execute function private.emit_subject_event('subject_approval.step_decided', 'subject_approval_decisions', 'id',
    'subject_approval_id', 'step_order', 'approved');

-- 7. Who may decide the current step ----------------------------------------------------------------------------------------

create or replace function private.subject_approval_beneficiary(p_approval_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.holder_person_id from app.subject_approvals a
  join app.credentials c on c.id = a.credential_id
  where a.id = p_approval_id;
$$;

comment on function private.subject_approval_beneficiary(uuid) is 'Who a subject approval benefits, never an approver of it (approval_subject_beneficiary): the pass holder. A dock booking benefits nobody in particular (P9; 2863 adds an allocation''s holder).';
revoke all on function private.subject_approval_beneficiary(uuid) from public, anon, authenticated;

create or replace function private.subject_step_approver_person_ids(p_approval_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with approval as (
    select a.* from app.subject_approvals a where a.id = p_approval_id and a.deleted_at is null and a.canceled_at is null
  ),
  step as (
    select s.id from approval a
    join app.approval_rule_steps s on s.approval_rule_id = a.approval_rule_id and s.deleted_at is null
    where not exists (select 1 from app.subject_approval_decisions d where d.subject_approval_id = a.id and not d.approved)
      and not exists (select 1 from app.subject_approval_decisions d where d.subject_approval_id = a.id and d.step_order = s.step_order)
    order by s.step_order limit 1
  )
  select x from step s
  cross join lateral private.rule_step_person_ids(s.id) x
  cross join approval a
  where x is distinct from a.requested_by
    and x is distinct from private.subject_approval_beneficiary(a.id)
    and not exists (select 1 from app.subject_approval_decisions d where d.subject_approval_id = a.id and d.approver_person_id = x);
$$;

comment on function private.subject_step_approver_person_ids(uuid) is 'The people who may decide the step a subject approval waits on now (P9): everyone the step names (private.rule_step_person_ids), leaving out the requester, people who already decided a step and the beneficiary (the pass holder). Nobody once the approval is decided, canceled or deleted. When the exclusions leave nobody, the approval stays In Review and Approvals says no one can decide the step.';
revoke all on function private.subject_step_approver_person_ids(uuid) from public, anon, authenticated;

create or replace function private.is_subject_step_approver(p_approval_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and p_person_id in (select private.subject_step_approver_person_ids(p_approval_id));
$$;

comment on function private.is_subject_step_approver(uuid, uuid) is 'True when the person may decide the step a subject approval waits on now (private.subject_step_approver_person_ids, P9).';
revoke all on function private.is_subject_step_approver(uuid, uuid) from public, anon, authenticated;

-- 8. Computed state -----------------------------------------------------------------------------------------------------------

create or replace function private.subject_approval_progress(p_approval_id uuid, p_rule_id uuid, p_canceled_at timestamptz, p_created_at timestamptz)
returns table (
  subject app.approval_rule_subject,
  rule_name text,
  approval_state app.approval_state,
  current_step smallint,
  current_step_name text,
  current_step_has_approver boolean,
  step_count integer,
  waiting_since timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with steps as (
    select s.id, s.step_order, s.name from app.approval_rule_steps s
    where s.approval_rule_id = p_rule_id and s.deleted_at is null
  ),
  decisions as (
    select d.step_order, d.approved, d.decided_at from app.subject_approval_decisions d
    where d.subject_approval_id = p_approval_id
  ),
  facts as (
    select
      (case when p_canceled_at is not null then 'Canceled'
            when exists (select 1 from decisions d where not d.approved) then 'Rejected'
            when exists (select 1 from steps) and not exists (
              select 1 from steps s where not exists (select 1 from decisions d where d.step_order = s.step_order and d.approved))
              then 'Approved'
            else 'In Review' end)::app.approval_state as state,
      (select s.id from steps s where not exists (select 1 from decisions d where d.step_order = s.step_order)
       order by s.step_order limit 1) as next_step_id
  )
  select r.subject, r.name, f.state,
    case when f.state = 'In Review' then (select s.step_order from steps s where s.id = f.next_step_id) end,
    case when f.state = 'In Review' then (select s.name from steps s where s.id = f.next_step_id) end,
    case when f.state = 'In Review' then exists (
      select 1 from private.subject_step_approver_person_ids(p_approval_id) x) end,
    (select count(*)::integer from steps),
    coalesce((select max(d.decided_at) from decisions d), p_created_at)
  from facts f
  join app.approval_rules r on r.id = p_rule_id;
$$;

comment on function private.subject_approval_progress(uuid, uuid, timestamptz, timestamptz) is 'The computed state of a subject approval from column values (ADR 0103, ADR 0016 rule 14): Canceled when canceled; Rejected when any decision rejects; Approved when every live step of the rule is approved; In Review otherwise, waiting on the lowest step without a decision (its order, its name, and whether anyone may still decide it). waiting_since is the last decision''s time, or when the approval opened. Also the rule''s subject and name. Read by app.subject_approval_status, so outside approvers and a delivery''s vendor see the state without reading the decisions.';
revoke all on function private.subject_approval_progress(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function private.subject_approval_progress(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;

create or replace function private.subject_approval_state(p_approval_id uuid)
returns app.approval_state
language sql
stable
security definer
set search_path = ''
as $$
  select p.approval_state from app.subject_approvals a
  cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) p
  where a.id = p_approval_id;
$$;

comment on function private.subject_approval_state(uuid) is 'The computed state of one subject approval, for the functions that decide, gate and remind (P9).';
revoke all on function private.subject_approval_state(uuid) from public, anon, authenticated;

create or replace function private.subject_approval_current_step(p_approval_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select p.current_step from app.subject_approvals a
  cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) p
  where a.id = p_approval_id;
$$;

comment on function private.subject_approval_current_step(uuid) is 'The step a subject approval waits on while In Review, else NULL (P9).';
revoke all on function private.subject_approval_current_step(uuid) from public, anon, authenticated;

create or replace function private.subject_step_answers_by_engagement(p_approval_id uuid, p_person_id uuid)
returns table (step_order smallint, signed_out_links boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.step_order, s.signed_out_links from app.subject_approvals a
  join app.approval_rule_steps s on s.approval_rule_id = a.approval_rule_id and s.deleted_at is null
  where a.id = p_approval_id and s.approver_engagement_id is not null
    and s.step_order = private.subject_approval_current_step(a.id)
    and p_person_id in (select private.rule_step_person_ids(s.id));
$$;

comment on function private.subject_step_answers_by_engagement(uuid, uuid) is 'The current step of a subject approval when the person answers it through the step''s engagement, with whether that step lets them decide from email without signing in; no row otherwise (P9, read by the one-tap link functions of 2861).';
revoke all on function private.subject_step_answers_by_engagement(uuid, uuid) from public, anon, authenticated;

-- 9. Who reads an approval -------------------------------------------------------------------------------------------------------

create or replace function private.is_approval_rule_approver(p_rule_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_person_id() is not null and exists (
    select 1 from app.approval_rule_steps s
    where s.approval_rule_id = p_rule_id and s.deleted_at is null
      and private.current_person_id() in (select private.rule_step_person_ids(s.id)));
$$;

comment on function private.is_approval_rule_approver(uuid) is 'True when the signed-in person is named by any step of the rule (P9).';
revoke all on function private.is_approval_rule_approver(uuid) from public, anon;
grant execute on function private.is_approval_rule_approver(uuid) to authenticated, service_role;

create or replace function private.can_read_subject_approval(
  p_org_id uuid,
  p_project_id uuid,
  p_rule_id uuid,
  p_requested_by uuid,
  p_credential_id uuid,
  p_dock_slot_id uuid,
  p_include_vendor boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_person_id() is not null and (
    p_requested_by = private.current_person_id()
    or private.is_approval_rule_approver(p_rule_id)
    or (p_credential_id is not null and private.can_on_project(p_project_id, 'credentials.credential.read'))
    or (p_dock_slot_id is not null and private.can_on_project(p_project_id, 'logistics.shipment.read'))
    or private.can_write_approval_rule(p_org_id, p_project_id)
    or (p_include_vendor and p_dock_slot_id is not null and exists (
      select 1 from app.dock_slots d
      where d.id = p_dock_slot_id and d.engagement_id in (select private.my_engagement_ids('operational')))));
$$;

comment on function private.can_read_subject_approval(uuid, uuid, uuid, uuid, uuid, uuid, boolean) is 'Read rule of subject approvals, from column values (P9): the requester, anyone a step of the rule names, readers of the subject on the project (credentials.credential.read for a pass, logistics.shipment.read for a dock slot), rule writers, and, with p_include_vendor, the vendor whose engagement the dock slot serves while its operational area is open. The vendor branch covers the approval row only, never its decisions.';
revoke all on function private.can_read_subject_approval(uuid, uuid, uuid, uuid, uuid, uuid, boolean) from public, anon;
grant execute on function private.can_read_subject_approval(uuid, uuid, uuid, uuid, uuid, uuid, boolean) to authenticated, service_role;

call private.install_policies('app.subject_approvals',
  $$private.can_read_subject_approval(org_id, project_id, approval_rule_id, requested_by, credential_id, dock_slot_id, true)$$);

create or replace function private.readable_subject_approval_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id from app.subject_approvals a
  where a.deleted_at is null
    and private.can_read_subject_approval(a.org_id, a.project_id, a.approval_rule_id, a.requested_by, a.credential_id, a.dock_slot_id, false);
$$;

comment on function private.readable_subject_approval_ids() is 'Subject approvals whose decisions the signed-in person may read: the approval read rule without the vendor branch (P9). Used by the decision ledger''s policy, never by app.subject_approvals itself.';
revoke all on function private.readable_subject_approval_ids() from public, anon;
grant execute on function private.readable_subject_approval_ids() to authenticated, service_role;

call private.install_policies('app.subject_approval_decisions',
  $$subject_approval_id in (select private.readable_subject_approval_ids())$$);

create or replace function private.subject_step_for_viewer(p_approval_id uuid)
returns table (viewer_may_decide boolean, approver_names text[])
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_subject_step_approver(a.id, private.current_person_id()),
    coalesce((select array_agg(p.full_name order by p.full_name)
              from private.subject_step_approver_person_ids(a.id) x join app.people p on p.id = x), '{}'::text[])
  from app.subject_approvals a
  where a.id = p_approval_id
    and private.can_read_subject_approval(a.org_id, a.project_id, a.approval_rule_id, a.requested_by, a.credential_id, a.dock_slot_id, false);
$$;

comment on function private.subject_step_for_viewer(uuid) is 'For a subject approval the signed-in person may read (without the vendor branch): whether they may decide its current step now, and the names of everyone who may (P9). No row for anyone else.';
revoke all on function private.subject_step_for_viewer(uuid) from public, anon;
grant execute on function private.subject_step_for_viewer(uuid) to authenticated, service_role;

create view app.subject_approval_status with (security_invoker = true) as
select a.id, a.org_id, a.project_id, a.approval_rule_id, p.rule_name, p.subject, a.credential_id, a.dock_slot_id,
  a.requested_by, a.created_at, p.approval_state, p.current_step, p.current_step_name, p.current_step_has_approver,
  p.step_count, p.waiting_since, a.canceled_at, a.cancel_reason,
  coalesce(v.viewer_may_decide, false) as viewer_may_decide, v.approver_names as current_step_approver_names
from app.subject_approvals a
cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) p
left join lateral private.subject_step_for_viewer(a.id) v on p.approval_state = 'In Review'
where a.deleted_at is null;

call private.describe('app.subject_approval_status', 'Every subject approval the signed-in person may read, with its computed state (ADR 0103, P9): In Review at its current step, Approved, Rejected or Canceled. Read with the person''s own row level security on app.subject_approvals.', array[
  'id', 'Subject approval.',
  'org_id', 'Org of the approval.',
  'project_id', 'Project of the subject.',
  'approval_rule_id', 'Rule the subject matched.',
  'rule_name', 'Name of the rule.',
  'subject', 'Pass, Delivery or Equipment.',
  'credential_id', 'Pass awaiting approval.',
  'dock_slot_id', 'Dock slot awaiting approval.',
  'requested_by', 'Who created the subject row; NULL when the service did.',
  'created_at', 'When the approval opened.',
  'approval_state', 'In Review, Approved, Rejected or Canceled, computed from the decisions and the cancel stamp.',
  'current_step', 'While In Review: the step it waits on.',
  'current_step_name', 'While In Review: the name of that step.',
  'current_step_has_approver', 'While In Review: false when no one may decide the step now, after leaving out the requester, people who decided and the beneficiary.',
  'step_count', 'Live steps of the rule.',
  'waiting_since', 'When the last decision was made, or when the approval opened.',
  'canceled_at', 'When the approval was withdrawn.',
  'cancel_reason', 'Why it was withdrawn.',
  'viewer_may_decide', 'While In Review: true when the signed-in person may decide the current step now.',
  'current_step_approver_names', 'While In Review: the names of everyone who may decide the current step; NULL for the vendor of a delivery.'
]);

revoke all on app.subject_approval_status from public, anon;
grant select on app.subject_approval_status to authenticated, service_role;
revoke select on app.subject_approval_status from xos_backup;

-- 10. Titles and notices -------------------------------------------------------------------------------------------------------

create or replace function private.subject_approval_title(p_approval_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when a.credential_id is not null then
      (select format('Pass %s for %s', c.credential_number, p.full_name)
       from app.credentials c join app.people p on p.id = c.holder_person_id where c.id = a.credential_id)
    when a.dock_slot_id is not null then
      (select format('Dock slot %s %s', z.name, to_char(d.starts_at at time zone coalesce(pr.time_zone, 'UTC'), 'YYYY-MM-DD HH24:MI'))
       from app.dock_slots d join app.zones z on z.id = d.zone_id join app.projects pr on pr.id = d.project_id
       where d.id = a.dock_slot_id)
  end
  from app.subject_approvals a where a.id = p_approval_id;
$$;

comment on function private.subject_approval_title(uuid) is 'What a subject approval is about, for its notices: "Pass CR-000123 for Jane Doe" or "Dock slot Dock A 2027-06-14 14:00" in the project''s time zone (P9). It names the pass holder, so the signed-out link page shows it only after the access code (2861).';
revoke all on function private.subject_approval_title(uuid) from public, anon, authenticated;

create or replace function private.retire_subject_approval_notices(p_approval_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.notifications set archived_at = now()
  where subject_table = 'subject_approvals' and subject_id = p_approval_id
    and kind in ('approval.requested', 'approval.reminder') and archived_at is null and deleted_at is null;
  update private.notification_action_tokens set revoked_at = now()
  where subject_table = 'subject_approvals' and subject_id = p_approval_id and used_at is null and revoked_at is null;
end;
$$;

comment on function private.retire_subject_approval_notices(uuid) is 'Once a step of a subject approval is decided or the approval is withdrawn, its open approval requests and reminders leave every Inbox and their unused one-tap links stop working (P9).';
revoke all on function private.retire_subject_approval_notices(uuid) from public, anon, authenticated;

create or replace function private.notify_subject_step_approvers(p_approval_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_approval app.subject_approvals;
  v_person uuid;
  v_step smallint := private.subject_approval_current_step(p_approval_id);
  v_args jsonb;
begin
  select * into v_approval from app.subject_approvals a where a.id = p_approval_id;
  if v_approval.id is null or v_step is null then
    return;
  end if;
  v_args := jsonb_build_object(
    'title', private.subject_approval_title(v_approval.id),
    'actorName', coalesce((select p.full_name from app.people p where p.id = v_approval.requested_by),
                          (select o.name from app.organizations o where o.id = v_approval.org_id), ''),
    'step', (select s.name from app.approval_rule_steps s
             where s.approval_rule_id = v_approval.approval_rule_id and s.step_order = v_step and s.deleted_at is null),
    'stepOrder', v_step,
    'subject', (private.approval_rule_of(v_approval.approval_rule_id)).subject::text);
  for v_person in select x from private.subject_step_approver_person_ids(v_approval.id) x loop
    perform private.notify(v_approval.org_id, v_person, 'approval.requested', 'subject_approvals', v_approval.id,
      v_approval.project_id, v_args);
  end loop;
end;
$$;

comment on function private.notify_subject_step_approvers(uuid) is 'Asks everyone who may decide a subject approval''s current step (approval.requested about subject_approvals, P9). Arguments: title (private.subject_approval_title), actorName (the requester, or the org), step (the step''s name), stepOrder and subject. An engagement step''s approver hears as an external party of the org.';
revoke all on function private.notify_subject_step_approvers(uuid) from public, anon, authenticated;

-- 11. Opening ----------------------------------------------------------------------------------------------------------------------

create or replace function private.match_approval_rule(p_project_id uuid, p_subject app.approval_rule_subject, p_filter_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.approval_rules r
  cross join lateral (select case p_subject when 'Pass' then r.credential_category_id
                                             when 'Delivery' then r.zone_id
                                             else r.asset_class_id end as filter_id) f
  where r.project_id = p_project_id and r.subject = p_subject and r.rule_state = 'Active' and r.deleted_at is null
    and (f.filter_id is null or f.filter_id = p_filter_id)
    and exists (select 1 from app.approval_rule_steps s where s.approval_rule_id = r.id and s.deleted_at is null)
  order by (f.filter_id is null), r.id
  limit 1;
$$;

comment on function private.match_approval_rule(uuid, app.approval_rule_subject, uuid) is 'The most specific Active rule of a project for a subject and its filter value (a credential category, a zone or an asset class): a rule whose filter matches wins over a rule with no filter (P9). NULL when none applies.';
revoke all on function private.match_approval_rule(uuid, app.approval_rule_subject, uuid) from public, anon, authenticated;

create or replace function private.open_subject_approval(p_rule_id uuid, p_credential_id uuid, p_dock_slot_id uuid, p_requested_by uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.begin_trusted_operation('subject_approval');
  insert into app.subject_approvals (approval_rule_id, credential_id, dock_slot_id, requested_by)
  values (p_rule_id, p_credential_id, p_dock_slot_id, p_requested_by)
  returning id into v_id;
  perform private.end_trusted_operation('subject_approval');
  perform private.notify_subject_step_approvers(v_id);
  return v_id;
end;
$$;

comment on function private.open_subject_approval(uuid, uuid, uuid, uuid) is 'Opens the approval of a subject row its rule matched and asks the first step''s approvers (P9). The project is stamped from the subject. Returns the approval id.';
revoke all on function private.open_subject_approval(uuid, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function private.open_pass_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule uuid := private.match_approval_rule(new.project_id, 'Pass', new.credential_category_id);
begin
  if v_rule is not null and new.deleted_at is null and new.revoked_at is null then
    perform private.open_subject_approval(v_rule, new.id, null, new.created_by);
  end if;
  return null;
end;
$$;

comment on function private.open_pass_approval() is 'A credential issued on a project with a matching Active Pass rule opens its approval (P9): the most specific rule for its category, on the credential''s own project (copied from its category, 0470). The requester is whoever created the row.';
revoke all on function private.open_pass_approval() from public, anon, authenticated;

create trigger t91_open_pass_approval after insert on app.credentials
  for each row execute function private.open_pass_approval();

create or replace function private.open_delivery_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule uuid := private.match_approval_rule(new.project_id, 'Delivery', new.zone_id);
begin
  if v_rule is not null and new.deleted_at is null then
    perform private.open_subject_approval(v_rule, null, new.id, new.created_by);
  end if;
  return null;
end;
$$;

comment on function private.open_delivery_approval() is 'A dock slot booked on a project with a matching Active Delivery rule opens its approval (P9): the most specific rule for its zone. The requester is whoever booked it.';
revoke all on function private.open_delivery_approval() from public, anon, authenticated;

create trigger t91_open_delivery_approval after insert on app.dock_slots
  for each row execute function private.open_delivery_approval();

-- 12. Deciding --------------------------------------------------------------------------------------------------------------------

create or replace function private.decide_subject_approval_as(
  p_approval_id uuid,
  p_person_id uuid,
  p_approved boolean,
  p_comment text,
  p_via text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_approval app.subject_approvals;
  v_step smallint;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_decision uuid;
  v_state app.approval_state;
begin
  select * into v_approval from app.subject_approvals a where a.id = p_approval_id and a.deleted_at is null for update;
  if v_approval.id is null or p_person_id is null then
    raise exception using errcode = '42501', message = 'approval not found';
  end if;
  v_state := private.subject_approval_state(v_approval.id);
  if v_state <> 'In Review' then
    perform private.refuse('approval_not_in_review', format('This approval is %s; only an approval in review is decided.', v_state));
  end if;
  perform private.assert_separation('sod_approval_requester', p_person_id, v_approval.requested_by);
  if p_person_id is not distinct from private.subject_approval_beneficiary(v_approval.id) then
    perform private.refuse('approval_subject_beneficiary', 'The person this approval is for never decides it.');
  end if;
  if exists (select 1 from app.subject_approval_decisions d where d.subject_approval_id = v_approval.id and d.approver_person_id = p_person_id) then
    perform private.refuse('approval_one_step_per_approver', 'You already decided a step of this approval; the next step needs another approver.');
  end if;
  if not private.is_subject_step_approver(v_approval.id, p_person_id) then
    perform private.refuse('approval_not_step_approver', 'You are not an approver of the step this approval is waiting on.');
  end if;
  if not coalesce(p_approved, false) and v_comment is null then
    perform private.refuse('approval_rejection_reason', 'Say why when you reject an approval.');
  end if;

  v_step := private.subject_approval_current_step(v_approval.id);
  insert into app.subject_approval_decisions (subject_approval_id, step_order, approver_person_id, approved, comment, decided_via)
  values (v_approval.id, v_step, p_person_id, coalesce(p_approved, false), v_comment, coalesce(p_via, 'App'))
  returning id into v_decision;

  -- The decided step's requests and reminders leave every Inbox and their links stop working.
  perform private.retire_subject_approval_notices(v_approval.id);
  v_state := private.subject_approval_state(v_approval.id);
  if v_state = 'In Review' then
    perform private.notify_subject_step_approvers(v_approval.id);
  elsif v_approval.requested_by is not null then
    perform private.notify(v_approval.org_id, v_approval.requested_by, 'approval.decided', 'subject_approvals', v_approval.id,
      v_approval.project_id, jsonb_build_object('title', private.subject_approval_title(v_approval.id),
        'decision', case when v_state = 'Approved' then 'approved' else 'rejected' end,
        'actorName', coalesce((select p.full_name from app.people p where p.id = p_person_id), '')));
  end if;
  return v_decision;
end;
$$;

comment on function private.decide_subject_approval_as(uuid, uuid, boolean, text, text) is 'The one decision path of subject approvals (P9): decides the step an approval waits on as the person, through p_via (App or Email link). Refuses an approval not In Review (approval_not_in_review), the requester (sod_approval_requester), the beneficiary (approval_subject_beneficiary), a second step by the same person (approval_one_step_per_approver), anyone the step does not name (approval_not_step_approver) and a rejection without a reason (approval_rejection_reason). Retires the step''s requests and reminders, then asks the next step, or tells the requester the outcome (approval.decided). Step-up never applies: the signed-out path cannot answer it (ADR 0138). Returns the decision id.';
revoke all on function private.decide_subject_approval_as(uuid, uuid, boolean, text, text) from public, anon, authenticated;

create or replace function app.decide_subject_approval(p_subject_approval_id uuid, p_approved boolean, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if not exists (select 1 from app.subject_approvals a
                 where a.id = p_subject_approval_id and a.deleted_at is null
                   and (a.org_id in (select private.my_org_ids()) or private.is_approval_rule_approver(a.approval_rule_id))) then
    raise exception using errcode = '42501', message = 'approval not found';
  end if;
  return private.decide_subject_approval_as(p_subject_approval_id, v_person, p_approved, p_comment, 'App');
end;
$$;

comment on function app.decide_subject_approval(uuid, boolean, text) is 'A signed-in approver decides the step a pass, dock booking or equipment approval waits on (P9), through private.decide_subject_approval_as: a member of the org, or an outside approver an engagement step names. A rejection needs a reason. Returns the decision id.';
revoke all on function app.decide_subject_approval(uuid, boolean, text) from public, anon;
grant execute on function app.decide_subject_approval(uuid, boolean, text) to authenticated, service_role;

-- 13. Cancelling ------------------------------------------------------------------------------------------------------------------

create or replace function private.cancel_subject_approval_row(p_approval_id uuid, p_person_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.begin_trusted_operation('subject_approval');
  update app.subject_approvals set canceled_at = now(), canceled_by = p_person_id, cancel_reason = left(btrim(p_reason), 500)
  where id = p_approval_id and canceled_at is null;
  perform private.end_trusted_operation('subject_approval');
  perform private.retire_subject_approval_notices(p_approval_id);
end;
$$;

comment on function private.cancel_subject_approval_row(uuid, uuid, text) is 'Withdraws a subject approval with its reason and retires its open requests, reminders and links (P9).';
revoke all on function private.cancel_subject_approval_row(uuid, uuid, text) from public, anon, authenticated;

create or replace function private.is_subject_writer(p_approval_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.subject_approvals a
    where a.id = p_approval_id
      and ((a.credential_id is not null and (private.can_on_project(a.project_id, 'credentials.credential.issue')
                                             or private.can_on_project(a.project_id, 'credentials.credential.revoke')))
           or (a.dock_slot_id is not null and private.can_on_project(a.project_id, 'logistics.dock_slot.write'))));
$$;

comment on function private.is_subject_writer(uuid) is 'True when the signed-in person writes the approval''s subject on its project: credentials.credential.issue or credentials.credential.revoke for a pass, logistics.dock_slot.write for a dock slot (P9; 2863 adds R7''s allocation write capability).';
revoke all on function private.is_subject_writer(uuid) from public, anon, authenticated;

create or replace function app.cancel_subject_approval(p_subject_approval_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_approval app.subject_approvals;
  v_state app.approval_state;
begin
  select * into v_approval from app.subject_approvals a
  where a.id = p_subject_approval_id and a.deleted_at is null and a.org_id in (select private.my_org_ids()) for update;
  if v_approval.id is null then
    raise exception using errcode = '42501', message = 'approval not found';
  end if;
  if v_approval.requested_by is distinct from v_person
     and not private.can_write_approval_rule(v_approval.org_id, v_approval.project_id)
     and not private.is_subject_writer(v_approval.id) then
    raise exception using errcode = '42501', message = 'only the requester, a rule writer or the subject''s writer cancels an approval';
  end if;
  v_state := private.subject_approval_state(v_approval.id);
  if v_state <> 'In Review' then
    perform private.refuse('approval_not_in_review', format('This approval is %s; only an approval in review is withdrawn.', v_state));
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    perform private.refuse('approval_cancel_reason', 'Say why you are withdrawing the approval.');
  end if;
  perform private.cancel_subject_approval_row(v_approval.id, v_person, p_reason);
  return v_approval.id;
end;
$$;

comment on function app.cancel_subject_approval(uuid, text) is 'Withdraws a subject approval in review, with a reason (P9): the requester, a rule writer (projects.settings.write or org.approval_policies.write) or the subject''s writer (private.is_subject_writer). A canceled approval no longer gates its pass. Returns the approval id.';
revoke all on function app.cancel_subject_approval(uuid, text) from public, anon;
grant execute on function app.cancel_subject_approval(uuid, text) to authenticated, service_role;

create or replace function private.cancel_approval_with_subject()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval uuid;
  v_reason text;
begin
  if tg_table_name = 'credentials' then
    v_reason := case when new.deleted_at is not null and old.deleted_at is null then 'The pass was deleted.'
                     when new.revoked_at is not null and old.revoked_at is null then 'The pass was revoked.' end;
    select a.id into v_approval from app.subject_approvals a
    where a.credential_id = new.id and a.canceled_at is null and a.deleted_at is null;
  else
    v_reason := case when new.deleted_at is not null and old.deleted_at is null then 'The dock slot was deleted.' end;
    select a.id into v_approval from app.subject_approvals a
    where a.dock_slot_id = new.id and a.canceled_at is null and a.deleted_at is null;
  end if;
  if v_reason is not null and v_approval is not null then
    perform private.cancel_subject_approval_row(v_approval, private.current_person_id(), v_reason);
  end if;
  return null;
end;
$$;

comment on function private.cancel_approval_with_subject() is 'Revoking or deleting a pass, or deleting a dock slot, withdraws its open approval (P9).';
revoke all on function private.cancel_approval_with_subject() from public, anon, authenticated;

create trigger t91_cancel_pass_approval after update of deleted_at, revoked_at on app.credentials
  for each row when ((old.deleted_at is null and new.deleted_at is not null) or (old.revoked_at is null and new.revoked_at is not null))
  execute function private.cancel_approval_with_subject();
create trigger t91_cancel_delivery_approval after update of deleted_at on app.dock_slots
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.cancel_approval_with_subject();

-- 14. Rule transitions -------------------------------------------------------------------------------------------------------------

create or replace function app.transition_approval_rule(
  p_approval_rule_id uuid,
  p_expected app.approval_policy_state,
  p_next app.approval_policy_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rule app.approval_rules;
  v_step record;
begin
  perform private.require_person();
  select * into v_rule from app.approval_rules r where r.id = p_approval_rule_id and r.deleted_at is null for update;
  if v_rule.id is null or not private.can_write_approval_rule(v_rule.org_id, v_rule.project_id) then
    raise exception using errcode = '42501', message = 'projects.settings.write or org.approval_policies.write is required';
  end if;
  if p_next = 'Active' then
    if v_rule.subject = 'Equipment' then
      perform private.refuse('approval_rule_equipment_pending',
        'Equipment rules take effect once equipment requests are allocated from advances; keep this rule as a Draft until then.');
    end if;
    if not exists (select 1 from app.approval_rule_steps s where s.approval_rule_id = v_rule.id and s.deleted_at is null) then
      perform private.refuse('approval_rule_no_steps', format('Add at least one step to %s before activating it.', v_rule.name));
    end if;
    for v_step in
      select s.id, s.name from app.approval_rule_steps s
      where s.approval_rule_id = v_rule.id and s.deleted_at is null and s.approver_engagement_id is not null
      order by s.step_order
    loop
      if not private.approval_step_reachable(v_step.id) then
        perform private.refuse('approval_step_no_approver',
          format('Nobody the step %s names has an XOS account to receive approval emails. Invite them to Gateway first, or name another approver.', v_step.name));
      end if;
    end loop;
  end if;
  return private.transition_lifecycle('approval_rule', 'app.approval_rules', 'rule_state',
    'app.approval_rule_state_transitions', 'approval_rule_id', p_approval_rule_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_approval_rule(uuid, app.approval_policy_state, app.approval_policy_state, text) is 'Activates or retires an approval rule with compare-and-set (projects.settings.write on its project or org.approval_policies.write, P9). Activation needs at least one step (approval_rule_no_steps), every engagement step must name someone with an XOS account (approval_step_no_approver), and Equipment rules stay Drafts until equipment requests are gated (approval_rule_equipment_pending; 2863 lifts it). A second Active rule of the same project, subject and filter is refused by approval_rules_one_active. Returns the ledger entry id.';
revoke all on function app.transition_approval_rule(uuid, app.approval_policy_state, app.approval_policy_state, text) from public, anon;
grant execute on function app.transition_approval_rule(uuid, app.approval_policy_state, app.approval_policy_state, text) to authenticated, service_role;

-- 15. The access-scan gate (from 0352) ------------------------------------------------------------------------------------------------

create or replace function private.decide_access_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.scanned_at := now();
  new.result := case when exists (
    select 1 from app.credentials c
    join app.access_grid g on g.credential_category_id = c.credential_category_id and g.deleted_at is null
    where c.id = new.credential_id and c.revoked_at is null and c.deleted_at is null
      and c.valid_from <= now() and (c.valid_to is null or c.valid_to > now())
      and g.zone_id = new.zone_id and g.window_starts_at <= now() and g.window_ends_at > now()
  ) and not exists (
    -- P9: a pass whose approval is In Review or Rejected does not open a door. A canceled approval does not gate.
    select 1 from app.subject_approvals a
    where a.credential_id = new.credential_id and a.deleted_at is null and a.canceled_at is null
      and private.subject_approval_state(a.id) <> 'Approved'
  ) then 'Granted'::app.scan_result else 'Denied'::app.scan_result end;
  return new;
end;
$$;
comment on function private.decide_access_scan() is 'Decides an access scan from the credential''s validity and revocation and the access grid at the database time, and Denies a pass whose approval rule has not approved it yet (P9: an open approval In Review or Rejected; a canceled one does not gate).';
revoke all on function private.decide_access_scan() from public, anon, authenticated;

-- 16. Retention, audit and Trash ----------------------------------------------------------------------------------------------------

call private.install_default_retention('app.approval_rules');
call private.install_default_retention('app.approval_rule_state_transitions');
call private.install_default_retention('app.approval_rule_steps');
call private.install_default_retention('app.subject_approvals');
call private.install_default_retention('app.subject_approval_decisions');
call private.install_audit_trail('app.approval_rules');
call private.install_audit_trail('app.approval_rule_steps');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('approval_rules', 'A removed approval rule is a settings change; the project adds the rule again in its settings.'),
  ('approval_rule_steps', 'Steps change only while their rule is a Draft; a removed step is added again in the rule editor.'),
  ('subject_approvals', 'An approval is withdrawn by Cancel, with its reason, and is never restored.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();
