-- pgTAP: migration 6538 (B11, G-196), quote chasing. The interval, limit, response, state, due date and off rules, the final
-- 24 hours, running twice, Not Awarded with a split award and a non-responder, no account, the seal while Issued including
-- one invited vendor, RFQs from before release, the Gateway landing in every state, and the cron job.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 6531_supply_world.psql

select no_plan();

create function pg_temp.rfq(p_key text, p_vendors text[], p_due timestamptz default null, p_issue boolean default true) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.rfqs (project_id, title, responses_due_at) values (pg_temp.id('prj_a'), p_key || ' cables', p_due) returning id into v_id;
  insert into world values (p_key, v_id);
  insert into app.rfq_lines (rfq_id, description, quantity) values (v_id, 'Stage cable', 20);
  insert into app.rfq_invitations (rfq_id, vendor_id) select v_id, pg_temp.id(v) from unnest(p_vendors) v;
  if p_issue then
    perform pg_temp.as_user('alice');
    perform app.transition_rfq(v_id, 'Proposed', 'Issued', 'Go.');
  end if;
  perform pg_temp.as_platform();
  return v_id;
end $$;
create function pg_temp.setting(p_key text, p_integer bigint, p_boolean boolean default null) returns void language plpgsql as $$
begin
  perform pg_temp.as_platform();
  delete from app.setting_values where setting_key = p_key and org_id = pg_temp.id('org_a');
  insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_integer, value_boolean)
  values (pg_temp.id('org_a'), p_key, 'Organization', pg_temp.id('org_a'), p_integer, p_boolean);
end $$;
create function pg_temp.notices(p_rfq text, p_kind text default null) returns integer language sql security definer as $$
  select count(*)::integer from app.rfq_supplier_notices n where n.rfq_id = pg_temp.id(p_rfq) and (p_kind is null or n.notice_kind::text = p_kind)
$$;
create function pg_temp.sent(p_rfq text, p_kind text) returns integer language sql security definer as $$
  select count(*)::integer from app.notifications n where n.subject_id = pg_temp.id(p_rfq) and n.kind = p_kind
$$;

-- 1. The interval and the limit -------------------------------------------------------------------------------------------------------------
select pg_temp.rfq('rq1', array['ven_v']);
select is(private.send_rfq_supplier_notices(), 0, 'nothing is due before the interval');
select ok(private.send_rfq_supplier_notices(now() + interval '49 hours') > 0, 'after 49 hours the reminder goes');
select is(pg_temp.sent('rq1', 'rfq.quote_reminder'), 1, 'to the vendor''s owner');
select is((select recipient_person_id from app.notifications where subject_id = pg_temp.id('rq1') and kind = 'rfq.quote_reminder'), pg_temp.id('victor'), 'victor');
select is(private.send_rfq_supplier_notices(now() + interval '49 hours 30 minutes'), 0, 'a second run sends nothing');
select is(pg_temp.notices('rq1'), 1, 'the ledger holds one row');
select is((select message_args ->> 'gatewayPath' from app.notifications where subject_id = pg_temp.id('rq1') and kind = 'rfq.quote_reminder'), '/work/quote-requests', 'an outside recipient''s link opens Gateway');
select set_eq($$select k from app.notifications n cross join lateral jsonb_object_keys(n.message_args) k where n.subject_id = pg_temp.id('rq1') and n.kind = 'rfq.quote_reminder' and k <> 'actorName'$$,
  $$values ('title'), ('orgName'), ('projectName'), ('dueDate'), ('gatewayPath')$$, 'args hold the title, names, due date and path only');
-- Interval counts from the last reminder.
select is(private.send_rfq_supplier_notices(now() + interval '60 hours'), 0, 'not again inside the interval');

-- 2. Off, responses, state, past due ----------------------------------------------------------------------------------------------------------
select pg_temp.rfq('r_off', array['ven_v']);
select pg_temp.setting('procurement.quote_chase_enabled', null, false);
select pg_temp.as_platform();
select is(private.send_rfq_supplier_notices(now() + interval '200 hours'), 0, 'disabled sends nothing');
select pg_temp.setting('procurement.quote_chase_enabled', null, true);
select pg_temp.setting('procurement.quote_chase_limit', 2);
select pg_temp.as_platform();
select ok(private.send_rfq_supplier_notices(now() + interval '500 hours') > 0, 'on again, they go');
select is(pg_temp.notices('r_off'), 1, 'one each');
select ok(private.send_rfq_supplier_notices(now() + interval '1000 hours') > 0, 'the second reminder goes');
select is(pg_temp.notices('r_off'), 2, 'up to the limit of 2');
select is(private.send_rfq_supplier_notices(now() + interval '1500 hours'), 0, 'and stops at it');
select pg_temp.setting('procurement.quote_chase_limit', 3);

