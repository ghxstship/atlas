-- 0771_engagement_deliverables.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 9 for A27 (Section 4.4.4 Contractor: deliverables or
-- milestones, then acceptance at close-out):
--   * app.engagement_deliverables: a record of the engagement's project (a document, deadline, milestone, report and
--     so on) that the party owes, with the Deliverable lifecycle (Open, Submitted, Accepted, Returned) and its ledger
--   * app.add_engagement_deliverable and app.decide_deliverable (org), app.submit_deliverable (party)
--   * api_external.deliverables for the party
-- Staff training and briefing acknowledgments are onboarding items of kind Training and Acknowledgment
-- (api_external.onboarding_items, submitted with app.submit_onboarding_item); staff positions are their shifts with role
-- and scope node (api_external.shifts).

create type app.deliverable_state as enum ('Open', 'Submitted', 'Accepted', 'Returned');
comment on type app.deliverable_state is 'Deliverable lifecycle: owed (Open), handed in (Submitted), Accepted by the org, or Returned with a reason to hand in again.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('deliverable', 'Open', 'Submitted'),
  ('deliverable', 'Submitted', 'Accepted'),
  ('deliverable', 'Submitted', 'Returned'),
  ('deliverable', 'Returned', 'Submitted');

insert into private.domain_event_types (code, subject, description) values
  ('deliverable.state_changed', 'engagement_deliverables', 'A deliverable was submitted, accepted or returned.');

create table app.engagement_deliverables (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  record_id uuid not null references app.records (id),
  document_id uuid references app.documents (id),
  submission_message text,
  submitted_by uuid references app.people (id),
  submitted_at timestamptz,
  return_reason text,
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  deliverable_state app.deliverable_state not null default 'Open',
  deleted_at timestamptz,
  constraint engagement_deliverables_message_length check (submission_message is null or char_length(btrim(submission_message)) between 1 and 4000),
  constraint engagement_deliverables_return_length check (return_reason is null or char_length(btrim(return_reason)) between 1 and 2000)
);

create index engagement_deliverables_engagement_id_idx on app.engagement_deliverables (engagement_id);
create index engagement_deliverables_record_id_idx on app.engagement_deliverables (record_id);
create index engagement_deliverables_document_id_idx on app.engagement_deliverables (document_id);
create index engagement_deliverables_submitted_by_idx on app.engagement_deliverables (submitted_by);
create index engagement_deliverables_decided_by_idx on app.engagement_deliverables (decided_by);
create unique index engagement_deliverables_key on app.engagement_deliverables (engagement_id, record_id) where deleted_at is null;

call private.install_domain_table('app.engagement_deliverables', 'app.engagements', 'engagement_id',
  array['app.records', 'record_id', 'app.documents', 'document_id']);
call private.describe('app.engagement_deliverables', 'What an engaged party owes on an engagement (Section 4.4.4 Contractor: deliverables or milestones): a record of the same project, handed in with a document and accepted or returned by the org.', array[
  'engagement_id', 'Engagement that owes the deliverable.',
  'record_id', 'Record of the engagement''s project that names what is owed and when.',
  'document_id', 'Document of the org handed in with the latest submission.',
  'submission_message', 'The party''s message with the latest submission.',
  'submitted_by', 'Person who last submitted, set from the session.',
  'submitted_at', 'When last submitted.',
  'return_reason', 'Why the org returned it, shown to the party; cleared on the next submission.',
  'decided_by', 'Org member who last accepted or returned it, set from the session; never the party.',
  'decided_at', 'When last accepted or returned.',
  'deliverable_state', 'Deliverable state. Changes only through the deliverable RPCs.'
]);

call private.install_lifecycle('app.engagement_deliverables', 'engagement_deliverable_id', 'deliverable_state', 'deliverable', 'Open',
  $$engagement_deliverable_id in (select d.id from app.engagement_deliverables d where d.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read')))$$);

create trigger t90_emit_deliverable_state after insert on app.deliverable_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('deliverable.state_changed', 'engagement_deliverables', 'engagement_deliverable_id', 'from_state', 'to_state');

create or replace function private.guard_engagement_deliverable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.engagement_id <> old.engagement_id or new.record_id <> old.record_id) then
    perform private.refuse('deliverable_immutable', 'A deliverable keeps its engagement and record.');
  end if;
  if tg_op = 'INSERT' and (select r.project_id from app.records r where r.id = new.record_id)
     is distinct from (select e.project_id from app.engagements e where e.id = new.engagement_id) then
    perform private.refuse('deliverable_project_mismatch', 'A deliverable is a record of the engagement''s project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_deliverable() is 'Deliverables are records of the engagement''s project and keep their engagement and record.';

create trigger t40_guard_engagement_deliverable before insert or update on app.engagement_deliverables
  for each row execute function private.guard_engagement_deliverable();

call private.install_policies('app.engagement_deliverables',
  $$engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))$$);
revoke insert, update on app.engagement_deliverables from authenticated;

-- RPCs ---------------------------------------------------------------------------------------------------------------------

create or replace function app.add_engagement_deliverable(p_engagement_id uuid, p_record_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select e.project_id from app.engagements e where e.id = p_engagement_id and e.deleted_at is null);
  v_id uuid;
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  insert into app.engagement_deliverables (engagement_id, record_id) values (p_engagement_id, p_record_id) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.add_engagement_deliverable(uuid, uuid) is 'The org names a record of the engagement''s project as something the party owes (opportunities.engagement.write). Returns the deliverable id.';

create or replace function private.deliverable_party_open(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    left join app.counterparties c on c.id = e.counterparty_id
    where e.id = p_engagement_id and e.deleted_at is null
      and (e.person_id = private.current_person_id()
        or c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[])))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational'));
$$;

