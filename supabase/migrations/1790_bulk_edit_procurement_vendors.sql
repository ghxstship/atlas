-- 1790_bulk_edit_procurement_vendors.sql
-- A120 (RRR-165, A65-006, ADR 0044). Bulk edit (Section 11.7) reaches the Purchase orders, RFQs and Vendor directory
-- collections: three more resources on the driver of 1451, private.run_bulk, so each call keeps its rules. All or
-- nothing, a preview that always undoes, the capability checked on every row, refusals naming the row, the inverse rows
-- that undo a call, and one <resource>.bulk_update audit event per org.
--
--   * Purchase orders: state. Approving goes through app.approve_purchase_order, so every rule of a single approval
--     holds for each row: finance.po.approve on the project, never by the order's creator (the 0320 separation rule),
--     a fully priced order, an Active approval policy's approval first, and spend authority (the approver's limit, and
--     two approvers above the dual threshold). An order that still needs another approver is refused, so a bulk
--     approval approves every row or none, as invoices do (1451). Sending, closing and cancelling go through
--     app.transition_purchase_order (procurement.po.send or procurement.po.write).
--   * RFQs: state through app.transition_rfq: issuing needs procurement.rfq.issue and an invited vendor, closing (which
--     unseals the responses) procurement.bid.unseal, cancelling procurement.rfq.write. Awarding picks a winner after
--     comparing quotes, so it stays a single move.
--   * Vendors: state through app.transition_vendor, payment terms and the default currency. Every row needs
--     vendors.vendor.write, as the update policy does. Bank accounts live in their own table and are not editable here.
--   * Goods receipts have no state and their receiver never changes (0331), so they have no bulk resource.
--   * Row functions run with owner rights, so each checks the caller's capability on the row the way the table's
--     policies do, and every guard trigger still applies. The approval, separation of duties and spend authority
--     functions are called, never redefined, and neither are the driver, its helpers or the 1451 row functions.
--   * The three tables have had an audit trail since 0995, so each row change and its undo reaches the ledger.

-- Purchase orders ----------------------------------------------------------------------------------------------------

create or replace function private.bulk_purchase_orders_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.purchase_orders;
  v_new app.purchase_orders;
  v_state app.po_state;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.');
begin
  perform private.bulk_check_fields(p_set, p_expect, 'po_state');
  select * into v_old from app.purchase_orders po where po.id = p_id and po.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('procurement.po.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'po_state' then (p_set ->> 'po_state')::app.po_state else v_old.po_state end;
  if v_state = v_old.po_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_state = 'Approved' then
    -- The single approval RPC applies its capability, separation of duties, pricing, approval policy and spend
    -- authority. An approval that needs another approver is refused here, so the call stays all or nothing.
    if not app.approve_purchase_order(p_id, v_reason) then
      perform private.refuse('bulk_needs_further_approval', 'This purchase order needs another approver under spend authority; approve it on its own.');
    end if;
  else
    perform app.transition_purchase_order(p_id, v_old.po_state, v_state, v_reason);
  end if;
  select * into v_new from app.purchase_orders po where po.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('po_state', v_old.po_state),
    'after', jsonb_build_object('po_state', v_new.po_state));
end;
$$;

comment on function private.bulk_purchase_orders_row(uuid, jsonb, jsonb, text) is 'One purchase order of a bulk change: approve through app.approve_purchase_order with all its rules (finance.po.approve, not the creator, priced, approval policy, spend authority), or send, close or cancel through app.transition_purchase_order. An approval waiting for another approver is refused, so the call stays all or nothing.';
revoke all on function private.bulk_purchase_orders_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- RFQs ---------------------------------------------------------------------------------------------------------------