-- A shorter interval comes sooner.
select pg_temp.rfq('r_soon', array['ven_v']);
select pg_temp.setting('procurement.quote_chase_interval_hours', 12);
select pg_temp.as_platform();
select private.send_rfq_supplier_notices(now() + interval '13 hours');
select is(pg_temp.notices('r_soon'), 1, 'the interval setting decides when the first reminder goes');
select pg_temp.setting('procurement.quote_chase_interval_hours', 48);

select pg_temp.rfq('r_resp', array['ven_v']);
select pg_temp.as_user('carol');
select app.record_rfq_response(pg_temp.id('r_resp'), pg_temp.id('ven_v'), null, 'USD', '[{"description":"Cable","quantity":20,"unit_price_minor":100}]');
select pg_temp.rfq('r_closed', array['ven_v']);
select pg_temp.as_user('alice');
select app.transition_rfq(pg_temp.id('r_closed'), 'Issued', 'Closed', 'Done.');
select pg_temp.rfq('r_past', array['ven_v'], now() + interval '10 hours');
select pg_temp.as_platform();
select private.send_rfq_supplier_notices(now() + interval '2000 hours');
select is(pg_temp.notices('r_resp'), 0, 'a vendor that responded is not chased');
select is(pg_temp.notices('r_closed'), 0, 'nor one on an RFQ that left Issued');
select is(pg_temp.notices('r_past'), 0, 'nor past due');

-- 3. The final 24 hours -----------------------------------------------------------------------------------------------------------------------
select pg_temp.rfq('r_last', array['ven_v'], now() + interval '30 hours');
select private.send_rfq_supplier_notices(now() + interval '1 hour');
select is(pg_temp.notices('r_last'), 0, 'not yet at an hour, 29 hours before due');
select private.send_rfq_supplier_notices(now() + interval '7 hours');
select is(pg_temp.notices('r_last'), 1, 'the final reminder goes inside the last 24 hours though the interval has not passed');
select private.send_rfq_supplier_notices(now() + interval '9 hours');
select is(pg_temp.notices('r_last'), 1, 'once');
select is((select message_args ->> 'dueDate' from app.notifications where subject_id = pg_temp.id('r_last') and kind = 'rfq.quote_reminder' limit 1),
  to_char((now() + interval '30 hours') at time zone 'America/New_York', 'YYYY-MM-DD'), 'the due date is on the project''s calendar');

-- 4. Not Awarded -----------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_t'));
insert into world select 'cp_t', c.id from app.counterparties c where c.organization_id = pg_temp.id('acct_t') and c.org_id = pg_temp.id('org_a');
insert into app.vendors (counterparty_id) values (pg_temp.id('cp_t'));
insert into world select 'ven_t', v.id from app.vendors v where v.counterparty_id = pg_temp.id('cp_t');
select app.transition_vendor(pg_temp.id('ven_t'), 'Prospect', 'Onboarded', 'Paperwork in.');
select app.transition_vendor(pg_temp.id('ven_t'), 'Onboarded', 'Active', 'Approved for use.');

select pg_temp.rfq('r_a', array['ven', 'ven_v', 'ven_t']);
select pg_temp.as_user('carol');
select app.record_rfq_response(pg_temp.id('r_a'), pg_temp.id('ven_v'), null, 'USD', '[{"description":"Cable","quantity":20,"unit_price_minor":100}]');
select app.record_rfq_response(pg_temp.id('r_a'), pg_temp.id('ven_t'), null, 'USD', '[{"description":"Cable","quantity":20,"unit_price_minor":120}]');
select pg_temp.as_user('alice');
select app.transition_rfq(pg_temp.id('r_a'), 'Issued', 'Closed', 'Quotes in.');
select app.transition_rfq(pg_temp.id('r_a'), 'Closed', 'Awarded', 'Awarded.');
select pg_temp.as_platform();
select private.send_rfq_supplier_notices();
select is(pg_temp.notices('r_a', 'Not Awarded'), 0, 'nothing before an order from the RFQ is approved');
-- ven_t wins.
select pg_temp.as_platform();
insert into world select 'resp_v', s.id from app.rfq_responses s where s.rfq_id = pg_temp.id('r_a') and s.vendor_id = pg_temp.id('ven_v');
insert into world select 'resp_t', s.id from app.rfq_responses s where s.rfq_id = pg_temp.id('r_a') and s.vendor_id = pg_temp.id('ven_t');
select pg_temp.as_user('carol');
insert into app.purchase_orders (project_id, vendor_id, currency_code, rfq_response_id) values (pg_temp.id('prj_a'), pg_temp.id('ven_t'), 'USD', pg_temp.id('resp_t'));
insert into world select 'po_t', po.id from app.purchase_orders po where po.rfq_response_id = pg_temp.id('resp_t');
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po_t'), 1, 'Cable', 20, 120);
select pg_temp.approve_order('po_t', false);
select pg_temp.as_platform();
select ok(private.send_rfq_supplier_notices() > 0, 'once an order is Approved, the loser hears');
select is(pg_temp.sent('r_a', 'rfq.not_awarded'), 1, 'exactly one notice');
select is((select recipient_person_id from app.notifications where subject_id = pg_temp.id('r_a') and kind = 'rfq.not_awarded'), pg_temp.id('victor'), 'to the responder with no order');
select is((select count(*)::integer from app.rfq_supplier_notices n where n.rfq_id = pg_temp.id('r_a') and n.vendor_id = pg_temp.id('ven')), 0, 'a non-responder hears nothing');
select is((select count(*)::integer from app.rfq_supplier_notices n where n.rfq_id = pg_temp.id('r_a') and n.vendor_id = pg_temp.id('ven_t')), 0, 'nor the winner');
select is(private.send_rfq_supplier_notices(), 0, 'and running again sends nothing');
select set_eq($$select k from app.notifications n cross join lateral jsonb_object_keys(n.message_args) k where n.subject_id = pg_temp.id('r_a') and n.kind = 'rfq.not_awarded' and k <> 'actorName'$$,
  $$values ('title'), ('orgName'), ('projectName'), ('gatewayPath')$$, 'no price, winner or other vendor in its args, and a Gateway link for an outside vendor');

