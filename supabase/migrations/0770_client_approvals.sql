-- 0770_client_approvals.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 8 for A27 (Section 4.4.4 Client: approvals, reviews and
-- change orders). A client never touches the org's budget; the org asks its Client party to approve something and
-- the client answers once:
--   * app.client_approval_requests: one request per item shared with a Client engagement (a change order or a
--     record), with the client's decision, who decided and when; decisions are final
--   * app.request_client_approval (org) and app.decide_client_approval (client)
--   * api_external.client_approvals, api_external.change_orders and api_external.change_order_lines: requests of the
--     caller's Client engagements and the change orders they share, NULL-aware, without budget coding
-- The org still approves a change order internally under spend authority (A15's app.approve_change_order); the client's
-- decision is the client side of that change. The shared schedule is api_external.records (0750) and run of show is
-- api_external.run_of_show (0760); shared reports have no source yet.

create type app.client_approval_subject as enum ('Change Order', 'Record');
comment on type app.client_approval_subject is 'What a client approval request asks the client to approve.';

create table app.client_approval_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  subject_kind app.client_approval_subject not null,
  change_order_id uuid references app.change_orders (id),
  record_id uuid references app.records (id),
  message text,
  requested_by uuid references app.people (id),
  decision app.approval_decision,
  response text,
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  deleted_at timestamptz,
  constraint client_approval_requests_subject check (
    (subject_kind = 'Change Order' and change_order_id is not null and record_id is null)
    or (subject_kind = 'Record' and record_id is not null and change_order_id is null)),
  constraint client_approval_requests_decision check ((decision is null) = (decided_at is null) and (decision is null) = (decided_by is null)),
  constraint client_approval_requests_message_length check (message is null or char_length(btrim(message)) between 1 and 2000),
  constraint client_approval_requests_response_length check (response is null or char_length(btrim(response)) between 1 and 2000)
);

create index client_approval_requests_engagement_id_idx on app.client_approval_requests (engagement_id);
create index client_approval_requests_change_order_id_idx on app.client_approval_requests (change_order_id);
create index client_approval_requests_record_id_idx on app.client_approval_requests (record_id);
create index client_approval_requests_requested_by_idx on app.client_approval_requests (requested_by);
create index client_approval_requests_decided_by_idx on app.client_approval_requests (decided_by);
create unique index client_approval_requests_open_key on app.client_approval_requests (engagement_id, coalesce(change_order_id, record_id))
  where decision is null and deleted_at is null;

call private.install_domain_table('app.client_approval_requests', 'app.engagements', 'engagement_id',
  array['app.change_orders', 'change_order_id', 'app.records', 'record_id']);
call private.describe('app.client_approval_requests', 'Items the org asks its Client party to approve (Section 4.4.4 Client): a change order or a record of the engagement''s project. The client decides once; the decision is never changed. One open request per item and engagement.', array[
  'engagement_id', 'Client engagement asked to approve.',
  'subject_kind', 'Change Order or Record.',
  'change_order_id', 'Change order of the same project, for a Change Order request.',
  'record_id', 'Record of the same project, for a Record request.',
  'message', 'What the org asks, shown to the client.',
  'requested_by', 'Org member who asked, set from the session.',
  'decision', 'Approved or Rejected; NULL while open.',
  'response', 'The client''s comment with the decision, shown to the org.',
  'decided_by', 'Client person who decided, set from the session.',
  'decided_at', 'When decided, set by the database.'
]);

insert into private.domain_event_types (code, subject, description) values
  ('client_approval.requested', 'client_approval_requests', 'The org asked its Client party to approve a change order or record.'),
  ('client_approval.decided', 'client_approval_requests', 'A Client party approved or rejected an item the org shared.');

create trigger t90_emit_client_approval_requested after insert on app.client_approval_requests
  for each row execute function private.emit_row_event('client_approval.requested', '-', 'engagement_id', 'subject_kind');
create trigger t90_emit_client_approval_decided after update of decision on app.client_approval_requests
  for each row when (old.decision is null and new.decision is not null)
  execute function private.emit_subject_event('client_approval.decided', 'client_approval_requests', 'id', 'decision');

