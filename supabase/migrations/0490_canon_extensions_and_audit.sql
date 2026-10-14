-- 0490_canon_extensions_and_audit.sql
-- A16 Procurement, Vendors, Knowledge and Canon (ADR 0022 range 0490 to 0499).
--   * Canon extension proposals (Section 7.2, Section 4.5.9 "read and extend"): an org proposes its
--     own discipline or category in the adopter range .50 to .99. An approved proposal is the org's
--     extension; canon (xpms) is never written. Someone other than the proposer decides
--     (sod_approval_requester).
--   * The audit trail (A18, app.audit_events) attached to every procurement, vendor and knowledge
--     table, so each insert, update and soft delete is a compliance event with a diff that leaves out
--     Restricted columns.

-- Enums and rules ----------------------------------------------------------------------------------

create type app.canon_extension_level as enum ('Discipline', 'Category');
comment on type app.canon_extension_level is 'Canon level an org extension adds to: a discipline DDDD.DD under a department, or a category DDDD.DD.DD under a discipline.';

create type app.canon_extension_state as enum ('Proposed', 'Approved', 'Rejected', 'Withdrawn');
comment on type app.canon_extension_state is 'Canon extension proposal states: Proposed until decided; Approved makes it the org''s extension; Rejected and Withdrawn are final.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('canon_extension', 'Proposed', 'Approved'),
  ('canon_extension', 'Proposed', 'Rejected'),
  ('canon_extension', 'Proposed', 'Withdrawn');

insert into private.domain_event_types (code, subject, description) values
  ('canon_extension.proposed', 'canon_extension_proposals', 'An org proposed a canon extension in the .50 to .99 range.'),
  ('canon_extension.decided', 'canon_extension_proposals', 'A canon extension proposal was approved, rejected or withdrawn.');

-- Proposals -------------------------------------------------------------------------------------------

create table app.canon_extension_proposals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  extension_level app.canon_extension_level not null,
  parent_code text not null,
  proposed_code text not null,
  label text not null,
  rationale text not null,
  proposal_state app.canon_extension_state not null default 'Proposed',
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  deleted_at timestamptz,
  constraint canon_extension_proposals_label_length check (char_length(btrim(label)) between 1 and 200),
  constraint canon_extension_proposals_rationale_length check (char_length(btrim(rationale)) between 1 and 1000),
  constraint canon_extension_proposals_no_em_dash check (strpos(label, chr(8212)) = 0 and strpos(rationale, chr(8212)) = 0),
  constraint canon_extension_proposals_shape check (
    (extension_level = 'Discipline' and parent_code ~ '^[0-9]000$' and proposed_code ~ '^[0-9]{4}\.[0-9]{2}$'
      and left(proposed_code, 4) = parent_code)
    or (extension_level = 'Category' and parent_code ~ '^[0-9]{4}\.[0-9]{2}$' and proposed_code ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$'
      and left(proposed_code, 7) = parent_code)),
  constraint canon_extension_proposals_extension_range check (xpms.is_extension_urid(proposed_code)),
  constraint canon_extension_proposals_decision_pair check ((decided_by is null) = (decided_at is null))
);

create unique index canon_extension_proposals_open_code_key on app.canon_extension_proposals (org_id, proposed_code)
  where deleted_at is null and proposal_state in ('Proposed', 'Approved');
create index canon_extension_proposals_decided_by_idx on app.canon_extension_proposals (decided_by);
create index canon_extension_proposals_parent_idx on app.canon_extension_proposals (org_id, parent_code);

