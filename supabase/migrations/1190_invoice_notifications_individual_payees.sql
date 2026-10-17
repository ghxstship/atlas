-- Integration of A43 and A44 (orchestrator): invoice step notifications reach individual payees.
--
-- A44 (1131) notifies the account that billed a payable invoice, found through its counterparty. A43 (1120)
-- lets a person engaged as an individual be the payee, with no counterparty, so those invoices notified
-- nobody. The payee person is now notified directly; account-billed invoices keep notifying the account's
-- Owner, Admin and Finance members.

create or replace function private.notify_invoice_party(p_invoice_id uuid, p_kind text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice record;
  v_person uuid;
  v_sent integer := 0;
begin
  select i.id, i.org_id, i.project_id, i.direction, i.invoice_number, i.payee_person_id,
    c.organization_id as account_id, o.name as org_name, p.name as project_name
  into v_invoice
  from app.invoices i
  left join app.counterparties c on c.id = i.counterparty_id
  join app.organizations o on o.id = i.org_id
  join app.projects p on p.id = i.project_id
  where i.id = p_invoice_id and i.deleted_at is null;
  if v_invoice.id is null or v_invoice.direction <> 'Payable'
     or (v_invoice.account_id is null and v_invoice.payee_person_id is null) then
    return 0;
  end if;
  for v_person in
    select v_invoice.payee_person_id where v_invoice.payee_person_id is not null
    union
    select distinct m.person_id from app.account_memberships m
    join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
    where v_invoice.account_id is not null
      and m.org_id = v_invoice.account_id and m.deleted_at is null and m.valid_from <= now()
      and (m.valid_to is null or m.valid_to > now())
      and r.account_role in ('Account Owner', 'Account Admin', 'Account Finance')
  loop
    if private.notify(v_invoice.org_id, v_person, p_kind, 'invoices', v_invoice.id, v_invoice.project_id,
         jsonb_build_object('title', v_invoice.invoice_number, 'actorName', v_invoice.org_name, 'orgName', v_invoice.org_name,
           'projectName', v_invoice.project_name, 'gatewayPath', '/money/invoices')) is not null then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end;
$$;

comment on function private.notify_invoice_party(uuid, text) is 'Notifies the party that billed a payable invoice of one of its steps (invoice.submitted, invoice.approved, invoice.scheduled, invoice.paid): the payee person for an individual, or the billing account''s Owner, Admin and Finance members. Message arguments carry display values only. Returns how many people were notified.';
