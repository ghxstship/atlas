-- 6505_vendor_intake_requests.sql
-- B2 (RRR-226, ADR 0141; parity gap G-226, the request side). What a vendor or contractor sends through a reusable
-- intake link (6504), and what the team does with it.
--   * app.vendor_intake_requests: one per requester and link while Pending, sent by the signed-in person through
--     app.submit_vendor_intake with the link's token and grant. It points at the requester's own tax form, written first
--     by the existing path (app.submit_tax_form 0730, app.set_tax_form_address 1124), and payout reference, written
--     first by app.add_intake_payout_reference; it never holds a tax identifier or a bank number. A payout account is
--     a provider reference in provider Accounting System only, since XOS never holds funds and Stripe Connect is
--     deferred, and a bank-shaped value is refused: 0730's column grants still let a signed-in payee insert or change a
--     reference directly, and that path cannot refuse, so a reference is checked again at submit and at approval. The
--     typed signature applies only to
--     the link's pinned agreement version. An optional first invoice draft waits for the engagement's money area.
--   * Only members of the org with opportunities.engagement.read on the project read the table. The requester reads
--     their own requests through api_external.my_vendor_intake_requests, a column-allowlisted, self-filtered view
--     (Section 8.7).
--   * Submitting notifies, through kind vendor_intake.submitted (In App and Email), every member holding
--     opportunities.engagement.write on the project.
--   * app.decide_vendor_intake approves into an Onboarding engagement on the link's terms, reusing the org's live
--     counterparty for the account or adding one with the link's counterparty type (as 1624 does), so the plan limit,
--     the XOS-ENG rules and 0730's onboarding items apply as usual. Tax Form and Payout Details items the request
--     carries are marked submitted; nobody's verification is written, so a reviewer still verifies under the
--     onboarding SoD. The agreement goes Proposed to Sent to Signed with the intake ledger reason, or stays Sent for the
--     party to sign in Gateway when the document has a newer version than the one signed. sod_vendor_intake_self keeps
--     the requester and anyone in the vendor account from deciding.
--   * app.submit_intake_invoice submits the stored draft once through app.submit_engagement_invoice, so the Section
--     8.7 money area rule decides when it can go.
--   * A declined or withdrawn request takes its tax form and payout reference with it, when no other live request
--     names them and the payee has no engagement in the org (Restricted data of someone the org never engaged).
--     An intake abandoned before it was sent cannot be told apart this way; ADR 0141 records that limit.
-- Alternatives considered (ADR 0141): app.applications (0775) needs an opportunity board posting, and
-- app.join_requests (0861) joins a person to the org as a member, which an outside vendor never is.

insert into private.domain_event_types (code, subject, description) values
  ('vendor_intake.submitted', 'vendor_intake_requests', 'A vendor or contractor sent a request through a reusable intake link.'),
  ('vendor_intake.withdrawn', 'vendor_intake_requests', 'A requester withdrew their intake request.'),
  ('vendor_intake.decided', 'vendor_intake_requests', 'An intake request was approved into an engagement or declined.'),
  ('vendor_intake.signed', 'engagement_documents', 'An engagement agreement was signed at intake, for the version the requester signed.')
on conflict (code) do nothing;

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_vendor_intake_self', 'Vendor intake requests', 'The person who sent an intake request, or anyone with a role in the vendor account it names, cannot approve or decline it.')
on conflict (code) do nothing;

create table app.vendor_intake_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_intake_link_id uuid not null references app.vendor_intake_links (id),
  project_id uuid not null references app.projects (id),
  requested_by uuid not null references app.people (id),
  account_id uuid references app.organizations (id),
  tax_form_id uuid references app.tax_forms (id),
  payout_account_id uuid references app.payout_accounts (id),
  signer_name text,
  signed_at timestamptz,
  signed_version_id uuid references app.document_versions (id),
  invoice_draft jsonb,
  request_state app.join_request_state not null default 'Pending',
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  decision_reason text,
  engagement_id uuid references app.engagements (id),
  invoice_id uuid references app.invoices (id),
  constraint vendor_intake_requests_signature check ((signer_name is null) = (signed_at is null)
    and (signed_at is null) = (signed_version_id is null)
    and (signer_name is null or char_length(btrim(signer_name)) between 1 and 200)),
  constraint vendor_intake_requests_invoice_draft check (invoice_draft is null or jsonb_typeof(invoice_draft) = 'object'),
  constraint vendor_intake_requests_decided check ((request_state in ('Approved', 'Declined')) = (decided_at is not null)
    and (decided_at is null) = (decided_by is null)),
  constraint vendor_intake_requests_reason_length check (decision_reason is null or char_length(btrim(decision_reason)) between 1 and 1000),
  constraint vendor_intake_requests_engagement check (engagement_id is null or request_state = 'Approved'),
  constraint vendor_intake_requests_invoice check (invoice_id is null or engagement_id is not null)
);

