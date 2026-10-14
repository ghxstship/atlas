-- 0700_engagement_contract.sql
-- A28 Engagements and Marketplace (ADR 0004 range 0700 to 0799, RRR-17). The engagement contract
-- (design/xos-design-system/export/canon/contract_engagement.sql, decisions D16 and D17) under ADR 0002
-- and ADR 0016:
--   * organization_type on app.organizations (D17), the one column this range adds to A02's table
--   * employment status and FLSA status reference lists, labor agreements
--   * engagements keyed to app.projects, app.people and app.counterparties, with the engagement
--     lifecycle (Section 3.12 lifecycle 5, Section 4.4.4) and its transition ledger
--   * the compliance trigger enforcing XOS-ENG-1 to XOS-ENG-6, each refusal naming its rule (XR001)
--   * engagement documents with the Engagement-Document lifecycle (Section 3.12 lifecycle 6)
--   * app.engagement_resolved, the engagement as every surface reads it, with the rate read from the
--     agreed rate, then the org rate card line, then the canon rate card (ADR 0014 carry-over:
--     agreed_rate became agreed_rate_minor plus a currency)
-- Counterparty relationships are A03's app.counterparties (the org-side row for another organization);
-- this range keys to them and adds no second relationship table.
-- External access policies (Section 8.7) are added in 0710 once accounts and representations exist.

-- Organization type (D17) -----------------------------------------------------------------------------
-- For-Profit is the default because it is the most restrictive type: it permits every classification
-- except Volunteer, so an organization that never declared its form is never allowed more than the law
-- allows any organization.

alter table app.organizations
  add column organization_type text not null default 'For-Profit' references xpms.organization_type (label);

create index organizations_organization_type_idx on app.organizations (organization_type);

comment on column app.organizations.organization_type is 'Legal form of the organization (decision D17): For-Profit, Nonprofit or Public Agency. Decides which worker classifications its engagements may use (rule XOS-ENG-6). Defaults to For-Profit, the most restrictive form.';

grant update (organization_type) on app.organizations to authenticated;

-- Reference lists --------------------------------------------------------------------------------------

create table private.employment_statuses (
  label text primary key,
  sort_order smallint not null unique
);

comment on table private.employment_statuses is 'Employment statuses an employee engagement records (engagement contract employment_status).';
comment on column private.employment_statuses.label is 'Employment status, Title Case.';
comment on column private.employment_statuses.sort_order is 'Display order.';

insert into private.employment_statuses (label, sort_order) values
  ('Full-Time', 1), ('Part-Time', 2), ('Temporary', 3);

create table private.flsa_statuses (
  label text primary key,
  sort_order smallint not null unique
);

comment on table private.flsa_statuses is 'Fair Labor Standards Act statuses an employee engagement records (engagement contract flsa_status).';
comment on column private.flsa_statuses.label is 'FLSA status, Title Case.';
comment on column private.flsa_statuses.sort_order is 'Display order.';

insert into private.flsa_statuses (label, sort_order) values ('Exempt', 1), ('Nonexempt', 2);

alter table private.employment_statuses enable row level security;
alter table private.flsa_statuses enable row level security;
revoke all on private.employment_statuses, private.flsa_statuses from public, anon, authenticated;
grant select on private.employment_statuses, private.flsa_statuses to service_role;

create view app.employment_statuses as
select s.label, s.sort_order from private.employment_statuses s;
call private.describe('app.employment_statuses', 'Employment statuses an employee engagement records.', array[
  'label', 'Employment status.', 'sort_order', 'Display order.']);

create view app.flsa_statuses as
select s.label, s.sort_order from private.flsa_statuses s;
call private.describe('app.flsa_statuses', 'FLSA statuses an employee engagement records.', array[
  'label', 'FLSA status.', 'sort_order', 'Display order.']);

revoke all on app.employment_statuses, app.flsa_statuses from public, anon;
grant select on app.employment_statuses, app.flsa_statuses to authenticated, service_role;

