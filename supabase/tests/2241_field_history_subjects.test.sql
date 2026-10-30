-- pgTAP: 2241, field history on every record page (A131, RRR-177, S4.10-04). Each entity with a record page or peek is a
-- field history subject with an audit trail whose read policies the history follows; editing an expense, a change order,
-- a budget, an engagement, a time entry, a per diem, an agreement, a training course, a vendor class, a verbiage term, a
-- certificate or a membership shows each changed field before and after; a column signed-in people cannot select stays
-- out of the history.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(30);

create temporary table new_subjects (table_name text primary key);
insert into new_subjects values
  ('app.accounting_periods'), ('app.budgets'), ('app.change_orders'), ('app.cost_centers'), ('app.expenses'),
  ('app.journal_entries'), ('app.payments'), ('app.settlements'),
  ('app.agreements'), ('app.applications'), ('app.engagements'), ('app.offers'), ('app.opportunities'), ('app.pay_periods'),
  ('app.payroll_runs'), ('app.per_diems'), ('app.rate_cards'), ('app.requisitions'), ('app.shift_swaps'), ('app.time_entries'), ('app.time_off_requests'), ('app.timesheets'),
  ('app.canon_extension_proposals'), ('app.catalog_bindings'), ('app.goods_receipts'), ('app.insurance_certificates'),
  ('app.invoice_matches'), ('app.prequalifications'), ('app.rfqs'), ('app.sponsor_entitlements'), ('app.submittals'),
  ('app.vendor_scorecards'),
  ('app.credential_categories'), ('app.credentials'), ('app.incidents'), ('app.radio_channels'), ('app.work_orders'),
  ('app.accommodation_blocks'), ('app.advance_packets'), ('app.advance_submissions'), ('app.beos'), ('app.dock_slots'),
  ('app.fulfillments'), ('app.guest_list_entries'), ('app.reconciliations'), ('app.riders'), ('app.shipments'),
  ('app.asset_classes'), ('app.asset_damage'), ('app.asset_lots'), ('app.asset_maintenance'),
  ('app.capability_documents'), ('app.inspection_templates'), ('app.inspections'), ('app.permit_requirements'),
  ('app.site_plans'), ('app.spaces'), ('app.venues'), ('app.zones'),
  ('app.call_sheets'), ('app.day_sheets'), ('app.run_of_show'), ('app.schedule_baselines'),
  ('app.feed_posts'), ('app.groups'), ('app.handbook_articles'), ('app.lost_found_items'), ('app.workforce_events'),
  ('app.certification_holders'), ('app.memberships'), ('app.training_courses'), ('app.vendor_classes'), ('app.verbiage_terms');
grant select on new_subjects to public;

-- Each subject: registered, audited, readable by its own policies -----------------------------------------------------
select is((select count(*)::int from new_subjects n join private.field_history_subjects s using (table_name)),
  (select count(*)::int from new_subjects), 'every entity with a record page is a field history subject');
select is(
  (select array_agg(n.table_name order by n.table_name) from new_subjects n
   where not exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = n.table_name::regclass and g.tgname = 't85_audit_trail'
                       and g.tgfoid = 'private.audit_row_change()'::regprocedure)),
  null, 'each has an audit trail');
select is(
  (select array_agg(s.table_name order by s.table_name) from private.field_history_subjects s
   where not exists (select 1 from pg_catalog.pg_trigger g where g.tgrelid = s.table_name::regclass and g.tgname = 't85_audit_trail')),
  null, 'and so does every subject listed before');

-- private.caller_reads_row answers only from permissive read policies that apply to signed-in people; a subject with
-- none would refuse every caller, so each must have one.
select is(
  (select array_agg(n.table_name order by n.table_name) from new_subjects n
   where not exists (select 1 from pg_catalog.pg_policy p
                     where p.polrelid = n.table_name::regclass and p.polcmd in ('r', '*') and p.polqual is not null
                       and p.polpermissive and (0::oid = any (p.polroles) or 'authenticated'::regrole = any (p.polroles)))),
  null, 'each has a read policy for signed-in people, so its history can answer');

-- The history evaluates each table's own read policies: for a row the caller cannot read (here, none at all) every
-- subject refuses with 42501, which also proves each policy compiles inside private.caller_reads_row.
create function pg_temp.refusals() returns table (table_name text, code text)
language plpgsql as $$
declare
  v_table text;
begin
  for v_table in select n.table_name from new_subjects n order by 1 loop
    begin
      perform * from app.field_history(v_table, gen_random_uuid());
      table_name := v_table; code := 'answered'; return next;
    exception when others then
      table_name := v_table; code := sqlstate; return next;
    end;
  end loop;
