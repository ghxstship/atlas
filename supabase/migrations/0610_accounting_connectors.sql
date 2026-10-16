-- 0610_accounting_connectors.sql
-- A19 Integrations. Accounting connectors (Section 17: Xero, QuickBooks Online, NetSuite, Ramp):
--   * app.integration_account_mappings: the fixed chart's GL accounts mapped to the provider's accounts,
--     so a Universal Posting Line projects without guessing (D13: GL accounts come from the chart)
--   * app.integration_ledger_queue: posted UPL lines of journal entries not yet exported to a connection
--   * app.integration_payment_queue: Approved payments not yet pushed to a connection
--   * app.record_provider_payment: the runner's idempotent intake of a payment the provider recorded; it
--     lands Proposed, so a person still approves it under separation of duties (Section 8.2)

-- Account mappings --------------------------------------------------------------------------------------------------

create table app.integration_account_mappings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  account_code text not null references xpms.dim_gl_account (account_code),
  external_account_id text not null,
  external_tax_code text,
  deleted_at timestamptz,
  constraint integration_account_mappings_external_length check (char_length(btrim(external_account_id)) between 1 and 255),
  constraint integration_account_mappings_tax_length check (external_tax_code is null or char_length(btrim(external_tax_code)) between 1 and 100)
);

create index integration_account_mappings_connection_idx on app.integration_account_mappings (integration_connection_id);
create index integration_account_mappings_account_code_idx on app.integration_account_mappings (account_code);
create unique index integration_account_mappings_account_key on app.integration_account_mappings (integration_connection_id, account_code)
  where deleted_at is null;

call private.install_domain_table('app.integration_account_mappings', 'app.integration_connections', 'integration_connection_id');
call private.describe('app.integration_account_mappings', 'GL accounts of the fixed chart mapped to an accounting connection''s accounts. A journal whose lines use an unmapped account is not exported; the run records an account_unmapped error instead of guessing.', array[
  'integration_connection_id', 'Accounting connection.',
  'account_code', 'GL account of the fixed chart (xpms.dim_gl_account).',
  'external_account_id', 'Provider account identifier or code.',
  'external_tax_code', 'Provider tax rate or code applied to lines of the account, when the provider needs one.'
]);