-- Enums and lifecycle rules ----------------------------------------------------------------------------

create type app.engagement_state as enum ('Onboarding', 'Blocked', 'Active', 'Closing', 'Complete', 'Canceled');
comment on type app.engagement_state is 'Engagement lifecycle (Section 3.12 lifecycle 5, Section 4.4.4). Active needs every blocking onboarding item to pass; operational external access opens at Active and narrows at Complete (Section 8.7).';

create type app.engagement_document_kind as enum (
  'Offer', 'Agreement', 'Statement of Work', 'Non-Disclosure Agreement', 'Rider', 'Advance Packet',
  'Insurance Certificate', 'Lien Waiver', 'Settlement', 'Proof of Performance', 'Content Consent'
);
comment on type app.engagement_document_kind is 'Kinds of document exchanged on an engagement (Section 4.4.4 onboarding packets and close-out).';

create type app.engagement_document_state as enum ('Proposed', 'Sent', 'Signed', 'Executed', 'Expired', 'Superseded', 'Canceled');
comment on type app.engagement_document_state is 'Engagement-Document lifecycle (Section 3.12 lifecycle 6): drafted (Proposed), sent to the party, signed by the party, countersigned (Executed). Executed documents never return to an earlier state; they are only superseded or expire.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('engagement', 'Onboarding', 'Blocked'),
  ('engagement', 'Onboarding', 'Active'),
  ('engagement', 'Onboarding', 'Canceled'),
  ('engagement', 'Blocked', 'Onboarding'),
  ('engagement', 'Blocked', 'Active'),
  ('engagement', 'Blocked', 'Canceled'),
  ('engagement', 'Active', 'Blocked'),
  ('engagement', 'Active', 'Closing'),
  ('engagement', 'Active', 'Canceled'),
  ('engagement', 'Closing', 'Active'),
  ('engagement', 'Closing', 'Complete'),
  ('engagement_document', 'Proposed', 'Sent'),
  ('engagement_document', 'Proposed', 'Canceled'),
  ('engagement_document', 'Sent', 'Signed'),
  ('engagement_document', 'Sent', 'Proposed'),
  ('engagement_document', 'Sent', 'Expired'),
  ('engagement_document', 'Sent', 'Canceled'),
  ('engagement_document', 'Signed', 'Executed'),
  ('engagement_document', 'Signed', 'Canceled'),
  ('engagement_document', 'Executed', 'Superseded'),
  ('engagement_document', 'Executed', 'Expired');

insert into private.domain_event_types (code, subject, description) values
  ('engagement.created', 'engagements', 'An external engagement was created.'),
  ('engagement.state_changed', 'engagements', 'An engagement moved to another engagement state.'),
  ('engagement_document.state_changed', 'engagement_documents', 'An engagement document moved to another document state.');

-- Labor agreements --------------------------------------------------------------------------------------

create table app.labor_agreements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  union_local text not null,
  effective_from date not null,
  effective_to date,
  deleted_at timestamptz,
  constraint labor_agreements_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint labor_agreements_union_local_length check (char_length(btrim(union_local)) between 1 and 200),
  constraint labor_agreements_effective check (effective_to is null or effective_to >= effective_from)
);

call private.install_domain_table('app.labor_agreements');
call private.describe('app.labor_agreements', 'Collective bargaining agreements an org works under (engagement contract labor_agreement). Only employee engagements name one (rule XOS-ENG-3).', array[
  'name', 'Agreement name.',
  'union_local', 'Union local that is party to the agreement.',
  'effective_from', 'First day the agreement applies.',
  'effective_to', 'Last day the agreement applies; NULL while open-ended.'
]);

-- Engagements ----------------------------------------------------------------------------------------------