comment on function private.deliverable_party_open(uuid) is 'Section 8.7: true when the signed-in person hands in work for the engagement (the engaged person or a member of the engaged account) while its operational area is open.';

create or replace function app.submit_deliverable(p_deliverable_id uuid, p_document_id uuid, p_message text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.engagement_deliverables;
  v_entry uuid;
begin
  perform private.require_person();
  select d.* into v_row from app.engagement_deliverables d where d.id = p_deliverable_id and d.deleted_at is null;
  if v_row.id is null or not private.deliverable_party_open(v_row.engagement_id) then
    raise exception using errcode = '42501', message = 'only the engaged party hands in this deliverable';
  end if;
  if p_document_id is not null and (select x.org_id from app.documents x where x.id = p_document_id) is distinct from v_row.org_id then
    perform private.refuse('cross_org_reference', 'engagement_deliverables.document_id points to a row of another org.');
  end if;
  v_entry := private.transition_lifecycle('deliverable', 'app.engagement_deliverables', 'deliverable_state', 'app.deliverable_state_transitions',
    'engagement_deliverable_id', p_deliverable_id, v_row.deliverable_state::text, 'Submitted', 'Handed in by the party.');
  update app.engagement_deliverables
  set document_id = coalesce(p_document_id, document_id), submission_message = nullif(btrim(p_message), ''),
      submitted_by = private.current_person_id(), submitted_at = now(), return_reason = null
  where id = p_deliverable_id;
  return v_entry;
end;
$$;

comment on function app.submit_deliverable(uuid, uuid, text) is 'The engaged party hands in an Open or Returned deliverable with an optional document of the org (for example one registered through onboarding uploads) and a message, while the operational area is open. Returns the ledger entry id.';

create or replace function app.decide_deliverable(p_deliverable_id uuid, p_decision app.approval_decision, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.engagement_deliverables;
  v_project uuid;
  v_next text := case p_decision when 'Approved' then 'Accepted' else 'Returned' end;
  v_entry uuid;
begin
  perform private.require_person();
  select d.* into v_row from app.engagement_deliverables d where d.id = p_deliverable_id and d.deleted_at is null;
  select e.project_id into v_project from app.engagements e where e.id = v_row.engagement_id;
  if v_row.id is null or not private.can_on_project(v_project, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  if private.deliverable_party_open(v_row.engagement_id) or v_row.submitted_by = private.current_person_id() then
    perform private.refuse('sod_deliverable_self', 'The party who handed in work cannot accept it.');
  end if;
  if p_decision = 'Rejected' and nullif(btrim(p_reason), '') is null then
    perform private.refuse('deliverable_return_reason', 'Say why the work is returned, so the party can fix it.');
  end if;
  v_entry := private.transition_lifecycle('deliverable', 'app.engagement_deliverables', 'deliverable_state', 'app.deliverable_state_transitions',
    'engagement_deliverable_id', p_deliverable_id, 'Submitted', v_next, coalesce(nullif(btrim(p_reason), ''), 'Accepted.'));
  update app.engagement_deliverables
  set decided_by = private.current_person_id(), decided_at = now(),
      return_reason = case when p_decision = 'Rejected' then btrim(p_reason) end
  where id = p_deliverable_id;
  return v_entry;
end;
$$;

comment on function app.decide_deliverable(uuid, app.approval_decision, text) is 'The org accepts (Approved) or returns (Rejected, with a reason) a Submitted deliverable (opportunities.engagement.write), never the party who handed it in. Returns the ledger entry id.';

-- Projection -------------------------------------------------------------------------------------------------------------------

create view api_external.deliverables as
select d.id, d.engagement_id, d.record_id, r.record_kind, r.title, r.due_at, d.deliverable_state, d.document_id, d.submission_message,
  d.submitted_at, d.decided_at, d.return_reason
from app.engagement_deliverables d
join app.records r on r.id = d.record_id and r.deleted_at is null
where d.deleted_at is null and private.deliverable_party_open(d.engagement_id);

call private.describe('api_external.deliverables', 'What the caller''s engagements owe (Section 4.4.4 Contractor), with their state, the latest submission and any reason the org returned it, while the operational area is open. Who decided never appears.', array[
  'id', 'Deliverable.', 'engagement_id', 'Engagement.', 'record_id', 'Record naming what is owed.', 'record_kind', 'Record kind.',
  'title', 'What is owed.', 'due_at', 'When it is due.', 'deliverable_state', 'Open, Submitted, Accepted or Returned.',
  'document_id', 'Document handed in.', 'submission_message', 'The party''s message.', 'submitted_at', 'When handed in.',
  'decided_at', 'When accepted or returned.', 'return_reason', 'Why it was returned.']);

-- Retention, audit and privileges --------------------------------------------------------------------------------------------------

call private.install_default_retention('app.engagement_deliverables');
call private.install_default_retention('app.deliverable_state_transitions');
call private.install_audit_trail('app.engagement_deliverables');

revoke all on function private.guard_engagement_deliverable() from public, anon, authenticated;
revoke all on function private.deliverable_party_open(uuid) from public, anon;
grant execute on function private.deliverable_party_open(uuid) to authenticated, service_role;
revoke all on function app.add_engagement_deliverable(uuid, uuid) from public, anon;
revoke all on function app.submit_deliverable(uuid, uuid, text) from public, anon;
revoke all on function app.decide_deliverable(uuid, app.approval_decision, text) from public, anon;
grant execute on function app.add_engagement_deliverable(uuid, uuid) to authenticated, service_role;
grant execute on function app.submit_deliverable(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.decide_deliverable(uuid, app.approval_decision, text) to authenticated, service_role;

revoke all on api_external.deliverables from public, anon;
grant select on api_external.deliverables to authenticated, service_role;