create index vendor_intake_requests_link_idx on app.vendor_intake_requests (vendor_intake_link_id);
create index vendor_intake_requests_project_idx on app.vendor_intake_requests (project_id, request_state);
create index vendor_intake_requests_account_idx on app.vendor_intake_requests (account_id);
create index vendor_intake_requests_tax_form_idx on app.vendor_intake_requests (tax_form_id);
create index vendor_intake_requests_payout_idx on app.vendor_intake_requests (payout_account_id);
create index vendor_intake_requests_version_idx on app.vendor_intake_requests (signed_version_id);
create index vendor_intake_requests_decided_by_idx on app.vendor_intake_requests (decided_by);
create index vendor_intake_requests_engagement_idx on app.vendor_intake_requests (engagement_id);
create index vendor_intake_requests_invoice_idx on app.vendor_intake_requests (invoice_id);

-- The request's project is its link's, stamped before the org is derived from the link (t10).
create or replace function private.stamp_vendor_intake_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.project_id := (select l.project_id from app.vendor_intake_links l where l.id = new.vendor_intake_link_id);
  return new;
end;
$$;

comment on function private.stamp_vendor_intake_request() is 'Before insert on vendor intake requests: the request''s project is its link''s (a derived entry in the denormalization register).';
revoke all on function private.stamp_vendor_intake_request() from public, anon, authenticated;

create trigger t05_stamp_vendor_intake_request before insert on app.vendor_intake_requests
  for each row execute function private.stamp_vendor_intake_request();

call private.install_domain_table('app.vendor_intake_requests', 'app.vendor_intake_links', 'vendor_intake_link_id',
  array['app.tax_forms', 'tax_form_id', 'app.payout_accounts', 'payout_account_id', 'app.document_versions', 'signed_version_id',
        'app.engagements', 'engagement_id', 'app.invoices', 'invoice_id']);
create index vendor_intake_requests_requested_by_idx on app.vendor_intake_requests (requested_by, vendor_intake_link_id, created_at);
create unique index vendor_intake_requests_pending_key on app.vendor_intake_requests
  (vendor_intake_link_id, coalesce(account_id, requested_by)) where request_state = 'Pending' and deleted_at is null;
call private.describe('app.vendor_intake_requests', 'What a vendor or contractor sent through a reusable intake link (ADR 0141): the company account (Vendor) or the person themselves (Contractor), their own tax form and payout provider reference (both written first through the existing payee paths; no tax identifier or bank number is ever stored here), the typed signature on the link''s pinned agreement version, and an optional first invoice draft. Approved into an Onboarding engagement or declined by the team. Written only through the intake RPCs. The requester reads their requests through api_external.my_vendor_intake_requests.', array[
  'vendor_intake_link_id', 'Intake link the request came through.',
  'project_id', 'Project of the link, stamped by the database.',
  'requested_by', 'Signed-in person who sent the request.',
  'account_id', 'Vendor only: the company account the requester holds Account Owner or Account Admin in; null for a Contractor.',
  'tax_form_id', 'The requester''s own tax form for the org (W-9 or W-8BEN-E for an account, W-9 or W-8BEN for a person).',
  'payout_account_id', 'The requester''s own payout provider reference for the org; a reference only, since XOS never holds funds.',
  'signer_name', 'Name the requester typed to sign the agreement.',
  'signed_at', 'When the requester signed.',
  'signed_version_id', 'Agreement version signed: the link''s pinned version.',
  'invoice_draft', 'Optional first invoice: invoice_number, issue_date, due_date, currency_code and up to 50 lines of description, quantity and unit_price_minor. Submitted through app.submit_intake_invoice once the money area opens.',
  'request_state', 'Pending, Approved, Declined or Withdrawn.',
  'decided_by', 'Member who approved or declined.',
  'decided_at', 'When it was decided.',
  'decision_reason', 'Why it was declined (at least 10 characters), or a note on approval.',
  'engagement_id', 'Engagement the approval created.',
  'invoice_id', 'Invoice the draft became; set once.'
]);
call private.install_audit_trail('app.vendor_intake_requests');
call private.install_default_retention('app.vendor_intake_requests');

call private.install_policies('app.vendor_intake_requests',
  $$project_id in (select private.project_ids_with('opportunities.engagement.read')) and private.is_member(org_id)$$);
revoke insert, update, delete on app.vendor_intake_requests from authenticated;