create table app.engagements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  person_id uuid references app.people (id),
  counterparty_id uuid references app.counterparties (id),
  role_type app.external_role_type not null,
  role_code text not null references xpms.role (role_code),
  worker_classification text not null references xpms.worker_classification (code),
  pay_basis text references xpms.pay_basis (label),
  arrangement text references xpms.arrangement (label),
  agreed_rate_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  employment_status text references private.employment_statuses (label),
  flsa_status text references private.flsa_statuses (label),
  labor_agreement_id uuid references app.labor_agreements (id),
  start_date date not null,
  end_date date,
  engagement_state app.engagement_state not null default 'Onboarding',
  internal_note text,
  deleted_at timestamptz,
  constraint engagements_party check (person_id is not null or counterparty_id is not null),
  constraint engagements_pay_pair check ((pay_basis is null) = (arrangement is null)),
  constraint engagements_rate_needs_basis check (pay_basis is not null or agreed_rate_minor is null),
  constraint engagements_rate_currency check (agreed_rate_minor is null or currency_code is not null),
  constraint engagements_rate_nonnegative check (agreed_rate_minor is null or agreed_rate_minor >= 0),
  constraint engagements_dates check (end_date is null or end_date >= start_date),
  constraint engagements_internal_note_length check (internal_note is null or char_length(btrim(internal_note)) between 1 and 4000),
  constraint engagements_rate_card_fkey foreign key (role_code, worker_classification, pay_basis, arrangement)
    references xpms.rate_card (role_code, worker_classification, pay_basis, arrangement)
);

create index engagements_project_id_idx on app.engagements (project_id);
create index engagements_person_id_idx on app.engagements (person_id);
create index engagements_counterparty_id_idx on app.engagements (counterparty_id);
create index engagements_role_code_idx on app.engagements (role_code, worker_classification, pay_basis, arrangement);
create index engagements_worker_classification_idx on app.engagements (worker_classification);
create index engagements_pay_basis_idx on app.engagements (pay_basis);
create index engagements_arrangement_idx on app.engagements (arrangement);
create index engagements_currency_code_idx on app.engagements (currency_code);
create index engagements_employment_status_idx on app.engagements (employment_status);
create index engagements_flsa_status_idx on app.engagements (flsa_status);
create index engagements_labor_agreement_id_idx on app.engagements (labor_agreement_id);
create index engagements_state_idx on app.engagements (engagement_state);

call private.install_domain_table('app.engagements', 'app.projects', 'project_id',
  array['app.counterparties', 'counterparty_id', 'app.labor_agreements', 'labor_agreement_id']);
