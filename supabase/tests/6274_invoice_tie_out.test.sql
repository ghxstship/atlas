-- pgTAP: invoice lines, tie-out and vendor history (B15, RRR-239, migration 6274). The tie-out compares the printed total with
-- the lines, null while unpriced, and is invisible to the backup login. Vendor history is the same counterparty and direction
-- only, leaves out the invoice, names a budget line only on the same project, and row level security decides what it reads.
-- Lines apply as the caller, numbered after existing ones, only to the invoice their extraction was saved as.
-- World: 0700_engagement_world (cp_v_a a counterparty of org_a; alice owner, gina viewer; org_b is another org).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.invoice(p_key text, p_project text, p_direction text, p_counterparty text, p_number text, p_printed bigint default null, p_currency text default 'USD') returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.invoices (project_id, direction, counterparty_id, invoice_number, issued_on, currency_code, printed_total_minor)
  values (pg_temp.id(p_project), p_direction::app.money_direction, pg_temp.id(p_counterparty), p_number, '2027-05-01', p_currency, p_printed) returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;

-- An extraction whose header was saved as the invoice, with open lines.
create function pg_temp.extraction(p_key text, p_invoice text, p_currency text, p_lines integer) returns uuid
language plpgsql as $$
declare r uuid; h uuid; i integer;
begin
  r := app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5');
  perform app.ai_complete_request(r, 'Answered', 'Read the invoice.', 'Read.', 100, 40);
  h := app.ai_propose_suggestion(r, 'invoices.create', null, 'Create an invoice.',
    jsonb_build_array(jsonb_build_object('field_path', 'currency_code', 'value', p_currency, 'confidence', 0.9)));
  perform app.transition_ai_suggestion(h, 'Proposed', 'Confirmed', 'Saved.');
  perform app.transition_ai_suggestion(h, 'Confirmed', 'Applied', 'Saved.', pg_temp.id(p_invoice));
  for i in 1 .. p_lines loop
    insert into world values (p_key || '_' || i, app.ai_propose_suggestion(r, 'invoiceLines.create', null, 'Add a line.',
      jsonb_build_array(jsonb_build_object('field_path', 'description', 'value', 'Line ' || i, 'confidence', 0.9),
        jsonb_build_object('field_path', 'quantity', 'value', 2, 'confidence', 0.9),
        jsonb_build_object('field_path', 'unit_price_minor', 'value', 1000, 'confidence', 0.9))));
  end loop;
  return r;
end $$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, extraction_enabled) values (pg_temp.id('org_a'), true);
select pg_temp.as_user('alice');
insert into world values ('cp_other', app.create_counterparty(pg_temp.id('org_a'), 'Coastal Staging Co', null, null));
select pg_temp.invoice('inv_new', 'prj_a', 'Payable', 'cp_v_a', 'INV-0099', 5000);
select pg_temp.invoice('inv_old', 'prj_a', 'Payable', 'cp_v_a', 'INV-0042');
select pg_temp.invoice('inv_ar', 'prj_a', 'Receivable', 'cp_v_a', 'AR-1');
select pg_temp.invoice('inv_other', 'prj_a', 'Payable', 'cp_other', 'CS-7');
select pg_temp.invoice('inv_far', 'prj_a2', 'Payable', 'cp_v_a', 'FAR-1');
select pg_temp.invoice('inv_eur', 'prj_a', 'Payable', 'cp_v_a', 'EUR-1', null, 'EUR');
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor) values
  (pg_temp.id('inv_old'), 1, 'Wedge monitor rental', 4, 4500),
  (pg_temp.id('inv_old'), 2, 'Wedge monitor rental, weekend', 4, 5000),
  (pg_temp.id('inv_old'), 3, 'Wedge monitors rental', 2, 4800),
  (pg_temp.id('inv_old'), 4, 'Wedge monitor hire rental', 2, 4900),
  (pg_temp.id('inv_ar'), 1, 'Wedge monitor rental', 1, 9900),
  (pg_temp.id('inv_other'), 1, 'Wedge monitor rental', 10, 1000),
  (pg_temp.id('inv_far'), 1, 'Stagehand labor', 6, 3500);

-- Tie-out -----------------------------------------------------------------------------------------------------------------------
select is((select residual_minor from app.invoice_tie_out where invoice_id = pg_temp.id('inv_new')), null::bigint, 'an invoice with no lines has no residual');
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('inv_new'), 1, 'Crew', 1.005, 100);
select is((select computed_total_minor from app.invoice_tie_out where invoice_id = pg_temp.id('inv_new')), 101::bigint, 'the computed total rounds half away from zero, as extended_minor does');
select is((select residual_minor from app.invoice_tie_out where invoice_id = pg_temp.id('inv_new')), 4899::bigint, 'the residual is printed minus computed');
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('inv_new'), 2, 'Unpriced', 1, null);
select is((select computed_total_minor from app.invoice_tie_out where invoice_id = pg_temp.id('inv_new')), null::bigint, 'an unpriced line leaves no computed total');
update app.invoice_lines set deleted_at = now() where invoice_id = pg_temp.id('inv_new');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.invoice_tie_out where invoice_id = pg_temp.id('inv_old')), 1, 'a finance reader reads the view');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.invoice_tie_out where invoice_id = pg_temp.id('inv_old')), 0, 'row level security holds through the view');
select pg_temp.as_platform();
select is(has_table_privilege('xos_backup', 'app.invoice_tie_out', 'select'), false, 'the backup login cannot read the view');

