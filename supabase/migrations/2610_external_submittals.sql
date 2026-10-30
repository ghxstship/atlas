-- 2610_external_submittals.sql
-- R2 Advancing read gaps (RRR-180, ADR 0100 to 0104). The vendor reads and answers its own submittals in Gateway
-- (Section 4.4.4 Vendor: submittals), where the Submittals tab listed shared records because app.submittals (0492)
-- had no external view.
--
--   * private.vendor_side_open(project, vendor): the vendor is live, its counterparty holds a live Vendor engagement
--     on the project, and the caller is the account's Owner, Admin or Member with the operational area open (0766).
--     Once R4 merges, private.counterparty_area_open goes through private.engagement_area_open's assignment check,
--     so an unassigned Account Member sees none (decision 6) with no change here.
--   * api_external.submittals: the account's submittals on the project, except Canceled ones, with the reason of the
--     latest return while Returned and the time of the latest submission. Who decided never appears.
--   * app.submit_engaged_submittal: the vendor submits a Proposed submittal or resubmits a Returned one with a note,
--     through the lifecycle rules of 0492. A resubmission raises the revision, as app.transition_submittal does.
-- The note is the transition's reason, so it keeps the ledger's 500-character limit (0321 install_lifecycle).
-- submittal.state_changed already emits from the ledger (0492); there is no new notification kind.

-- Helper (column values in, ADR 0016 item 14) ---------------------------------------------------------------------------

create or replace function private.vendor_side_open(p_project_id uuid, p_vendor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.vendors v
    where v.id = p_vendor_id and v.deleted_at is null
      and exists (
        select 1 from app.engagements e
        where e.project_id = p_project_id and e.counterparty_id = v.counterparty_id and e.role_type = 'Vendor'
          and e.deleted_at is null and e.engagement_state not in ('Complete', 'Canceled'))
      and private.counterparty_area_open(p_project_id, v.counterparty_id, 'operational',
        array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[]));
$$;

comment on function private.vendor_side_open(uuid, uuid) is 'Section 8.7 (R2): true when the signed-in person answers for the vendor on the project: the vendor is live, its counterparty holds a live Vendor engagement there, and the caller is its account''s Owner, Admin or Member with the operational area open (private.counterparty_area_open). Takes column values.';

revoke all on function private.vendor_side_open(uuid, uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.vendor_side_open(uuid, uuid) to authenticated, service_role;

-- View -------------------------------------------------------------------------------------------------------------------

create view api_external.submittals as
select s.id, s.project_id, p.name as project_name, c.organization_id as account_id, s.submittal_number, s.submittal_kind, s.title,
  s.spec_reference, s.due_on, s.revision, s.submittal_state, s.decided_at, s.purchase_order_id,
  case when s.submittal_state = 'Returned' then r.reason end as return_reason,
  u.created_at as submitted_at
from app.submittals s
join app.projects p on p.id = s.project_id
join app.vendors v on v.id = s.vendor_id
join app.counterparties c on c.id = v.counterparty_id
left join lateral (
  select t.reason from app.submittal_state_transitions t
  where t.submittal_id = s.id and t.to_state = 'Returned'
  order by t.created_at desc, t.id desc limit 1
) r on true
left join lateral (
  select t.created_at from app.submittal_state_transitions t
  where t.submittal_id = s.id and t.to_state = 'Submitted'
  order by t.created_at desc, t.id desc limit 1
) u on true
where s.deleted_at is null and s.submittal_state <> 'Canceled' and private.vendor_side_open(s.project_id, s.vendor_id);

call private.describe('api_external.submittals', 'Submittals the org asked of the caller''s vendor account on projects where it holds a live Vendor engagement in the operational area (Section 4.4.4 Vendor), except canceled ones. Who approved or returned a submittal never appears.', array[
  'id', 'Submittal.', 'project_id', 'Project.', 'project_name', 'Project name.', 'account_id', 'Vendor account the submittal is asked of.',
  'submittal_number', 'Number within the project.', 'submittal_kind', 'What the submittal carries.', 'title', 'What is submitted.',
  'spec_reference', 'Specification section or drawing reference.', 'due_on', 'When it is due for review.',
  'revision', 'Revision number: 0 for the first submission, raised on each resubmission.', 'submittal_state', 'Proposed, Submitted, Approved or Returned.',
  'decided_at', 'When it was last approved or returned.', 'purchase_order_id', 'Purchase order it supports, when there is one.',
  'return_reason', 'What the org asked to change, while Returned.', 'submitted_at', 'When the vendor last submitted it.']);

revoke all on api_external.submittals from public, anon;
grant select on api_external.submittals to authenticated, service_role;

-- The vendor submits ------------------------------------------------------------------------------------------------------

create or replace function app.submit_engaged_submittal(p_submittal_id uuid, p_expected app.review_state, p_note text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.submittals;
  v_entry uuid;
begin
  perform private.require_person();
  select * into v_row from app.submittals s where s.id = p_submittal_id and s.deleted_at is null for update;
  if v_row.id is null or not private.vendor_side_open(v_row.project_id, v_row.vendor_id) then
    raise exception using errcode = '42501', message = 'only the vendor answers for this submittal';
  end if;
  if p_expected is null or p_expected not in ('Proposed', 'Returned') then
    perform private.refuse('submittal_response', 'A vendor submits a proposed submittal or resubmits a returned one.');
  end if;
  if char_length(btrim(coalesce(p_note, ''))) not between 1 and 500 then
    perform private.refuse('submittal_note_length', 'Say what you are submitting in 1 to 500 characters.');
  end if;
  v_entry := private.transition_lifecycle('submittal', 'app.submittals', 'submittal_state', 'app.submittal_state_transitions',
    'submittal_id', p_submittal_id, p_expected::text, 'Submitted', btrim(p_note));
  if p_expected = 'Returned' then
    perform private.begin_trusted_operation('submittal_review');
    update app.submittals set revision = revision + 1 where id = p_submittal_id;
    perform private.end_trusted_operation('submittal_review');
  end if;
  return v_entry;
end;
$$;

comment on function app.submit_engaged_submittal(uuid, app.review_state, text) is 'The vendor''s account (Owner, Admin or Member, private.vendor_side_open) submits a Proposed submittal or resubmits a Returned one with a note of 1 to 500 characters, compare-and-set on the expected state (R2). A resubmission raises the revision. The note is the transition''s reason; submittal.state_changed emits from the ledger. Returns the transition id.';

revoke all on function app.submit_engaged_submittal(uuid, app.review_state, text) from public, anon;
grant execute on function app.submit_engaged_submittal(uuid, app.review_state, text) to authenticated, service_role;