call private.describe('app.engagements', 'A person or an external organization working one project of an org in one external role (Section 4.4.4, engagement contract, decision D16). Role, classification, pay basis and arrangement identify the canon rate card, which is never repeated. External users read engagements only through api_external projections, never this table (Section 8.7).', array[
  'project_id', 'Project the engagement works.',
  'person_id', 'Engaged person. With a counterparty, the person the vendor or agency supplies.',
  'counterparty_id', 'Engaged external organization (the external account), as the org-side counterparty row. Required for vendor-supplied labor (XOS-ENG-4).',
  'role_type', 'External role type (Section 4.4.2): Client, Vendor, Contractor, Crew, Staff, Artist, Artist Representative or Sponsor.',
  'role_code', 'Canon role (Roles Library, decision D12).',
  'worker_classification', 'Canon worker classification (decision D16).',
  'pay_basis', 'Canon pay basis; NULL for an unpaid classification (XOS-ENG-1).',
  'arrangement', 'Canon arrangement; NULL exactly when the pay basis is NULL.',
  'agreed_rate_minor', 'Agreed rate in minor units per pay basis unit, when it differs from the rate card; NULL reads the rate card. Restricted (data.restricted.read.payroll).',
  'currency_code', 'ISO 4217 currency of the agreed rate.',
  'employment_status', 'Employment status; employees only (XOS-ENG-2, XOS-ENG-3).',
  'flsa_status', 'FLSA status; employees only (XOS-ENG-2, XOS-ENG-3).',
  'labor_agreement_id', 'Labor agreement the employee works under; employees only (XOS-ENG-3).',
  'start_date', 'First day of the engagement.',
  'end_date', 'Last day of the engagement; NULL while open-ended.',
  'engagement_state', 'Engagement state. Changes only through app.transition_engagement.',
  'internal_note', 'Internal org note. Never visible externally (Section 4.4.1).'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.engagements', 'agreed_rate_minor', 'Restricted', 'data.restricted.read.payroll'),
  ('app.engagements', 'internal_note', 'Confidential', null);


call private.install_lifecycle('app.engagements', 'engagement_id', 'engagement_state', 'engagement', 'Onboarding',
  $$engagement_id in (select e.id from app.engagements e where e.project_id in (select private.project_ids_with('opportunities.engagement.read')))$$);

create trigger t90_emit_engagement_created after insert on app.engagements
  for each row execute function private.emit_row_event('engagement.created', 'project_id', 'role_type', 'engagement_state');
create trigger t90_emit_engagement_state after insert on app.engagement_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('engagement.state_changed', 'engagements', 'engagement_id', 'from_state', 'to_state', 'reason');

-- Compliance rules (XOS-ENG-1 to XOS-ENG-6) ---------------------------------------------------------------

create or replace function private.engagement_compliance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wc xpms.worker_classification;
  v_rule_ot numeric;
  v_law_ot numeric;
  v_jurisdiction text;
begin
  select * into v_wc from xpms.worker_classification w where w.code = new.worker_classification;
  if (new.pay_basis is null) <> (v_wc.payment_channel = 'None') then
    perform private.refuse('XOS-ENG-1', format('%s engagements %s a pay basis.', v_wc.label,
      case when v_wc.payment_channel = 'None' then 'cannot have' else 'require' end));
  end if;
  if v_wc.is_employee and (new.employment_status is null or new.flsa_status is null) then
    perform private.refuse('XOS-ENG-2', 'Employee engagements require employment status and FLSA status.');
  end if;
  if not v_wc.is_employee and (new.employment_status is not null or new.flsa_status is not null or new.labor_agreement_id is not null) then
    perform private.refuse('XOS-ENG-3', 'Employment status, FLSA status and labor agreements apply only to employees.');
  end if;
  if new.worker_classification = 'VENDOR_SUPPLIED' and new.counterparty_id is null then
    perform private.refuse('XOS-ENG-4', 'Vendor-supplied engagements must name the vendor.');
  end if;
  if not exists (
    select 1 from app.organizations o
    join xpms.classification_organization_type c
      on c.organization_type = o.organization_type and c.worker_classification = new.worker_classification
    where o.id = new.org_id
  ) then
    perform private.refuse('XOS-ENG-6', format('%s engagements are not permitted for this organization type.', v_wc.label));
  end if;
  if new.flsa_status = 'Nonexempt' then
    select o.ot_multiplier into v_rule_ot
    from xpms.rate_card rc join xpms.overtime_rule o on o.rule_id = rc.overtime_rule_id
    where rc.role_code = new.role_code and rc.worker_classification = new.worker_classification
      and rc.pay_basis = new.pay_basis and rc.arrangement = new.arrangement;
    select coalesce(p.jurisdiction_id, v.jurisdiction_id) into v_jurisdiction
    from app.projects p left join app.venues v on v.id = p.venue_id
    where p.id = new.project_id;
    v_law_ot := xpms.min_ot_multiplier(v_jurisdiction);
    if v_law_ot is not null and v_rule_ot < v_law_ot then
      perform private.refuse('XOS-ENG-5', format('Nonexempt employees need an overtime multiplier of at least %s here; the rate card rule gives %s.', v_law_ot, v_rule_ot));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.engagement_compliance() is 'Before insert or update on engagements: the engagement contract rules XOS-ENG-1 (pay basis only for paid classifications), XOS-ENG-2 (employees carry employment and FLSA status), XOS-ENG-3 (those and labor agreements only for employees), XOS-ENG-4 (vendor-supplied labor names the vendor), XOS-ENG-6 (classification permitted for the organization type, D17) and XOS-ENG-5 (a nonexempt employee''s overtime rule meets the strictest minimum up the project''s jurisdiction chain). Each refusal names its rule.';

create trigger t45_engagement_compliance before insert or update on app.engagements
  for each row execute function private.engagement_compliance();

create or replace function private.guard_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id or new.person_id is distinct from old.person_id
       or new.counterparty_id is distinct from old.counterparty_id or new.role_type <> old.role_type then
      perform private.refuse('engagement_party_immutable', 'An engagement keeps its project, party and role type; create another engagement instead.');
    end if;
    return new;
  end if;
  -- Section 16: active external engagements per month.
  perform 1 from app.organizations o where o.id = new.org_id for update;
  select count(*) into v_count from app.engagements e
  where e.org_id = new.org_id and e.deleted_at is null and e.created_at >= date_trunc('month', now());
  perform private.assert_within_plan_limit(new.org_id, 'active_external_engagements_per_month', v_count + 1);
  return new;
end;
$$;

comment on function private.guard_engagement() is 'Engagements: the party, project and role type never change, and new engagements count against the org''s active_external_engagements_per_month plan limit (Section 16).';

create trigger t40_guard_engagement before insert or update on app.engagements
  for each row execute function private.guard_engagement();

-- Engagement documents --------------------------------------------------------------------------------------

create table app.engagement_documents (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  document_kind app.engagement_document_kind not null,
  title text not null,
  document_id uuid references app.documents (id),
  expires_on date,
  engagement_document_state app.engagement_document_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint engagement_documents_title_length check (char_length(btrim(title)) between 1 and 200)
);

create index engagement_documents_engagement_id_idx on app.engagement_documents (engagement_id);
create index engagement_documents_document_id_idx on app.engagement_documents (document_id);

call private.install_domain_table('app.engagement_documents', 'app.engagements', 'engagement_id', array['app.documents', 'document_id']);
call private.describe('app.engagement_documents', 'Documents exchanged on an engagement: offers, agreements, statements of work, riders, settlements (Section 4.4.4), each moving through the Engagement-Document lifecycle.', array[
  'engagement_id', 'Engagement the document belongs to.',
  'document_kind', 'Kind of document.',
  'title', 'Document title.',
  'document_id', 'Stored document and its versions (A03 knowledge documents), once uploaded.',
  'expires_on', 'Last day the document is valid, for documents that expire.',
  'engagement_document_state', 'Document state. Changes only through app.transition_engagement_document.'
]);

call private.install_lifecycle('app.engagement_documents', 'engagement_document_id', 'engagement_document_state', 'engagement_document', 'Proposed',
  $$engagement_document_id in (select d.id from app.engagement_documents d where d.engagement_id in (select e.id from app.engagements e where e.project_id in (select private.project_ids_with('opportunities.engagement.read'))))$$);

create trigger t90_emit_engagement_document_state after insert on app.engagement_document_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('engagement_document.state_changed', 'engagement_documents', 'engagement_document_id', 'from_state', 'to_state');

create or replace function private.guard_engagement_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.engagement_id <> old.engagement_id or new.document_kind <> old.document_kind) then
    perform private.refuse('engagement_document_immutable', 'A document keeps its engagement and kind.');
  end if;
  if tg_op = 'UPDATE' and old.engagement_document_state in ('Signed', 'Executed', 'Superseded')
     and (new.title <> old.title or new.document_id is distinct from old.document_id or new.expires_on is distinct from old.expires_on) then
    perform private.refuse('engagement_document_signed', 'A signed document cannot be edited; issue a new document that supersedes it.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_document() is 'Engagement documents keep their engagement and kind, and a signed or executed document is never edited.';

create trigger t40_guard_engagement_document before insert or update on app.engagement_documents
  for each row execute function private.guard_engagement_document();

-- Internal policies (external halves are added in 0710) --------------------------------------------------

call private.install_policies('app.labor_agreements',
  $$org_id in (select private.orgs_with_capability('opportunities.engagement.read'))$$,
  $$org_id in (select private.orgs_with_capability('opportunities.engagement.write'))$$);

call private.install_policies('app.engagements',
  $$project_id in (select private.project_ids_with('opportunities.engagement.read'))$$,
  $$project_id in (select private.project_ids_with('opportunities.engagement.write'))$$);

call private.install_policies('app.engagement_documents',
  $$engagement_id in (select e.id from app.engagements e where e.project_id in (select private.project_ids_with('opportunities.engagement.read')))$$,
  $$engagement_id in (select e.id from app.engagements e where e.project_id in (select private.project_ids_with('opportunities.engagement.write')))$$);

-- The Restricted agreed rate is never selectable directly; callers read app.engagement_resolved.
-- Writes reach only the columns a caller may change; state columns move through RPCs.
revoke select, insert, update on app.engagements from authenticated;
grant select (id, org_id, project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
  arrangement, currency_code, employment_status, flsa_status, labor_agreement_id, start_date, end_date, engagement_state,
  internal_note, created_at, created_by, updated_at, updated_by, deleted_at) on app.engagements to authenticated;
grant insert (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement,
  agreed_rate_minor, currency_code, employment_status, flsa_status, labor_agreement_id, start_date, end_date, internal_note)
  on app.engagements to authenticated;
grant update (role_code, worker_classification, pay_basis, arrangement, agreed_rate_minor, currency_code, employment_status,
  flsa_status, labor_agreement_id, start_date, end_date, internal_note, deleted_at)
  on app.engagements to authenticated;

-- Transition RPCs --------------------------------------------------------------------------------------------

create or replace function app.transition_engagement(p_engagement_id uuid, p_expected app.engagement_state, p_next app.engagement_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select e.project_id from app.engagements e where e.id = p_engagement_id and e.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  return private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
    'engagement_id', p_engagement_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_engagement(uuid, app.engagement_state, app.engagement_state, text) is 'Moves an engagement with compare-and-set on the expected state; needs opportunities.engagement.write on the project. Active is refused while a blocking onboarding item has not passed (0730). Returns the ledger entry id.';

create or replace function app.transition_engagement_document(p_document_id uuid, p_expected app.engagement_document_state, p_next app.engagement_document_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select e.project_id from app.engagement_documents d join app.engagements e on e.id = d.engagement_id
                     where d.id = p_document_id and d.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  if p_next = 'Signed' then
    perform private.refuse('engagement_document_party_signs', 'Only the engaged party signs; the org countersigns to execute.');
  end if;
  return private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', p_document_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_engagement_document(uuid, app.engagement_document_state, app.engagement_document_state, text) is 'Org-side moves of an engagement document (send, countersign to Executed, supersede, cancel) with compare-and-set; needs opportunities.engagement.write on the project. Signing is the party''s act (app.sign_engagement_document, 0710).';

-- Resolved view ------------------------------------------------------------------------------------------------
-- Security definer view (owner reads) with its own row filter, like A03's masked views, so policy
-- helpers never re-read a table a security_invoker view is scanning (ADR 0016 item 14).

create view app.engagement_resolved as
select e.id as engagement_id, e.org_id, e.project_id, e.person_id, e.counterparty_id, e.role_type, e.role_code, r.job_title,
  wc.label as worker_classification, wc.payment_channel, e.pay_basis, e.arrangement,
  rc.rate_card_id,
  case when private.has_capability(e.org_id, 'data.restricted.read.payroll')
       then coalesce(e.agreed_rate_minor, ol.rate_minor, rc.standard_rate_minor) end as rate_minor,
  case when e.agreed_rate_minor is not null then e.currency_code
       when ol.rate_minor is not null then ol.currency_code
       else rc.currency_code end as rate_currency_code,
  not private.has_capability(e.org_id, 'data.restricted.read.payroll') as is_masked,
  ot.ot_multiplier, ot.dt_multiplier, e.employment_status, e.flsa_status, e.labor_agreement_id,
  e.start_date, e.end_date, e.engagement_state
from app.engagements e
join xpms.role r on r.role_code = e.role_code
join xpms.worker_classification wc on wc.code = e.worker_classification
left join xpms.rate_card rc on rc.role_code = e.role_code and rc.worker_classification = e.worker_classification
  and rc.pay_basis = e.pay_basis and rc.arrangement = e.arrangement
left join lateral (
  select l.rate_minor, c.currency_code, l.overtime_rule_id
  from app.rate_card_lines l join app.rate_cards c on c.id = l.rate_card_id
  where l.org_id = e.org_id and l.deleted_at is null and c.deleted_at is null
    and l.role_code = e.role_code and l.worker_classification = e.worker_classification
    and l.pay_basis = e.pay_basis and l.arrangement = e.arrangement
    and c.effective_from <= e.start_date and (c.effective_to is null or c.effective_to >= e.start_date)
  order by c.effective_from desc
  limit 1
) ol on true
left join xpms.overtime_rule ot on ot.rule_id = coalesce(ol.overtime_rule_id, rc.overtime_rule_id)
where e.deleted_at is null
  and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));

call private.describe('app.engagement_resolved', 'Engagements as every internal surface reads them (engagement contract engagement_resolved): job title, classification and payment channel joined from canon, and the rate in force read from the agreed rate, then the org''s rate card line effective on the start date, then the canon rate card. The rate is Restricted and masked (NULL, is_masked true) without data.restricted.read.payroll. Rows follow the engagement read rule.', array[
  'engagement_id', 'Engagement.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'person_id', 'Engaged person.',
  'counterparty_id', 'Engaged external organization.',
  'role_type', 'External role type.',
  'role_code', 'Canon role.',
  'job_title', 'Job title from the Roles Library.',
  'worker_classification', 'Classification label.',
  'payment_channel', 'Payroll, Accounts Payable or None.',
  'pay_basis', 'Pay basis.',
  'arrangement', 'Arrangement.',
  'rate_card_id', 'Canon rate card the combination identifies; NULL for unpaid engagements.',
  'rate_minor', 'Rate in force in minor units; NULL when masked, unpaid or unpriced.',
  'rate_currency_code', 'Currency of the rate in force.',
  'is_masked', 'True when the rate is withheld from the caller.',
  'ot_multiplier', 'Overtime multiplier of the rule in force.',
  'dt_multiplier', 'Double-time multiplier of the rule in force.',
  'employment_status', 'Employment status.',
  'flsa_status', 'FLSA status.',
  'labor_agreement_id', 'Labor agreement.',
  'start_date', 'First day.',
  'end_date', 'Last day.',
  'engagement_state', 'Engagement state.'
]);

revoke all on app.engagement_resolved from public, anon;
grant select on app.engagement_resolved to authenticated, service_role;

-- Function privileges ---------------------------------------------------------------------------------------

revoke all on function private.engagement_compliance() from public, anon, authenticated;
revoke all on function private.guard_engagement() from public, anon, authenticated;
revoke all on function private.guard_engagement_document() from public, anon, authenticated;
revoke all on function app.transition_engagement(uuid, app.engagement_state, app.engagement_state, text) from public, anon;
revoke all on function app.transition_engagement_document(uuid, app.engagement_document_state, app.engagement_document_state, text) from public, anon;
grant execute on function app.transition_engagement(uuid, app.engagement_state, app.engagement_state, text) to authenticated, service_role;
grant execute on function app.transition_engagement_document(uuid, app.engagement_document_state, app.engagement_document_state, text) to authenticated, service_role;