create or replace function private.guard_client_approval_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_project uuid;
begin
  if tg_op = 'UPDATE' then
    if new.engagement_id <> old.engagement_id or new.subject_kind <> old.subject_kind
       or new.change_order_id is distinct from old.change_order_id or new.record_id is distinct from old.record_id
       or new.message is distinct from old.message or new.requested_by is distinct from old.requested_by then
      perform private.refuse('client_approval_immutable', 'A request keeps what it asks and who it asks.');
    end if;
    if old.decision is not null and (new.decision is distinct from old.decision or new.response is distinct from old.response
       or new.decided_at is distinct from old.decided_at or new.decided_by is distinct from old.decided_by) then
      perform private.refuse('client_approval_decided', 'A client decision is final.');
    end if;
    return new;
  end if;
  select e.* into v_engagement from app.engagements e where e.id = new.engagement_id;
  if v_engagement.role_type <> 'Client' then
    perform private.refuse('client_approval_client_only', 'Approval requests go to Client engagements.');
  end if;
  v_project := coalesce((select c.project_id from app.change_orders c where c.id = new.change_order_id),
                        (select r.project_id from app.records r where r.id = new.record_id));
  if v_project is distinct from v_engagement.project_id then
    perform private.refuse('client_approval_project_mismatch', 'The item belongs to the engagement''s project.');
  end if;
  new.requested_by := private.current_person_id();
  new.decision := null;
  new.response := null;
  new.decided_by := null;
  new.decided_at := null;
  return new;
end;
$$;

comment on function private.guard_client_approval_request() is 'Client approval requests: only to Client engagements, only items of the engagement''s project, the asker from the session, born open, and never edited after the client decides.';

create trigger t40_guard_client_approval_request before insert or update on app.client_approval_requests
  for each row execute function private.guard_client_approval_request();

call private.install_policies('app.client_approval_requests',
  $$engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))$$,
  $$engagement_id in (select private.internal_engagement_ids('opportunities.engagement.write'))$$);
revoke insert, update on app.client_approval_requests from authenticated;

-- RPCs ---------------------------------------------------------------------------------------------------------------------

create or replace function app.request_client_approval(p_engagement_id uuid, p_change_order_id uuid, p_record_id uuid, p_message text)
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
  if v_project is null or not private.can_on_project(v_project, 'opportunities.engagement.write')
     or (p_change_order_id is not null and not private.can_on_project(v_project, 'finance.change_order.read')) then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  insert into app.client_approval_requests (engagement_id, subject_kind, change_order_id, record_id, message)
  values (p_engagement_id, case when p_change_order_id is not null then 'Change Order' else 'Record' end::app.client_approval_subject,
    p_change_order_id, p_record_id, nullif(btrim(p_message), ''))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.request_client_approval(uuid, uuid, uuid, text) is 'The org asks its Client party to approve a change order (needs finance.change_order.read too) or a record of the engagement''s project (opportunities.engagement.write). Returns the request id.';