create or replace function private.guard_vendor_intake_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('vendor_intake_service') then
    perform private.refuse('vendor_intake_request_rpc', 'Intake requests are sent and decided only through the intake RPCs.');
  end if;
  if tg_op = 'UPDATE' and (new.vendor_intake_link_id <> old.vendor_intake_link_id or new.requested_by <> old.requested_by
     or new.account_id is distinct from old.account_id or new.tax_form_id is distinct from old.tax_form_id
     or new.payout_account_id is distinct from old.payout_account_id or new.signed_at is distinct from old.signed_at
     or new.signer_name is distinct from old.signer_name or new.invoice_draft is distinct from old.invoice_draft
     or new.project_id <> old.project_id
     or (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id)) then
    perform private.refuse('vendor_intake_request_fixed', 'A request keeps what was sent; send a new request instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_vendor_intake_request() is 'Vendor intake requests: written only inside the intake RPCs (trusted operation vendor_intake_service); a request keeps its link, requester, account, tax form, payout reference, signature and draft, and its invoice once set.';
revoke all on function private.guard_vendor_intake_request() from public, anon, authenticated;

create trigger t40_guard_vendor_intake_request before insert or update on app.vendor_intake_requests
  for each row execute function private.guard_vendor_intake_request();

insert into private.trash_excluded_tables (table_name, rationale) values
  ('vendor_intake_requests', 'A request is withdrawn or declined, never deleted by hand; a new request is sent instead.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

-- The requester's own view (Section 8.7) ---------------------------------------------------------------------------------

create view api_external.my_vendor_intake_requests as
select r.id, o.name as org_name, p.name as project_name, l.title, r.request_state, r.decision_reason, r.engagement_id,
  (r.request_state = 'Approved' and r.invoice_draft is not null and r.invoice_id is null) as invoice_ready,
  r.invoice_id is not null as invoice_used,
  r.created_at,
  -- What the reader may do now, the checks app.withdraw_vendor_intake and app.submit_engagement_invoice make, so a screen
  -- shows no control its RPC would refuse. The view runs as its owner, so it can call the private helper.
  (r.request_state = 'Pending' and r.requested_by = (select private.current_person_id())) as viewer_can_withdraw,
  (r.request_state = 'Approved' and r.invoice_draft is not null and r.invoice_id is null and e.id is not null
    and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'money')
    and case when e.counterparty_id is null then e.person_id = (select private.current_person_id())
      else e.counterparty_id in (select c.id from app.counterparties c
        where c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[])))
      end) as viewer_can_submit_invoice
from app.vendor_intake_requests r
join app.vendor_intake_links l on l.id = r.vendor_intake_link_id
join app.organizations o on o.id = r.org_id
join app.projects p on p.id = r.project_id
left join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
where r.deleted_at is null
  and (r.requested_by = (select private.current_person_id())
    or r.account_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[])));

comment on view api_external.my_vendor_intake_requests is 'The signed-in person''s own vendor intake requests (ADR 0141; Section 8.7): those they sent, and those of accounts where they are Account Owner, Admin or Finance. Column-allowlisted: the org and project names, the link''s title, the state, the decline reason, the engagement once approved, whether the stored first invoice is ready to submit or already used, and what the reader may do now. Never the tax form, payout reference or the team''s note.';
comment on column api_external.my_vendor_intake_requests.id is 'Request.';
comment on column api_external.my_vendor_intake_requests.org_name is 'Org the request was sent to.';
comment on column api_external.my_vendor_intake_requests.project_name is 'Project of the intake link.';
comment on column api_external.my_vendor_intake_requests.title is 'Title of the intake link.';
comment on column api_external.my_vendor_intake_requests.request_state is 'Pending, Approved, Declined or Withdrawn.';
comment on column api_external.my_vendor_intake_requests.decision_reason is 'Why the request was declined, or the team''s note on approval.';
comment on column api_external.my_vendor_intake_requests.engagement_id is 'Engagement the approval created.';
comment on column api_external.my_vendor_intake_requests.invoice_ready is 'True when an approved request still holds its first invoice draft, unsent.';
comment on column api_external.my_vendor_intake_requests.invoice_used is 'True once the draft was submitted as an invoice.';
comment on column api_external.my_vendor_intake_requests.created_at is 'When the request was sent.';
comment on column api_external.my_vendor_intake_requests.viewer_can_withdraw is 'True when the reader sent this request and it still waits, which is who app.withdraw_vendor_intake accepts.';
comment on column api_external.my_vendor_intake_requests.viewer_can_submit_invoice is 'True when the stored first invoice is ready and app.submit_engagement_invoice would take it from the reader now: the engagement''s money area is open to them, and they are the person engaged or the account''s Owner, Admin or Finance member.';
revoke all on api_external.my_vendor_intake_requests from public, anon;
grant select on api_external.my_vendor_intake_requests to authenticated, service_role;
revoke select on api_external.my_vendor_intake_requests from xos_backup;

-- Submitting -------------------------------------------------------------------------------------------------------------