-- A split-award vendor with a Proposed order is not told it lost.
select pg_temp.rfq('r_split', array['ven_v', 'ven_t']);
select pg_temp.as_user('carol');
select app.record_rfq_response(pg_temp.id('r_split'), pg_temp.id('ven_v'), null, 'USD', '[{"description":"Cable","quantity":20,"unit_price_minor":100}]');
select app.record_rfq_response(pg_temp.id('r_split'), pg_temp.id('ven_t'), null, 'USD', '[{"description":"Cable","quantity":20,"unit_price_minor":120}]');
select pg_temp.as_user('alice');
select app.transition_rfq(pg_temp.id('r_split'), 'Issued', 'Closed', 'Quotes in.');
select app.transition_rfq(pg_temp.id('r_split'), 'Closed', 'Awarded', 'Both.');
select pg_temp.as_platform();
insert into world select 'rs_v', s.id from app.rfq_responses s where s.rfq_id = pg_temp.id('r_split') and s.vendor_id = pg_temp.id('ven_v');
insert into world select 'rs_t', s.id from app.rfq_responses s where s.rfq_id = pg_temp.id('r_split') and s.vendor_id = pg_temp.id('ven_t');
select pg_temp.as_user('carol');
insert into app.purchase_orders (project_id, vendor_id, currency_code, rfq_response_id) values (pg_temp.id('prj_a'), pg_temp.id('ven_v'), 'USD', pg_temp.id('rs_v'));
insert into world select 'po_sv', po.id from app.purchase_orders po where po.rfq_response_id = pg_temp.id('rs_v');
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('po_sv'), 1, 'Cable', 20, 100);
insert into app.purchase_orders (project_id, vendor_id, currency_code, rfq_response_id) values (pg_temp.id('prj_a'), pg_temp.id('ven_t'), 'USD', pg_temp.id('rs_t'));
select pg_temp.approve_order('po_sv', false);
select pg_temp.as_platform();
select private.send_rfq_supplier_notices();
select is(pg_temp.notices('r_split', 'Not Awarded'), 0, 'a vendor with a Proposed order from the RFQ is not notified');

-- 5. No account ---------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.rfq('r_noacct', array['ven']);
select private.send_rfq_supplier_notices(now() + interval '3000 hours');
select is(pg_temp.notices('r_noacct'), 0, 'a vendor with no account gets no ledger row');
select pg_temp.as_user('carol');
select results_eq(format($$select reachable from app.rfq_vendor_reachability(%L)$$, pg_temp.id('r_noacct')), $$values (false)$$, 'and shows as not reachable');
select results_eq(format($$select reachable from app.rfq_vendor_reachability(%L)$$, pg_temp.id('rq1')), $$values (true)$$, 'a vendor with an owner is');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.rfq_vendor_reachability(pg_temp.id('rq1'))), 0, 'another org reads nothing');