end $$;
select pg_temp.as_user('dave');
select is((select array_agg(r.table_name || ' ' || r.code order by r.table_name) from pg_temp.refusals() r where r.code <> '42501'),
  null, 'every new subject answers only for a row the caller reads');
select pg_temp.as_platform();

-- An expense, a change order and a budget ------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage deck rental.', '0000.01.01', 1, 15000, 'X', 'Declared') returning id)
  insert into world select 'line', id from x;
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code)
  values (pg_temp.id('line'), 'Deck rental deposit.', '2027-06-10', 40000, 'USD') returning id)
  insert into world select 'exp', id from x;
update app.expenses set description = 'Deck rental deposit, two decks.', amount_minor = 80000 where id = pg_temp.id('exp');
with x as (insert into app.change_orders (project_id, budget_id, title, order_type_enum_id, reason)
  values (pg_temp.id('prj_a'), pg_temp.id('bud'), 'Add a second stage', 'ENM-092', 'Client asked for a second stage.') returning id)
  insert into world select 'co', id from x;
update app.change_orders set title = 'Add a second and third stage' where id = pg_temp.id('co');
update app.budgets set name = 'Summer Series Budget v2' where id = pg_temp.id('bud');

select is((select old_value #>> '{}' from app.field_history('app.expenses', pg_temp.id('exp')) where field = 'description'),
  'Deck rental deposit.', 'an expense edit shows the description before');
select is((select new_value #>> '{}' from app.field_history('app.expenses', pg_temp.id('exp')) where field = 'description'),
  'Deck rental deposit, two decks.', 'and after');
select is((select new_value from app.field_history('app.expenses', pg_temp.id('exp')) where field = 'amount_minor'),
  '80000'::jsonb, 'with the amount it changed to');
select is((select count(*)::int from app.field_history('app.expenses', pg_temp.id('exp')) where operation = 'insert'), 1,
  'and starts with its creation');
select is((select new_value #>> '{}' from app.field_history('app.change_orders', pg_temp.id('co')) where field = 'title'),
  'Add a second and third stage', 'a change order edit shows its new title');
select is((select old_value #>> '{}' from app.field_history('app.budgets', pg_temp.id('bud')) where field = 'name'),
  'Summer Series Budget', 'a budget edit shows its old name');
select is((select actor_name from app.field_history('app.budgets', pg_temp.id('bud')) where field = 'name'),
  'Carol Nguyen', 'and who changed it');

select pg_temp.as_user('gina');
select throws_ok($$select * from app.field_history('app.expenses', (select id from world where key = 'exp'))$$, '42501', null,
  'a Viewer outside the project reads no history of its expenses (invariant 2)');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.field_history('app.change_orders', (select id from world where key = 'co'))$$, '42501', null,
  'another org reads none of its change orders');

-- An engagement ------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.engagements set end_date = '2027-08-31' where id = pg_temp.id('eng_ivy_a');
select pg_temp.as_user('carol');
select is((select new_value #>> '{}' from app.field_history('app.engagements', pg_temp.id('eng_ivy_a')) where field = 'end_date'),
  '2027-08-31', 'an engagement edit shows its new end date');
select ok(not exists (select 1 from app.field_history('app.engagements', pg_temp.id('eng_ivy_a')) where field = 'agreed_rate_minor'),
  'its Restricted agreed rate never reaches the history');

-- A time entry (partitioned since A130's 2231) -------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with x as (insert into app.time_entries (project_id, engagement_id, clock_in, clock_out)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-03 08:00+00', '2027-06-03 12:00+00') returning id)
  insert into world select 'te', id from x;
update app.time_entries set clock_out = '2027-06-03 12:30+00' where id = pg_temp.id('te');
select is((select (old_value #>> '{}')::timestamptz from app.field_history('app.time_entries', pg_temp.id('te')) where field = 'clock_out'),
  '2027-06-03 12:00+00'::timestamptz, 'a time entry edit shows its clock out before');
select is((select (new_value #>> '{}')::timestamptz from app.field_history('app.time_entries', pg_temp.id('te')) where field = 'clock_out'),
  '2027-06-03 12:30+00'::timestamptz, 'and after, read from its partition under the parent''s name');

-- A per diem (R1's Crew > Per Diems) -----------------------------------------------------------------------------------------
-- Per diem is an offering since R3 (2625): prj_a offers it, so the insert reaches the table's own rules.
select pg_temp.as_user('carol');
select app.set_setting(pg_temp.id('org_a'), 'offerings.per_diem', 'Project', pg_temp.id('prj_a'), 'provided');
with x as (insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-05', 6500, 'USD') returning id)
  insert into world select 'pd', id from x;
update app.per_diems set amount_minor = 7500 where id = pg_temp.id('pd');
select is((select old_value from app.field_history('app.per_diems', pg_temp.id('pd')) where field = 'amount_minor'),
  '6500'::jsonb, 'a per diem edit shows its amount before');
select is((select new_value from app.field_history('app.per_diems', pg_temp.id('pd')) where field = 'amount_minor'),
  '7500'::jsonb, 'and after');

-- An agreement (a contract) ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.agreements (org_id, person_id, agreement_kind, title, body)
  values (pg_temp.id('org_a'), pg_temp.id('mia'), 'Contractor Agreement', 'Contractor Agreement', 'Mia provides services as an independent contractor.') returning id)
  insert into world select 'agr', id from x;
update app.agreements set body = body || ' Payment within 30 days.' where id = pg_temp.id('agr');
select is((select new_value #>> '{}' from app.field_history('app.agreements', pg_temp.id('agr')) where field = 'body'),
  'Mia provides services as an independent contractor. Payment within 30 days.', 'an agreement edit shows its new text');
select is((select old_value #>> '{}' from app.field_history('app.agreements', pg_temp.id('agr')) where field = 'body'),
  'Mia provides services as an independent contractor.', 'and the text before');

-- A column withheld from signed-in people never leaves the ledger through the history: the access code hash changes when
-- the agreement is sent, and the ledger keeps it, but the history leaves it out.
select pg_temp.as_user('carol');
select app.send_agreement(pg_temp.id('agr'), 'Sent to Mia.');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events where subject_id = pg_temp.id('agr') and diff -> 'new' ? 'access_code_hash'),
  'the ledger records the withheld column');
select pg_temp.as_user('carol');
select ok(not exists (select 1 from app.field_history('app.agreements', pg_temp.id('agr')) where field = 'access_code_hash'),
  'the history leaves it out');
select pg_temp.as_platform();

-- Record pages without a comment thread: a training course (audited since this migration), a vendor class, a verbiage
-- term, a certificate and the person record of People > Directory (a membership) --------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.training_courses (org_id, title, pass_percent) values (pg_temp.id('org_a'), 'Rigging Basics', 80) returning id)
  insert into world select 'a131_course', id from x;
update app.training_courses set pass_percent = 90 where id = pg_temp.id('a131_course');
select is((select old_value from app.field_history('app.training_courses', pg_temp.id('a131_course')) where field = 'pass_percent'),
  '80'::jsonb, 'a training course edit shows its pass mark before');
select is((select new_value from app.field_history('app.training_courses', pg_temp.id('a131_course')) where field = 'pass_percent'),
  '90'::jsonb, 'and after');

with x as (insert into app.vendor_classes (org_id, name) values (pg_temp.id('org_a'), 'Staging Suppliers') returning id)
  insert into world select 'a131_class', id from x;
update app.vendor_classes set description = 'Decks, risers and rigging.' where id = pg_temp.id('a131_class');
select is((select new_value #>> '{}' from app.field_history('app.vendor_classes', pg_temp.id('a131_class')) where field = 'description'),
  'Decks, risers and rigging.', 'a vendor class edit shows its new description');

with x as (insert into app.verbiage_terms (org_id, term, casing_rule, definition)
  values (pg_temp.id('org_a'), 'Load-in', 'Load-in', 'When crews bring equipment into a venue.') returning id)
  insert into world select 'a131_term', id from x;
update app.verbiage_terms set definition = 'When crews bring equipment into a venue and build the show.' where id = pg_temp.id('a131_term');
select is((select old_value #>> '{}' from app.field_history('app.verbiage_terms', pg_temp.id('a131_term')) where field = 'definition'),
  'When crews bring equipment into a venue.', 'a verbiage term edit shows its definition before');

with x as (insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'A131 Rigging Level 1', 'ETCP') returning id)
  insert into world select 'a131_cert', id from x;
with x as (insert into app.certification_holders (certification_id, person_id, issued_on, expires_on)
  values (pg_temp.id('a131_cert'), pg_temp.id('frank'), '2027-01-01', '2028-01-01') returning id)
  insert into world select 'a131_holder', id from x;
update app.certification_holders set expires_on = '2029-01-01' where id = pg_temp.id('a131_holder');
select is((select new_value #>> '{}' from app.field_history('app.certification_holders', pg_temp.id('a131_holder')) where field = 'expires_on'),
  '2029-01-01', 'a certificate edit shows its new expiry');

select pg_temp.as_platform();
update app.memberships set valid_to = '2027-12-31 00:00+00' where id = pg_temp.id('frank@org_a');
select pg_temp.as_user('alice');
select is((select (new_value #>> '{}')::timestamptz from app.field_history('app.memberships', pg_temp.id('frank@org_a')) where field = 'valid_to'),
  '2027-12-31 00:00+00'::timestamptz, 'a membership edit shows when it ends');
select pg_temp.as_platform();

select * from finish();
rollback;