-- Refuses a malformed first invoice draft: {invoice_number, issue_date, due_date, currency_code, lines: [{description,
-- quantity, unit_price_minor}]}, 1 to 50 lines. app.invoices.currency_code is required (0321), so the draft carries it.
create or replace function private.assert_intake_invoice_draft(p_draft jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_line jsonb;
begin
  if jsonb_typeof(p_draft) is distinct from 'object'
     or coalesce(char_length(btrim(p_draft ->> 'invoice_number')), 0) not between 1 and 60
     or coalesce(p_draft ->> 'issue_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(p_draft ->> 'due_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(p_draft -> 'lines') is distinct from 'array'
     or jsonb_array_length(p_draft -> 'lines') not between 1 and 50 then
    perform private.refuse('vendor_intake_invoice_draft', 'A first invoice has a number, an issue date, a due date and 1 to 50 lines.');
  end if;
  if not exists (select 1 from private.currencies c where c.currency_code = p_draft ->> 'currency_code') then
    perform private.refuse('vendor_intake_invoice_draft', 'A first invoice names its currency.');
  end if;
  if (p_draft ->> 'due_date')::date < (p_draft ->> 'issue_date')::date then
    perform private.refuse('vendor_intake_invoice_draft', 'The due date is on or after the issue date.');
  end if;
  for v_line in select jsonb_array_elements(p_draft -> 'lines') loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or coalesce(char_length(btrim(v_line ->> 'description')), 0) not between 1 and 500
       or jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0
       or (v_line ? 'unit_price_minor' and v_line -> 'unit_price_minor' <> 'null'::jsonb
           and (jsonb_typeof(v_line -> 'unit_price_minor') <> 'number' or (v_line ->> 'unit_price_minor')::numeric < 0
                or (v_line ->> 'unit_price_minor')::numeric <> trunc((v_line ->> 'unit_price_minor')::numeric))) then
      perform private.refuse('vendor_intake_invoice_draft', 'Each line has a description of up to 500 characters, a quantity above 0 and a unit price of 0 or more in minor units, or none.');
    end if;
  end loop;
end;
$$;

comment on function private.assert_intake_invoice_draft(jsonb) is 'Refuses a malformed first invoice draft (vendor_intake_invoice_draft): an invoice number of 1 to 60 characters, issue and due dates as YYYY-MM-DD with the due date on or after the issue date, a known currency_code, and 1 to 50 lines each with a description of 1 to 500 characters, a quantity above 0 and an optional whole unit_price_minor of 0 or more.';
revoke all on function private.assert_intake_invoice_draft(jsonb) from public, anon, authenticated;

-- A reference that looks like a bank account: S4.4-38 requires bank details to be encrypted Restricted or held by the
-- provider, and provider_account_reference is Confidential plain text. A numeric AP vendor number such as 100234 is
-- refused too; ADR 0141 records that false positive.
create or replace function private.payout_reference_is_bank_shaped(p_reference text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (p_reference ~ '^[0-9][0-9 -]*$' and char_length(regexp_replace(p_reference, '[^0-9]', '', 'g')) between 6 and 34)
    or upper(regexp_replace(p_reference, '\s', '', 'g')) ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$',
    false);
$$;

comment on function private.payout_reference_is_bank_shaped(text) is 'True when a payout reference looks like a bank account number: a run of 6 to 34 digits with optional spaces or hyphens, or an IBAN shape after spaces are stripped. Such a value is never stored through an intake (payout_reference_bank_number).';
revoke all on function private.payout_reference_is_bank_shaped(text) from public, anon, authenticated;

create or replace function app.add_intake_payout_reference(
  p_token text,
  p_grant text,
  p_reference text,
  p_account_id uuid default null,
  p_client_address text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_read record;
  v_link app.vendor_intake_links;
  v_reference text := btrim(coalesce(p_reference, ''));
  v_id uuid;
begin
  select * into v_read from private.vendor_intake_reader(p_token, p_grant, p_client_address);
  if v_read.o_reason is not null then
    perform private.refuse(v_read.o_reason, 'Open the intake link again with its access code.');
  end if;
  v_link := v_read.o_link;
  if not v_link.collect_payout then
    perform private.refuse('vendor_intake_payout', 'This intake link does not take a payout reference.');
  end if;
  if private.org_read_only(v_link.org_id) then
    perform private.refuse('org_read_only', 'This organization is not taking new requests right now.');
  end if;
  if v_link.role_type = 'Vendor' then
    if p_account_id is null or p_account_id = v_link.org_id or not exists (
      select 1 from private.account_role(p_account_id) r (account_role)
      where r.account_role in ('Account Owner', 'Account Admin', 'Account Finance')) then
      perform private.refuse('vendor_intake_account', 'Choose a company account where you are the Account Owner, an Account Admin or in Account Finance.');
    end if;
  elsif p_account_id is not null then
    perform private.refuse('vendor_intake_account', 'A contractor request is for you yourself, not a company account.');
  end if;
  if char_length(v_reference) not between 1 and 200 then
    perform private.refuse('payout_reference_length', 'Enter a reference of up to 200 characters.');
  end if;
  if private.payout_reference_is_bank_shaped(v_reference) then
    perform private.refuse('payout_reference_bank_number', 'A plain number of 6 or more digits looks like a bank account. Use the reference with its letters or prefix.');
  end if;
  select a.id into v_id from app.payout_accounts a
  where a.org_id = v_link.org_id and a.deleted_at is null and a.provider = 'Accounting System'
    and a.provider_account_reference = v_reference
    and a.person_id is not distinct from (case when p_account_id is null then v_person end)
    and a.organization_id is not distinct from p_account_id
  limit 1;
  if v_id is not null then
    return v_id;
  end if;
  insert into app.payout_accounts (org_id, person_id, organization_id, provider, provider_account_reference)
  values (v_link.org_id, case when p_account_id is null then v_person end, p_account_id, 'Accounting System', v_reference)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.add_intake_payout_reference(text, text, text, uuid, text) is 'Files the signed-in requester''s payout reference with an intake link''s org (ADR 0141): needs the link''s token and grant and a link that collects payout, and for a Vendor link Account Owner, Admin or Finance on the account. Writes provider Accounting System only, with no last four, and refuses a bank-shaped value (payout_reference_bank_number), storing nothing. An identical reference answers the existing row. Returns the payout account id.';
revoke all on function app.add_intake_payout_reference(text, text, text, uuid, text) from public, anon;
grant execute on function app.add_intake_payout_reference(text, text, text, uuid, text) to authenticated, service_role;

create or replace function app.submit_vendor_intake(
  p_token text,
  p_grant text,
  p_account_id uuid default null,
  p_tax_form_id uuid default null,
  p_payout_account_id uuid default null,
  p_signer_name text default null,
  p_invoice_draft jsonb default null,
  p_client_address text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_read record;
  v_link app.vendor_intake_links;
  v_subject text;
  v_form app.tax_forms;
  v_payout app.payout_accounts;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id uuid;
  v_recipient uuid;
  v_requester text;
begin
  select * into v_read from private.vendor_intake_reader(p_token, p_grant, p_client_address);
  if v_read.o_reason is not null then
    perform private.refuse(v_read.o_reason, 'Open the intake link again with its access code.');
  end if;
  v_link := v_read.o_link;
  select * into v_link from app.vendor_intake_links l where l.id = v_link.id for update;
  if private.org_read_only(v_link.org_id) then
    perform private.refuse('org_read_only', 'This organization is not taking new requests right now.');
  end if;
  if private.vendor_intake_request_count(v_link.id) >= v_link.max_requests then
    perform private.refuse('intake_link_full', 'This intake link has taken all the requests it can. Ask the organization for a new one.');
  end if;
  v_subject := v_person::text || ' ' || v_link.id::text;
  if private.rate_limit_exceeded('vendor_intake.submit', v_subject, 3, interval '24 hours') then
    perform private.refuse('vendor_intake_rate_limited', 'You sent 3 requests through this link today. Try again tomorrow.');
  end if;

  if v_link.role_type = 'Vendor' then
    if p_account_id is null or p_account_id = v_link.org_id or not exists (
      select 1 from private.account_role(p_account_id) r (account_role) where r.account_role in ('Account Owner', 'Account Admin')) then
      perform private.refuse('vendor_intake_account', 'Choose a company account where you are the Account Owner or an Account Admin.');
    end if;
  elsif p_account_id is not null then
    perform private.refuse('vendor_intake_account', 'A contractor request is for you yourself, not a company account.');
  end if;

  if p_tax_form_id is not null then
    if not v_link.collect_tax_form then
      perform private.refuse('vendor_intake_tax_form', 'This intake link does not take a tax form.');
    end if;
    select * into v_form from app.tax_forms f
    where f.id = p_tax_form_id and f.deleted_at is null and f.org_id = v_link.org_id
      and ((v_link.role_type = 'Contractor' and f.person_id = v_person and f.form_kind in ('W-9', 'W-8BEN'))
        or (v_link.role_type = 'Vendor' and f.organization_id = p_account_id and f.form_kind in ('W-9', 'W-8BEN-E')));
    if v_form.id is null then
      perform private.refuse('vendor_intake_tax_form', 'Give your own tax form for this organization: a W-9 or W-8BEN for yourself, a W-9 or W-8BEN-E for a company.');
    end if;
  elsif v_link.collect_tax_form then
    perform private.refuse('vendor_intake_tax_form', 'This intake link needs your tax form.');
  end if;

  if p_payout_account_id is not null then
    if not v_link.collect_payout then
      perform private.refuse('vendor_intake_payout', 'This intake link does not take a payout reference.');
    end if;
    select * into v_payout from app.payout_accounts a
    where a.id = p_payout_account_id and a.deleted_at is null and a.org_id = v_link.org_id
      and ((v_link.role_type = 'Contractor' and a.person_id = v_person)
        or (v_link.role_type = 'Vendor' and a.organization_id = p_account_id));
    if v_payout.id is null then
      perform private.refuse('vendor_intake_payout', 'Give your own payout reference for this organization.');
    end if;
    -- 0730 still grants a direct insert and update, which cannot refuse a bank number.
    if private.payout_reference_is_bank_shaped(v_payout.provider_account_reference) then
      perform private.refuse('payout_reference_bank_number', 'A plain number of 6 or more digits looks like a bank account. Use the reference with its letters or prefix.');
    end if;
  end if;

  if v_link.agreement_version_id is not null then
    if v_name is null or char_length(v_name) > 200 then
      perform private.refuse('vendor_intake_signature', 'Type your name to sign the agreement.');
    end if;
  else
    v_name := null;
  end if;

  if p_invoice_draft is not null and p_invoice_draft <> 'null'::jsonb then
    if not v_link.collect_invoice then
      perform private.refuse('vendor_intake_invoice_not_collected', 'This intake link does not take a first invoice.');
    end if;
    perform private.assert_intake_invoice_draft(p_invoice_draft);
  end if;

  if exists (select 1 from app.vendor_intake_requests r
             where r.vendor_intake_link_id = v_link.id and r.request_state = 'Pending' and r.deleted_at is null
               and coalesce(r.account_id, r.requested_by) = coalesce(p_account_id, v_person)) then
    perform private.refuse('vendor_intake_pending', 'You already have a request waiting on this link.');
  end if;

  perform private.begin_trusted_operation('vendor_intake_service');
  insert into app.vendor_intake_requests as r (vendor_intake_link_id, requested_by, account_id, tax_form_id, payout_account_id,
    signer_name, signed_at, signed_version_id, invoice_draft)
  values (v_link.id, v_person, p_account_id, v_form.id, v_payout.id, v_name, case when v_name is not null then now() end,
    case when v_name is not null then v_link.agreement_version_id end,
    case when p_invoice_draft is not null and p_invoice_draft <> 'null'::jsonb then p_invoice_draft end)
  returning r.id into v_id;
  perform private.end_trusted_operation('vendor_intake_service');
  perform private.note_rate_event('vendor_intake.submit', v_subject);

  perform private.emit_event(v_link.org_id, 'vendor_intake.submitted', 'vendor_intake_requests', v_id, v_link.project_id,
    jsonb_build_object('vendor_intake_link_id', v_link.id, 'role_type', v_link.role_type));
  v_requester := coalesce((select o.name from app.organizations o where o.id = p_account_id),
    (select pe.full_name from app.people pe where pe.id = v_person), '');
  for v_recipient in
    select x from private.project_member_people_with(v_link.project_id, 'opportunities.engagement.write') x where x <> v_person
  loop
    perform private.notify(v_link.org_id, v_recipient, 'vendor_intake.submitted', 'vendor_intake_requests', v_id, v_link.project_id,
      jsonb_build_object('title', v_link.title, 'requesterName', v_requester,
        'projectName', (select p.name from app.projects p where p.id = v_link.project_id)));
  end loop;
  return v_id;
end;
$$;

comment on function app.submit_vendor_intake(text, text, uuid, uuid, uuid, text, jsonb, text) is 'Sends a vendor intake request as the signed-in person through a reusable intake link''s token and grant (ADR 0141). Refuses as private.vendor_intake_reader does, a read-only org, a full link (intake_link_full), a fourth request by the person on the link within 24 hours (vendor_intake_rate_limited), a Vendor request without an account where the person is Account Owner or Admin or a Contractor request naming one (vendor_intake_account), a tax form or payout reference that is not the caller''s own for the link''s org or not collected (vendor_intake_tax_form, vendor_intake_payout; a tax form is required when collected), a bank-shaped payout reference even one inserted directly (payout_reference_bank_number), a missing typed name when the link has an agreement (vendor_intake_signature), an invoice draft when the link takes none or a malformed one, and a second pending request. Emits vendor_intake.submitted and notifies every member holding opportunities.engagement.write on the project. Returns the request id.';
revoke all on function app.submit_vendor_intake(text, text, uuid, uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function app.submit_vendor_intake(text, text, uuid, uuid, uuid, text, jsonb, text) to authenticated, service_role;

-- A request that ends without an engagement takes the Restricted rows written for it, unless something else still needs
-- them: another live request, or an engagement of the payee in the org.
create or replace function private.discard_intake_payee_rows(p_request app.vendor_intake_requests)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from app.engagements e
    where e.org_id = p_request.org_id and e.deleted_at is null
      and ((p_request.account_id is null and e.person_id = p_request.requested_by)
        or (p_request.account_id is not null and e.counterparty_id in (
              select c.id from app.counterparties c
              where c.org_id = p_request.org_id and c.organization_id = p_request.account_id)))) then
    return;
  end if;
  update app.tax_forms f set deleted_at = now()
  where f.id = p_request.tax_form_id and f.deleted_at is null
    and not exists (select 1 from app.vendor_intake_requests r
                    where r.tax_form_id = f.id and r.id <> p_request.id and r.deleted_at is null
                      and r.request_state in ('Pending', 'Approved'));
  update app.payout_accounts a set deleted_at = now()
  where a.id = p_request.payout_account_id and a.deleted_at is null
    and not exists (select 1 from app.vendor_intake_requests r
                    where r.payout_account_id = a.id and r.id <> p_request.id and r.deleted_at is null
                      and r.request_state in ('Pending', 'Approved'));
end;
$$;

comment on function private.discard_intake_payee_rows(app.vendor_intake_requests) is 'After a vendor intake request is declined or withdrawn: soft-deletes its tax form and payout reference when no other live request names them and the payee has no engagement in the org (ADR 0141).';
revoke all on function private.discard_intake_payee_rows(app.vendor_intake_requests) from public, anon, authenticated;

create or replace function app.withdraw_vendor_intake(p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_request app.vendor_intake_requests;
begin
  select * into v_request from app.vendor_intake_requests r where r.id = p_request_id and r.deleted_at is null for update;
  if v_request.id is null or v_request.requested_by <> v_person then
    raise exception using errcode = '42501', message = 'request not found';
  end if;
  if v_request.request_state <> 'Pending' then
    perform private.refuse('vendor_intake_not_pending', 'Only a request that is still waiting can be withdrawn.');
  end if;
  perform private.begin_trusted_operation('vendor_intake_service');
  update app.vendor_intake_requests set request_state = 'Withdrawn' where id = v_request.id;
  perform private.end_trusted_operation('vendor_intake_service');
  perform private.discard_intake_payee_rows(v_request);
  perform private.emit_event(v_request.org_id, 'vendor_intake.withdrawn', 'vendor_intake_requests', v_request.id, v_request.project_id, '{}'::jsonb);
end;
$$;

comment on function app.withdraw_vendor_intake(uuid) is 'Withdraws the signed-in person''s own intake request while it is Pending (ADR 0141), which frees its slot on the link and soft-deletes the tax form and payout reference written for it when nothing else needs them.';
revoke all on function app.withdraw_vendor_intake(uuid) from public, anon;
grant execute on function app.withdraw_vendor_intake(uuid) to authenticated, service_role;

-- Deciding ---------------------------------------------------------------------------------------------------------------

create or replace function app.decide_vendor_intake(p_request_id uuid, p_approve boolean, p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_request app.vendor_intake_requests;
  v_link app.vendor_intake_links;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_counterparty uuid;
  v_engagement uuid;
  v_document uuid;
  v_title text;
  v_latest uuid;
  v_version integer;
  v_zone text;
begin
  select * into v_request from app.vendor_intake_requests r where r.id = p_request_id and r.deleted_at is null for update;
  if v_request.id is null or not private.is_member(v_request.org_id)
     or not private.can_on_project(v_request.project_id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  if v_request.request_state <> 'Pending' then
    perform private.refuse('vendor_intake_not_pending', 'This request has already been decided or withdrawn.');
  end if;
  if v_request.requested_by = v_person or (v_request.account_id is not null
     and exists (select 1 from private.account_role(v_request.account_id))) then
    perform private.refuse('sod_vendor_intake_self', 'The person who sent an intake request, or anyone in the vendor account, cannot decide it.');
  end if;
  select * into v_link from app.vendor_intake_links l where l.id = v_request.vendor_intake_link_id;

  if not coalesce(p_approve, false) then
    if v_reason is null or char_length(v_reason) < 10 then
      perform private.refuse('vendor_intake_decline_reason', 'Say why the request is declined, in at least 10 characters, so the requester can act on it.');
    end if;
    perform private.begin_trusted_operation('vendor_intake_service');
    update app.vendor_intake_requests set request_state = 'Declined', decided_by = v_person, decided_at = now(),
      decision_reason = left(v_reason, 1000)
    where id = v_request.id;
    perform private.end_trusted_operation('vendor_intake_service');
    perform private.discard_intake_payee_rows(v_request);
    perform private.emit_event(v_request.org_id, 'vendor_intake.decided', 'vendor_intake_requests', v_request.id, v_request.project_id,
      jsonb_build_object('approved', false));
    return v_request.id;
  end if;

  -- 1. The vendor's counterparty: the org's live row for the account, or a new one with the link's type (as 1624).
  if v_request.account_id is not null then
    select c.id into v_counterparty from app.counterparties c
    where c.org_id = v_request.org_id and c.organization_id = v_request.account_id and c.deleted_at is null;
    if v_counterparty is null then
      insert into app.counterparties (org_id, organization_id, counterparty_type)
      values (v_request.org_id, v_request.account_id, v_link.counterparty_type)
      returning id into v_counterparty;
    end if;
  end if;

  -- 2. The engagement on the link's terms; the plan limit, the XOS-ENG rules and 0730's onboarding items apply as usual.
  insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date, end_date)
  values (v_request.project_id, case when v_link.role_type = 'Contractor' then v_request.requested_by end, v_counterparty,
    v_link.role_type, v_link.role_code, v_link.worker_classification, v_link.pay_basis, v_link.arrangement,
    v_link.start_date, v_link.end_date)
  returning id into v_engagement;

  -- 3. Items the request already carries are submitted; a reviewer still verifies them.
  update app.onboarding_items i set submitted_at = now()
  from app.onboarding_requirements q
  where i.engagement_id = v_engagement and q.id = i.onboarding_requirement_id and i.deleted_at is null and i.submitted_at is null
    and ((q.item_kind = 'Tax Form' and v_request.tax_form_id is not null)
      or (q.item_kind = 'Payout Details' and exists (
            -- 0730 lets a payee change a reference after submit, so it is checked again here.
            select 1 from app.payout_accounts a
            where a.id = v_request.payout_account_id and a.deleted_at is null
              and not private.payout_reference_is_bank_shaped(a.provider_account_reference))));

  -- 4. The agreement: Proposed to Sent by the org, then Sent to Signed with the intake signature, as 0769's signing link
  --    does, when the signed version is still the latest. A newer version stays Sent for the party to sign in Gateway.
  if v_link.agreement_document_id is not null then
    select d.title into v_title from app.documents d where d.id = v_link.agreement_document_id;
    insert into app.engagement_documents (engagement_id, document_kind, title, document_id)
    values (v_engagement, 'Agreement', left(coalesce(v_title, 'Agreement'), 200), v_link.agreement_document_id)
    returning id into v_document;
    perform app.transition_engagement_document(v_document, 'Proposed', 'Sent', 'Sent with the intake link''s agreement.');
    select v.id into v_latest from app.document_versions v
    where v.document_id = v_link.agreement_document_id order by v.version_number desc, v.id desc limit 1;
    if v_request.signed_version_id is not null and v_latest = v_request.signed_version_id then
      select v.version_number into v_version from app.document_versions v where v.id = v_request.signed_version_id;
      select coalesce(nullif(btrim(p.time_zone), ''), private.org_setting_text(v_request.org_id, 'locale.time_zone'), 'UTC') into v_zone
      from app.projects p where p.id = v_request.project_id;
      perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
        'app.engagement_document_state_transitions', 'engagement_document_id', v_document, 'Sent', 'Signed',
        left(format('Signed at intake by %s on %s %s, version %s', v_request.signer_name,
          to_char(v_request.signed_at at time zone v_zone, 'YYYY-MM-DD HH24:MI'), v_zone, v_version), 500));
      perform private.emit_event(v_request.org_id, 'vendor_intake.signed', 'engagement_documents', v_document, v_request.project_id,
        jsonb_build_object('vendor_intake_request_id', v_request.id, 'version', v_version));
    end if;
  end if;

  -- 5. The decision.
  perform private.begin_trusted_operation('vendor_intake_service');
  update app.vendor_intake_requests set request_state = 'Approved', decided_by = v_person, decided_at = now(),
    decision_reason = left(v_reason, 1000), engagement_id = v_engagement
  where id = v_request.id;
  perform private.end_trusted_operation('vendor_intake_service');
  perform private.emit_event(v_request.org_id, 'vendor_intake.decided', 'vendor_intake_requests', v_request.id, v_request.project_id,
    jsonb_build_object('approved', true, 'engagement_id', v_engagement));
  return v_engagement;
end;
$$;

comment on function app.decide_vendor_intake(uuid, boolean, text) is 'Approves or declines a pending vendor intake request (ADR 0141). Needs membership of the org and opportunities.engagement.write on the project; the requester and anyone with a role in the vendor account are refused (sod_vendor_intake_self). A decline needs a reason of at least 10 characters, soft-deletes the tax form and payout reference written for it when nothing else needs them, and returns the request id. Approval reuses the org''s live counterparty for the account or adds one with the link''s counterparty type, creates an Onboarding engagement on the link''s role, classification, pay basis, arrangement and dates (the plan limit and the XOS-ENG rules surface their own refusals), marks its Tax Form and Payout Details items submitted when the request carries them and a payout reference is still live and not bank-shaped (never verified), and moves the agreement Proposed to Sent to Signed with the intake ledger reason, written in the project''s zone, or leaves it Sent when the document has a newer version than the one signed. Returns the engagement id.';
revoke all on function app.decide_vendor_intake(uuid, boolean, text) from public, anon;
grant execute on function app.decide_vendor_intake(uuid, boolean, text) to authenticated, service_role;

-- A member's client cannot read an external person from app.people or an unrelated account from app.organizations.
create or replace function app.vendor_intake_request_party(p_request_id uuid)
returns table (requester_name text, account_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select pe.full_name, o.name
  from app.vendor_intake_requests r
  join app.people pe on pe.id = r.requested_by
  left join app.organizations o on o.id = r.account_id
  where r.id = p_request_id and r.deleted_at is null and private.is_member(r.org_id)
    and private.can_on_project(r.project_id, 'opportunities.engagement.read');
$$;

comment on function app.vendor_intake_request_party(uuid) is 'The requester''s name and the vendor account''s name on an intake request, for a member of the org holding opportunities.engagement.read on the project; no row for anyone else (ADR 0141). A member''s client cannot read an external person or an unrelated account directly.';
revoke all on function app.vendor_intake_request_party(uuid) from public, anon;
grant execute on function app.vendor_intake_request_party(uuid) to authenticated, service_role;

create or replace function app.submit_intake_invoice(p_request_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_request app.vendor_intake_requests;
  v_invoice uuid;
begin
  select * into v_request from app.vendor_intake_requests r where r.id = p_request_id and r.deleted_at is null for update;
  if v_request.id is null or not (v_request.requested_by = v_person or v_request.account_id in (
       select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))) then
    raise exception using errcode = '42501', message = 'request not found';
  end if;
  if v_request.invoice_id is not null then
    perform private.refuse('intake_invoice_used', 'The first invoice of this request was already submitted.');
  end if;
  if v_request.request_state <> 'Approved' or v_request.engagement_id is null or v_request.invoice_draft is null then
    perform private.refuse('intake_invoice_none', 'This request has no first invoice waiting.');
  end if;
  -- Section 8.7: app.submit_engagement_invoice decides whether the engagement's money area is open.
  v_invoice := app.submit_engagement_invoice(v_request.engagement_id, v_request.invoice_draft ->> 'invoice_number',
    (v_request.invoice_draft ->> 'issue_date')::date, (v_request.invoice_draft ->> 'due_date')::date,
    v_request.invoice_draft ->> 'currency_code', v_request.invoice_draft -> 'lines');
  perform private.begin_trusted_operation('vendor_intake_service');
  update app.vendor_intake_requests set invoice_id = v_invoice where id = v_request.id;
  perform private.end_trusted_operation('vendor_intake_service');
  return v_invoice;
end;
$$;

comment on function app.submit_intake_invoice(uuid) is 'Submits the first invoice stored on an approved vendor intake request, once (intake_invoice_used), with the draft''s currency through app.submit_engagement_invoice, so the Section 8.7 money area rule decides when it can go. The requester or the account''s Owner, Admin or Finance member may. Returns the invoice id.';
revoke all on function app.submit_intake_invoice(uuid) from public, anon;
grant execute on function app.submit_intake_invoice(uuid) to authenticated, service_role;