-- 6. The seal -------------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.rfq_supplier_notices where rfq_id = pg_temp.id('rq1')), 0, 'while Issued, a reader of RFQs reads no ledger row');
select results_eq(format($$select reminders_sent, last_reminded_at from app.rfq_chase_status where rfq_id = %L$$, pg_temp.id('rq1')), $$values (null::bigint, null::timestamptz)$$, 'and no count, with one invited vendor');
select is((select chase_enabled from app.rfq_chase_status where rfq_id = pg_temp.id('rq1')), true, 'only the settings');
select is((select count(*)::integer from information_schema.columns where table_schema = 'app' and table_name = 'rfq_chase_status' and column_name = 'next_reminder_at'), 0, 'no next reminder either');
select pg_temp.as_user('alice');
select app.transition_rfq(pg_temp.id('rq1'), 'Issued', 'Closed', 'Done.');
select ok((select reminders_sent from app.rfq_chase_status where rfq_id = pg_temp.id('rq1')) > 0, 'closed, a holder of procurement.bid.read reads the count');
select ok((select count(*)::integer from app.rfq_supplier_notices where rfq_id = pg_temp.id('rq1')) > 0, 'and the ledger');
select pg_temp.producer('rfqr', 'procurement.rfq.read');
select pg_temp.as_user('rfqr');
select results_eq(format($$select reminders_sent from app.rfq_chase_status where rfq_id = %L$$, pg_temp.id('rq1')), $$values (null::bigint)$$, 'a reader without procurement.bid.read still does not');
select is((select count(*)::integer from app.rfq_supplier_notices where rfq_id = pg_temp.id('rq1')), 0, 'nor the ledger');
select pg_temp.as_platform();
select throws_ok(format($$update app.rfq_supplier_notices set sent_at = now() where rfq_id = %L$$, pg_temp.id('rq1')), null::text, null::text, 'the ledger is append-only');

-- 7. Release: nothing older is chased ---------------------------------------------------------------------------------------------------------------------
select pg_temp.rfq('r_old', array['ven_v']);
select pg_temp.as_platform();
update private.rfq_chase_started set started_at = now() + interval '1 hour';
select private.send_rfq_supplier_notices(now() + interval '4000 hours');
select is(pg_temp.notices('r_old'), 0, 'an RFQ issued before the start gets no reminder');
update private.rfq_chase_started set started_at = now() - interval '1 hour';
select ok(has_table_privilege('authenticated', 'private.rfq_chase_started', 'SELECT') = false, 'the start is private');

-- 8. The Gateway landing ------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.rfq('r_draft', array['ven_v'], null, false);
select pg_temp.as_user('victor');
select is((select count(*)::integer from api_external.rfq_requests where id = pg_temp.id('r_draft')), 0, 'a vendor reads nothing while Proposed');
select is((select count(*)::integer from api_external.rfq_request_lines where rfq_id = pg_temp.id('r_draft')), 0, 'nor its lines');
select is((select count(*)::integer from api_external.rfq_requests where id = pg_temp.id('r_old')), 1, 'while Issued the owner reads it');
select is((select contact_name from api_external.rfq_requests where id = pg_temp.id('r_old')), 'Carol Nguyen', 'with the contact');
select is((select description from api_external.rfq_request_lines where rfq_id = pg_temp.id('r_old')), 'Stage cable', 'and its lines');
select is((select count(*)::integer from information_schema.columns where table_schema = 'api_external' and table_name in ('rfq_requests', 'rfq_request_lines')
           and (column_name like '%price%' or column_name like '%need%' or column_name like '%vendor%')), 0, 'no price, need or vendor column');
select is((select count(*)::integer from api_external.rfq_requests where id in (pg_temp.id('rq1'), pg_temp.id('r_a'))), 0, 'Closed and Awarded are gone');
select pg_temp.as_user('alice');
select app.transition_rfq(pg_temp.id('r_draft'), 'Proposed', 'Canceled', 'No.');
select pg_temp.as_user('victor');
select is((select count(*)::integer from api_external.rfq_requests where id = pg_temp.id('r_draft')), 0, 'and Canceled');
select pg_temp.as_user('rita');
select is((select count(*)::integer from api_external.rfq_requests where id = pg_temp.id('r_old')), 0, 'another account reads nothing');
select pg_temp.as_user('sam');
select is((select count(*)::integer from api_external.rfq_requests where id = pg_temp.id('r_old')), 0, 'nor does a plain member of the account');

-- 9. Member recipients and the job ------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::integer from cron.job where jobname = 'xos_send_rfq_supplier_notices' and schedule = '37 * * * *'), 1, 'the sweep is scheduled hourly at minute 37');
select ok(pg_get_functiondef('private.send_rfq_supplier_notice(app.rfqs, uuid, app.rfq_notice_kind, smallint, jsonb, timestamptz)'::regprocedure) like '%gatewayPath%', 'a member''s args drop the Gateway path');
select ok(not has_table_privilege('xos_backup', 'app.rfq_chase_status', 'SELECT'), 'the backup login does not read the status view');
select ok(exists (select 1 from private.trash_tables where table_name = 'procurement_needs'), 'the last migration ran the Trash sync');

select * from finish();
rollback;