create or replace function private.bulk_rfqs_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.rfqs;
  v_new app.rfqs;
  v_state app.rfq_state;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'rfq_state');
  select * into v_old from app.rfqs r where r.id = p_id and r.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('procurement.rfq.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'rfq_state' then (p_set ->> 'rfq_state')::app.rfq_state else v_old.rfq_state end;
  if v_state = v_old.rfq_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_state = 'Awarded' then
    perform private.refuse('bulk_field_not_editable', 'Award RFQs one at a time, after comparing their quotes.');
  end if;
  perform app.transition_rfq(p_id, v_old.rfq_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  select * into v_new from app.rfqs r where r.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('rfq_state', v_old.rfq_state),
    'after', jsonb_build_object('rfq_state', v_new.rfq_state));
end;
$$;

comment on function private.bulk_rfqs_row(uuid, jsonb, jsonb, text) is 'One RFQ of a bulk change: issue (procurement.rfq.issue and an invited vendor), close and unseal (procurement.bid.unseal) or cancel (procurement.rfq.write) through app.transition_rfq. Awarding stays a single move.';
revoke all on function private.bulk_rfqs_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Vendors ------------------------------------------------------------------------------------------------------------

create or replace function private.bulk_vendors_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.vendors;
  v_new app.vendors;
  v_state app.vendor_state;
  v_terms integer;
  v_currency char(3);
  v_keys jsonb := p_set;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'vendor_state,payment_terms_days,default_currency_code');
  select * into v_old from app.vendors v where v.id = p_id and v.deleted_at is null for update;
  if v_old.id is null or v_old.org_id not in (select private.orgs_with_capability('vendors.vendor.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.org_id not in (select private.orgs_with_capability('vendors.vendor.write')) then
    raise exception using errcode = '42501', message = 'vendors.vendor.write is required.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  v_state := case when p_set ? 'vendor_state' then (p_set ->> 'vendor_state')::app.vendor_state else v_old.vendor_state end;
  v_terms := case when p_set ? 'payment_terms_days' then (p_set ->> 'payment_terms_days')::integer else v_old.payment_terms_days end;
  v_currency := case when p_set ? 'default_currency_code' then (p_set ->> 'default_currency_code')::char(3) else v_old.default_currency_code end;
  if v_state = v_old.vendor_state and v_terms is not distinct from v_old.payment_terms_days
     and v_currency is not distinct from v_old.default_currency_code then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;

  if v_terms is distinct from v_old.payment_terms_days or v_currency is distinct from v_old.default_currency_code then
    update app.vendors set payment_terms_days = v_terms, default_currency_code = v_currency where id = p_id;
  end if;
  if v_state <> v_old.vendor_state then
    perform app.transition_vendor(p_id, v_old.vendor_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  end if;

  select * into v_new from app.vendors v where v.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', private.bulk_pick(to_jsonb(v_old), v_keys), 'after', private.bulk_pick(to_jsonb(v_new), v_keys));
end;
$$;

comment on function private.bulk_vendors_row(uuid, jsonb, jsonb, text) is 'One vendor of a bulk change: state through app.transition_vendor, payment terms and the default currency. Needs vendors.vendor.write as the vendor update policy does; bank accounts are not editable in bulk.';
revoke all on function private.bulk_vendors_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('purchase_orders', 'app.purchase_orders', 'private.bulk_purchase_orders_row'),
  ('rfqs', 'app.rfqs', 'private.bulk_rfqs_row'),
  ('vendors', 'app.vendors', 'private.bulk_vendors_row');

-- App RPCs -----------------------------------------------------------------------------------------------------------

create or replace function app.bulk_update_purchase_orders(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('purchase_orders', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_purchase_orders(jsonb, boolean, text) is 'Approves, sends, closes or cancels purchase orders in bulk in one transaction (Section 11.7), every rule of a single approval (separation of duties, approval policy, spend authority) applying to each row, with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_rfqs(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('rfqs', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_rfqs(jsonb, boolean, text) is 'Issues, closes or cancels RFQs in bulk in one transaction (Section 11.7), every rule of a single move applying to each row, with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_vendors(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('vendors', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_vendors(jsonb, boolean, text) is 'Changes vendors in bulk in one transaction (Section 11.7): rows as [{id, set, expect}] with state, payment terms or default currency. Needs vendors.vendor.write; answers as app.bulk_update_records.';

revoke all on function app.bulk_update_purchase_orders(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_rfqs(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_vendors(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_purchase_orders(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_rfqs(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_vendors(jsonb, boolean, text) to authenticated, service_role;