-- History -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is((select count(*)::int from app.vendor_line_history(pg_temp.id('inv_new'), array['Wedge monitor rental'])), 3, 'at most three prior lines for a description');
select ok(not exists (select 1 from app.vendor_line_history(pg_temp.id('inv_new'), array['Wedge monitor rental']) h where h.invoice_number in ('CS-7', 'AR-1', 'INV-0099')),
  'never another counterparty''s, the other direction''s, or the invoice itself');
select is((select invoice_number from app.vendor_line_history(pg_temp.id('inv_new'), array['Stagehand labor']) limit 1), 'FAR-1', 'another project''s line of the counterparty counts');
select throws_ok($$select * from app.vendor_line_history((select id from world where key = 'inv_new'), array_fill('x'::text, array[51]))$$,
  'XR001', 'aurora_intake_item_invalid: Look up at most 50 lines at a time.', 'at most 50 descriptions');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.vendor_line_history(pg_temp.id('inv_new'), array['Wedge monitor rental'])), 0, 'row level security decides: another org reads nothing');

-- Applying ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select pg_temp.extraction('l', 'inv_new', 'USD', 3);
select pg_temp.extraction('foreign', 'inv_old', 'USD', 1);
select pg_temp.extraction('eur', 'inv_new', 'EUR', 1);
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor) values (pg_temp.id('inv_new'), 5, 'Existing', 1, 100);
select pg_temp.as_user('bob');
select throws_ok($$select app.apply_invoice_line_suggestions((select id from world where key = 'inv_new'), jsonb_build_array(jsonb_build_object('suggestion_id', (select id from world where key = 'l_3'), 'values', '{}'::jsonb)))$$,
  '42501', null, 'an audit reader cannot apply someone else''s line');
select pg_temp.as_platform();
select is((select count(*)::int from app.invoice_lines where invoice_id = pg_temp.id('inv_new') and deleted_at is null), 1, 'and it rolled back');
select pg_temp.as_user('alice');
select throws_ok($$select app.apply_invoice_line_suggestions((select id from world where key = 'inv_new'), jsonb_build_array(jsonb_build_object('suggestion_id', (select id from world where key = 'foreign_1'), 'values', '{}'::jsonb)))$$,
  'XR001', 'aurora_invoice_lines_foreign: Line 1: These lines were read for another invoice.', 'a line of another invoice is refused');
select throws_ok($$select app.apply_invoice_line_suggestions((select id from world where key = 'inv_new'), jsonb_build_array(jsonb_build_object('suggestion_id', (select id from world where key = 'eur_1'), 'values', '{}'::jsonb)))$$,
  'XR001', 'aurora_invoice_currency: Line 1: The document''s currency is not the invoice''s.', 'a currency mismatch is refused');
select lives_ok($$select app.apply_invoice_line_suggestions((select id from world where key = 'inv_new'), jsonb_build_array(
    jsonb_build_object('suggestion_id', (select id from world where key = 'l_1'), 'values', '{"quantity": 3}'::jsonb),
    jsonb_build_object('suggestion_id', (select id from world where key = 'l_2'), 'values', '{}'::jsonb)))$$, 'kept lines are added');
select is((select array_agg(line_number order by line_number) from app.invoice_lines where invoice_id = pg_temp.id('inv_new') and deleted_at is null), array[5, 6, 7], 'numbered after the existing ones');
select is((select quantity from app.invoice_lines where invoice_id = pg_temp.id('inv_new') and line_number = 6), 3::numeric, 'with the person''s value');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('l_1')), 'Applied', 'the suggestion ends Applied');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('l_3')), 'Proposed', 'and the rest stay open');
select app.transition_invoice(pg_temp.id('inv_new'), 'Proposed', 'Canceled', 'Canceled for the test.');
select throws_ok($$select app.apply_invoice_line_suggestions((select id from world where key = 'inv_new'), jsonb_build_array(jsonb_build_object('suggestion_id', (select id from world where key = 'l_3'), 'values', '{}'::jsonb)))$$,
  'XR001', 'invoice_locked: Line 1: Invoice lines change only while the invoice is Proposed.', 'a non-Proposed invoice refuses invoice_locked');

select * from finish();
rollback;