call private.install_domain_table('app.canon_extension_proposals');
call private.describe('app.canon_extension_proposals', 'An org''s proposed canon extensions (Section 7.2): disciplines and categories in the adopter range .50 to .99. An Approved row is the org''s extension; canon in xpms is never written. Decided through app.decide_canon_extension by someone other than the proposer.', array[
  'extension_level', 'Discipline or Category.',
  'parent_code', 'Canon department (for a discipline) or discipline (for a category) the extension sits under; a category may also sit under the org''s own approved discipline.',
  'proposed_code', 'Code of the extension; its discipline or category segment is in .50 to .99 and it is not already canon.',
  'label', 'Label in Title Case.',
  'rationale', 'Why the org needs the extension.',
  'proposal_state', 'Proposal state. Changes only through app.decide_canon_extension.',
  'decided_by', 'Person who approved or rejected the proposal.',
  'decided_at', 'When the proposal was approved or rejected.'
]);

call private.install_lifecycle('app.canon_extension_proposals', 'canon_extension_proposal_id', 'proposal_state',
  'canon_extension', 'Proposed',
  $$org_id in (select private.orgs_with_capability('canon.taxonomy.read'))$$);

create or replace function private.guard_canon_extension_proposal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_ok boolean;
begin
  if tg_op = 'INSERT' then
    if new.decided_by is not null then
      perform private.refuse('canon_extension_decide_rpc', 'A canon extension proposal is decided through app.decide_canon_extension.');
    end if;
    if new.extension_level = 'Discipline' then
      if exists (select 1 from xpms.dim_discipline d where d.disc_code = new.proposed_code) then
        perform private.refuse('canon_extension_exists', 'The code is already canon; propose another code in .50 to .99.');
      end if;
      v_parent_ok := exists (select 1 from xpms.dim_department d where d.dept_code = new.parent_code);
    else
      if exists (select 1 from xpms.dim_category c where c.cat_urid = new.proposed_code) then
        perform private.refuse('canon_extension_exists', 'The code is already canon; propose another code in .50 to .99.');
      end if;
      v_parent_ok := exists (select 1 from xpms.dim_discipline d where d.disc_code = new.parent_code)
        or exists (select 1 from app.canon_extension_proposals p
                   where p.org_id = new.org_id and p.extension_level = 'Discipline' and p.proposed_code = new.parent_code
                     and p.proposal_state = 'Approved' and p.deleted_at is null);
    end if;
    if not v_parent_ok then
      perform private.refuse('canon_extension_parent', 'The parent is neither canon nor one of the org''s approved extensions.');
    end if;
    return new;
  end if;
  if new.extension_level <> old.extension_level or new.parent_code <> old.parent_code or new.proposed_code <> old.proposed_code then
    perform private.refuse('canon_extension_immutable', 'A proposal keeps its level, parent and code; withdraw it and propose again.');
  end if;
  if (new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at)
     and not private.in_trusted_operation('canon_extension_decision') then
    perform private.refuse('canon_extension_decide_rpc', 'A canon extension proposal is decided through app.decide_canon_extension.');
  end if;
  if old.proposal_state <> 'Proposed' and (new.label <> old.label or new.rationale <> old.rationale) then
    perform private.refuse('canon_extension_locked', 'A decided proposal never changes.');
  end if;
  return new;
end;
$$;

comment on function private.guard_canon_extension_proposal() is 'Canon extension proposals: code not already canon, parent canon or an approved org discipline, level and code fixed, decisions only through the RPC, frozen once decided.';

create trigger t40_guard_canon_extension_proposal before insert or update on app.canon_extension_proposals
  for each row execute function private.guard_canon_extension_proposal();

create trigger t90_emit_canon_extension_proposed after insert on app.canon_extension_state_transitions
  for each row when (new.from_state is null)
  execute function private.emit_subject_event('canon_extension.proposed', 'canon_extension_proposals', 'canon_extension_proposal_id', 'to_state');
create trigger t90_emit_canon_extension_decided after insert on app.canon_extension_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('canon_extension.decided', 'canon_extension_proposals', 'canon_extension_proposal_id', 'from_state', 'to_state', 'reason');

