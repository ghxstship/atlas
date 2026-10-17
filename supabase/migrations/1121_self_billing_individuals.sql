-- 1121_self_billing_individuals.sql
-- A43 (RRR-87), finding A38-007. Self-billing reaches people engaged as individuals, and bills accepted
-- milestones as well as approved timesheets (Section 4.4.5):
--   * app.engagement_deliverables.fee_minor: the agreed price of a milestone in the engagement's currency;
--     NULL is unpriced (Section 3.7) and bills an unpriced line the org prices before approval;
--   * app.set_deliverable_fee: the org sets or clears it until the milestone is accepted;
--   * app.self_billed_deliverables: each accepted milestone is billed once while its invoice stands;
--   * app.generate_self_billed_invoice bills the engagement's account, or the engaged person when there is
--     no account, from approved timesheets and from milestones accepted in the period;
--   * app.submit_engagement_invoice lets a person engaged as an individual submit their own invoice.

-- Milestone fee ----------------------------------------------------------------------------------------------

alter table app.engagement_deliverables
  add column fee_minor bigint,
  add constraint engagement_deliverables_fee_nonnegative check (fee_minor is null or fee_minor >= 0);

comment on column app.engagement_deliverables.fee_minor is 'Agreed price of the milestone in minor units of the engagement''s currency; NULL is unpriced. Fixed once accepted; billed by self-billing.';

create or replace function app.set_deliverable_fee(p_deliverable_id uuid, p_fee_minor bigint)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.engagement_deliverables;
  v_engagement app.engagements;
begin
  perform private.require_person();
  select d.* into v_row from app.engagement_deliverables d where d.id = p_deliverable_id and d.deleted_at is null for update;
  select e.* into v_engagement from app.engagements e where e.id = v_row.engagement_id;
  if v_row.id is null or not private.can_on_project(v_engagement.project_id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  if v_row.deliverable_state = 'Accepted' then
    perform private.refuse('deliverable_fee_fixed', 'An accepted milestone keeps its fee.');
  end if;
  if p_fee_minor is not null and v_engagement.currency_code is null then
    perform private.refuse('deliverable_fee_currency', 'Set the engagement''s currency before pricing its milestones.');
  end if;
  update app.engagement_deliverables set fee_minor = p_fee_minor where id = p_deliverable_id;
  return p_deliverable_id;
end;
$$;

comment on function app.set_deliverable_fee(uuid, bigint) is 'Sets or clears (NULL, unpriced) the fee of a milestone until it is accepted. Needs opportunities.engagement.write on the project and an engagement currency for a price. Returns the deliverable id.';
revoke all on function app.set_deliverable_fee(uuid, bigint) from public, anon;
grant execute on function app.set_deliverable_fee(uuid, bigint) to authenticated, service_role;

-- Billed milestones ------------------------------------------------------------------------------------------

create table app.self_billed_deliverables (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  invoice_line_id uuid not null references app.invoice_lines (id),
  engagement_deliverable_id uuid not null references app.engagement_deliverables (id),
  constraint self_billed_deliverables_line_key unique (invoice_line_id)
);

create index self_billed_deliverables_deliverable_idx on app.self_billed_deliverables (engagement_deliverable_id);

call private.install_domain_table('app.self_billed_deliverables', 'app.invoice_lines', 'invoice_line_id',
  array['app.engagement_deliverables', 'engagement_deliverable_id'], true);
call private.describe('app.self_billed_deliverables', 'Append-only link from each self-billed invoice line to the accepted milestone it bills, so a milestone is billed once while its invoice stands.', array[
  'invoice_line_id', 'Invoice line generated for the milestone.',
  'engagement_deliverable_id', 'Accepted milestone billed.'
]);

call private.install_policies('app.self_billed_deliverables',
  $$exists (select 1 from app.invoice_lines l join app.invoices i on i.id = l.invoice_id
      where l.id = invoice_line_id and i.project_id in (select private.project_ids_with('finance.invoice.read')))$$);
revoke insert, update, delete on app.self_billed_deliverables from authenticated;

call private.install_default_retention('app.self_billed_deliverables');
call private.install_audit_trail('app.self_billed_deliverables');