call private.install_policies('app.integration_account_mappings',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

create or replace function private.guard_integration_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category app.integration_category;
begin
  select p.category into v_category
  from app.integration_connections c join private.integration_providers p on p.provider_code = c.provider_code
  where c.id = new.integration_connection_id;
  if v_category::text <> tg_argv[0] then
    perform private.refuse('integration_category_mismatch',
      format('%s rows belong to a %s connection, not a %s connection.', tg_table_name, tg_argv[0], v_category));
  end if;
  return new;
end;
$$;

comment on function private.guard_integration_category() is 'Before insert or update trigger: the row''s connection must belong to the category named by the trigger argument.';

create trigger t40_guard_integration_account_mapping before insert or update of integration_connection_id on app.integration_account_mappings
  for each row execute function private.guard_integration_category('Accounting');

-- Export queues ---------------------------------------------------------------------------------------------------------

create view app.integration_ledger_queue with (security_invoker = true) as
select c.id as integration_connection_id, c.org_id, jl.journal_entry_id, je.memo, pl.posting_line_id, jl.line_number,
  pl.date, pl.project_id, pl.account_code, pl.cost_center_id as cost_center_code, pl.urid, pl.vendor_id as counterparty_id,
  pl.description, pl.quantity, pl.unit_basis, pl.amount_minor, pl.currency as currency_code, cur.minor_unit_exponent, pl.tax_type
from app.integration_connections c
join app.integration_providers p on p.provider_code = c.provider_code and p.category = 'Accounting'
join app.posting_lines pl on pl.org_id = c.org_id
join app.journal_lines jl on jl.id = pl.posting_line_id
join app.journal_entries je on je.id = jl.journal_entry_id
join app.currencies cur on cur.currency_code = pl.currency
where c.deleted_at is null and c.connection_state = 'Connected'
  and not exists (
    select 1 from app.integration_external_ids x
    where x.integration_connection_id = c.id and x.entity = 'Journal Entry' and x.local_id = jl.journal_entry_id and x.deleted_at is null);

call private.describe('app.integration_ledger_queue', 'Universal Posting Lines (Section 3.11) of posted journal entries that a Connected accounting connection has not exported yet. The connector exports each journal entry whole, then maps it in app.integration_external_ids, which removes its lines from the queue.', array[
  'integration_connection_id', 'Accounting connection to export to.',
  'org_id', 'Org of the posting.',
  'journal_entry_id', 'Journal entry the line belongs to; the unit of export.',
  'memo', 'Journal entry memo.',
  'posting_line_id', 'Journal line.',
  'line_number', 'Line number within the entry.',
  'date', 'Recognition date.',
  'project_id', 'Project of the entry, when it has one.',
  'account_code', 'GL account from the fixed chart.',
  'cost_center_code', 'Dimension 1 cost center code.',
  'urid', 'Dimension 2 discipline or category.',
  'counterparty_id', 'Counterparty of the line.',
  'description', 'Line description.',
  'quantity', 'Quantity.',
  'unit_basis', 'Unit.',
  'amount_minor', 'Signed amount in minor units: debits positive, credits negative.',
  'currency_code', 'ISO 4217 currency of the line.',
  'minor_unit_exponent', 'Decimal places of the currency''s minor unit.',
  'tax_type', 'Tax type of the account.'
]);

revoke all on app.integration_ledger_queue from public, anon;
grant select on app.integration_ledger_queue to authenticated, service_role;

create view app.integration_payment_queue with (security_invoker = true) as
select c.id as integration_connection_id, c.org_id, pay.id as payment_id, pay.counterparty_id, cx.external_id as counterparty_external_id,
  pay.direction, pay.amount_minor, pay.currency_code, cur.minor_unit_exponent, pay.paid_on, pay.reference_identifier
from app.integration_connections c
join app.integration_providers p on p.provider_code = c.provider_code and p.category = 'Accounting'
join app.payments pay on pay.org_id = c.org_id and pay.payment_state = 'Approved' and pay.deleted_at is null
join app.currencies cur on cur.currency_code = pay.currency_code
left join app.integration_external_ids cx on cx.integration_connection_id = c.id and cx.entity = 'Counterparty'
  and cx.local_id = pay.counterparty_id and cx.deleted_at is null
where c.deleted_at is null and c.connection_state = 'Connected'
  and not exists (
    select 1 from app.integration_external_ids x
    where x.integration_connection_id = c.id and x.entity = 'Payment' and x.local_id = pay.id and x.deleted_at is null);

call private.describe('app.integration_payment_queue', 'Approved payments a Connected accounting connection has not received yet, with the counterparty''s provider contact when it is mapped.', array[
  'integration_connection_id', 'Accounting connection to push to.',
  'org_id', 'Org of the payment.',
  'payment_id', 'Payment.',
  'counterparty_id', 'Counterparty paid or paying.',
  'counterparty_external_id', 'Provider contact of the counterparty, or NULL when it is not mapped yet.',
  'direction', 'Payable or Receivable.',
  'amount_minor', 'Amount in minor units.',
  'currency_code', 'ISO 4217 currency.',
  'minor_unit_exponent', 'Decimal places of the currency''s minor unit.',
  'paid_on', 'Date the money moved.',
  'reference_identifier', 'Bank or card reference.'
]);

revoke all on app.integration_payment_queue from public, anon;
grant select on app.integration_payment_queue to authenticated, service_role;

-- Inbound payments -------------------------------------------------------------------------------------------------------

create or replace function app.record_provider_payment(
  p_connection_id uuid,
  p_external_id text,
  p_counterparty_external_id text,
  p_direction app.money_direction,
  p_amount_minor bigint,
  p_currency_code char(3),
  p_paid_on date,
  p_reference text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
  v_category app.integration_category;
  v_counterparty uuid;
  v_payment uuid;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  if v_connection.id is null then
    raise exception using errcode = '42501', message = 'the connection does not exist';
  end if;
  select p.category into v_category from private.integration_providers p where p.provider_code = v_connection.provider_code;
  if v_category <> 'Accounting' then
    perform private.refuse('integration_category_mismatch', 'Provider payments arrive only through an accounting connection.');
  end if;
  select x.local_id into v_payment from app.integration_external_ids x
  where x.integration_connection_id = p_connection_id and x.entity = 'Payment' and x.external_id = p_external_id and x.deleted_at is null;
  if v_payment is not null then
    return v_payment;
  end if;
  select x.local_id into v_counterparty from app.integration_external_ids x
  where x.integration_connection_id = p_connection_id and x.entity = 'Counterparty' and x.external_id = p_counterparty_external_id
    and x.deleted_at is null;
  if v_counterparty is null then
    perform private.refuse('counterparty_unmapped', format('Provider contact %s is not mapped to a counterparty.', p_counterparty_external_id));
  end if;
  insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on, reference_identifier)
  values (v_counterparty, p_direction, p_amount_minor, p_currency_code, p_paid_on, p_reference)
  returning id into v_payment;
  insert into app.integration_external_ids (integration_connection_id, entity, local_id, external_id)
  values (p_connection_id, 'Payment', v_payment, p_external_id);
  return v_payment;
end;
$$;

comment on function app.record_provider_payment(uuid, text, text, app.money_direction, bigint, char, date, text) is 'Runner: records a payment the accounting provider holds as a Proposed payment of the mapped counterparty and maps it, once per provider payment. A person approves it under separation of duties. Service role only.';

-- Privileges and retention ------------------------------------------------------------------------------------------------

revoke all on function private.guard_integration_category() from public, anon, authenticated;
revoke all on function app.record_provider_payment(uuid, text, text, app.money_direction, bigint, char, date, text) from public, anon, authenticated;
grant execute on function app.record_provider_payment(uuid, text, text, app.money_direction, bigint, char, date, text) to service_role;

call private.install_default_retention('app.integration_account_mappings');