create or replace function app.decide_canon_extension(
  p_proposal_id uuid,
  p_expected app.canon_extension_state,
  p_next app.canon_extension_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.canon_extension_proposals;
  v_entry uuid;
begin
  select * into v_row from app.canon_extension_proposals p where p.id = p_proposal_id and p.deleted_at is null for update;
  if v_row.id is null or not private.has_capability(v_row.org_id, 'canon.extension.write') then
    raise exception using errcode = '42501', message = 'canon.extension.write is required';
  end if;
  if p_next in ('Approved', 'Rejected') then
    perform private.assert_separation('sod_approval_requester', v_person, v_row.created_by);
  end if;
  if p_next = 'Approved' and (
       (v_row.extension_level = 'Discipline' and exists (select 1 from xpms.dim_discipline d where d.disc_code = v_row.proposed_code))
       or (v_row.extension_level = 'Category' and exists (select 1 from xpms.dim_category c where c.cat_urid = v_row.proposed_code))) then
    perform private.refuse('canon_extension_exists', 'The code became canon after it was proposed; reject the proposal.');
  end if;
  v_entry := private.transition_lifecycle('canon_extension', 'app.canon_extension_proposals', 'proposal_state',
    'app.canon_extension_state_transitions', 'canon_extension_proposal_id', p_proposal_id, p_expected::text, p_next::text, p_reason);
  if p_next in ('Approved', 'Rejected') then
    perform private.begin_trusted_operation('canon_extension_decision');
    update app.canon_extension_proposals set decided_by = v_person, decided_at = now() where id = p_proposal_id;
    perform private.end_trusted_operation('canon_extension_decision');
  end if;
  return v_entry;
end;
$$;

comment on function app.decide_canon_extension(uuid, app.canon_extension_state, app.canon_extension_state, text) is 'Approves, rejects or withdraws a canon extension proposal with compare-and-set: canon.extension.write; approving or rejecting is never done by the proposer (sod_approval_requester); a code that became canon cannot be approved. Never writes xpms.';

call private.install_policies('app.canon_extension_proposals',
  $$org_id in (select private.orgs_with_capability('canon.taxonomy.read'))$$,
  $$org_id in (select private.orgs_with_capability('canon.extension.write'))$$);

call private.install_default_retention('app.canon_extension_proposals');
call private.install_default_retention('app.canon_extension_state_transitions');

revoke all on function private.guard_canon_extension_proposal() from public, anon, authenticated;
revoke all on function app.decide_canon_extension(uuid, app.canon_extension_state, app.canon_extension_state, text) from public, anon;
grant execute on function app.decide_canon_extension(uuid, app.canon_extension_state, app.canon_extension_state, text) to authenticated, service_role;

-- Audit trail (A18 app.audit_events) -------------------------------------------------------------------

call private.install_audit_trail('app.canon_extension_proposals');
call private.install_audit_trail('app.vendors');
call private.install_audit_trail('app.vendor_classes');
call private.install_audit_trail('app.vendor_class_assignments');
call private.install_audit_trail('app.vendor_bank_accounts');
call private.install_audit_trail('app.prequalifications');
call private.install_audit_trail('app.insurance_certificates');
call private.install_audit_trail('app.vendor_scorecards');
call private.install_audit_trail('app.sponsor_entitlements');
call private.install_audit_trail('app.rfqs');
call private.install_audit_trail('app.rfq_invitations');
call private.install_audit_trail('app.rfq_responses');
call private.install_audit_trail('app.rfq_response_lines');
call private.install_audit_trail('app.purchase_orders');
call private.install_audit_trail('app.po_lines');
call private.install_audit_trail('app.po_change_orders');
call private.install_audit_trail('app.goods_receipts');
call private.install_audit_trail('app.receipt_lines');
call private.install_audit_trail('app.invoice_matches');
call private.install_audit_trail('app.catalog_bindings');
call private.install_audit_trail('app.vendor_products');
call private.install_audit_trail('app.sops');
call private.install_audit_trail('app.sop_acknowledgments');
call private.install_audit_trail('app.documents');
call private.install_audit_trail('app.document_versions');
call private.install_audit_trail('app.verbiage_terms');