create or replace function private.client_side_open(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    left join app.counterparties c on c.id = e.counterparty_id
    where e.id = p_engagement_id and e.deleted_at is null and e.role_type = 'Client'
      and (e.person_id = private.current_person_id()
        or c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational'));
$$;

comment on function private.client_side_open(uuid) is 'Section 8.7: true when the signed-in person answers for the Client engagement (the engaged contact or the client account''s Owner or Admin) while its operational area is open.';

create or replace function app.decide_client_approval(p_request_id uuid, p_decision app.approval_decision, p_response text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request app.client_approval_requests;
begin
  perform private.require_person();
  select r.* into v_request from app.client_approval_requests r where r.id = p_request_id and r.deleted_at is null;
  if v_request.id is null or not private.client_side_open(v_request.engagement_id) then
    raise exception using errcode = '42501', message = 'only the client side decides this request';
  end if;
  if v_request.decision is not null then
    perform private.refuse('client_approval_decided', 'A client decision is final.');
  end if;
  if p_decision = 'Rejected' and nullif(btrim(p_response), '') is null then
    perform private.refuse('client_approval_reason', 'Say why when rejecting, so the org can act on it.');
  end if;
  update app.client_approval_requests
  set decision = p_decision, response = nullif(btrim(p_response), ''), decided_by = private.current_person_id(), decided_at = now()
  where id = p_request_id;
end;
$$;

comment on function app.decide_client_approval(uuid, app.approval_decision, text) is 'The Client party approves or rejects a request once while the operational area is open; a rejection says why.';

-- Projections ------------------------------------------------------------------------------------------------------------------

create view api_external.client_approvals as
select r.id, r.engagement_id, e.project_id, p.name as project_name, r.subject_kind, r.change_order_id, r.record_id, r.message,
  r.created_at as requested_at, r.decision, r.response, r.decided_at
from app.client_approval_requests r
join app.engagements e on e.id = r.engagement_id
join app.projects p on p.id = e.project_id
where r.deleted_at is null and private.client_side_open(r.engagement_id);

call private.describe('api_external.client_approvals', 'Approval requests to the caller''s Client engagements, open and decided, while the operational area is open. Who asked on the org side never appears.', array[
  'id', 'Request.', 'engagement_id', 'Client engagement.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'subject_kind', 'Change Order or Record.', 'change_order_id', 'Change order to approve.', 'record_id', 'Record to approve.',
  'message', 'What the org asks.', 'requested_at', 'When asked.', 'decision', 'Approved or Rejected; NULL while open.',
  'response', 'The client''s comment.', 'decided_at', 'When decided.']);

create view api_external.change_orders as
select c.id, c.project_id, pj.project_key || '-CO-' || c.change_order_number::text as change_order_key, c.title, c.reason as change_purpose,
  c.change_order_state,
  (select case when count(l.id) = 0 or count(l.id) filter (where l.unit_price_minor is null) > 0 then null
               else sum(private.extended_minor(l.quantity, l.unit_price_minor))::bigint end
   from app.change_order_lines l where l.change_order_id = c.id and l.deleted_at is null) as total_minor,
  (select b.currency_code from app.budgets b where b.id = c.budget_id) as currency_code
from app.change_orders c
join app.projects pj on pj.id = c.project_id
where c.deleted_at is null and c.id in (select x.change_order_id from api_external.client_approvals x where x.change_order_id is not null);

call private.describe('api_external.change_orders', 'Change orders the org shared with the caller for approval. The total is NULL while any line is unpriced; budget coding never appears.', array[
  'id', 'Change order.', 'project_id', 'Project.', 'change_order_key', 'Display key.', 'title', 'Title.', 'change_purpose', 'Why the change is needed.',
  'change_order_state', 'Internal state: Proposed, Priced, Approved, Rejected or Canceled.', 'total_minor', 'Total in minor units; NULL while unpriced.',
  'currency_code', 'Currency.']);

create view api_external.change_order_lines as
select l.id, l.change_order_id, l.description, l.urid, l.quantity, l.unit_price_minor, l.is_no_cost,
  private.extended_minor(l.quantity, l.unit_price_minor) as amount_minor
from app.change_order_lines l
where l.deleted_at is null and l.change_order_id in (select x.id from api_external.change_orders x);

call private.describe('api_external.change_order_lines', 'Lines of change orders shared with the caller, without budget lines.', array[
  'id', 'Line.', 'change_order_id', 'Change order.', 'description', 'What changes.', 'urid', 'Discipline or category.',
  'quantity', 'Quantity.', 'unit_price_minor', 'Unit price; NULL is unpriced.', 'is_no_cost', 'True when declared no-cost.',
  'amount_minor', 'Quantity times unit price; NULL when unpriced.']);

-- Retention, audit and privileges -----------------------------------------------------------------------------------------------

call private.install_default_retention('app.client_approval_requests');
call private.install_audit_trail('app.client_approval_requests');

revoke all on function private.guard_client_approval_request() from public, anon, authenticated;
revoke all on function private.client_side_open(uuid) from public, anon;
grant execute on function private.client_side_open(uuid) to authenticated, service_role;
revoke all on function app.request_client_approval(uuid, uuid, uuid, text) from public, anon;
revoke all on function app.decide_client_approval(uuid, app.approval_decision, text) from public, anon;
grant execute on function app.request_client_approval(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function app.decide_client_approval(uuid, app.approval_decision, text) to authenticated, service_role;

revoke all on api_external.client_approvals, api_external.change_orders, api_external.change_order_lines from public, anon;
grant select on api_external.client_approvals, api_external.change_orders, api_external.change_order_lines to authenticated, service_role;
