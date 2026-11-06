-- pgTAP: 3025, approved crew hours costed to the linked Labor line (B13, RRR-237, gap G-133, ADR 0152). Pay rates either
-- side of a work date; a late local clock-in on the period's last day posts on that date (project calendar); the overtime
-- split; an engaged hourly rate; an agency rate with its counterparty; Day Rate unpriced; another currency counted, not
-- summed; void and re-approval; approval with no rate; the shift guards; rate_minor not selectable and the masking;
-- labor_budget_lines without amounts; bulk Set budget line; save_roster_shift with no old overload.
-- Tests never assert posted minutes equal approved_minutes at a period edge: the void trigger and private.worker_minutes
-- use UTC days until the planned project-day fix lands (ADR 0152).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

-- A Labor line and a Cost line on prj_a's budget, and frank's shift on it -------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Labor Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Other Budget', 'USD') returning id)
  insert into world select 'bud_a2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stagehands.', '5000.51.02', 'Labor', 100, 2000, 'X', 'Declared') returning id) insert into world select 'labor', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 2, 'Deck rental.', '5000.04.02', 'Cost', 1, 50000, 'X', 'Declared') returning id) insert into world select 'cost', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a2'), 1, 'Elsewhere.', '5000.51.02', 'Labor', 1, 100, 'X', 'Declared') returning id) insert into world select 'labor_a2', id from x;

create function pg_temp.member_shift(p_key text, p_day date, p_line text) returns void
language plpgsql as $$
declare v uuid;
begin
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone, budget_line_id)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '5000.51.02', p_day + time '12:00', p_day + time '13:00', 'America/New_York', pg_temp.id(p_line))
  returning id into v;
  insert into world values (p_key, v);
end $$;
grant execute on function pg_temp.member_shift(text, date, text) to public;

-- Shift guards --------------------------------------------------------------------------------------------------------------
select pg_temp.member_shift('sh1', '2027-06-14', 'labor');
select throws_ok(format($$update app.shifts set budget_line_id = '%s' where id = '%s'$$, pg_temp.id('cost'), pg_temp.id('sh1')), 'XR001',
  'shift_budget_line_labor: A shift posts its time to a Labor line.', 'a shift links a Labor line only');
select throws_ok(format($$update app.shifts set budget_line_id = '%s' where id = '%s'$$, pg_temp.id('labor_a2'), pg_temp.id('sh1')), 'XR001',
  'shift_budget_line_project: Choose a live line of a budget of this shift''s project.', 'of a budget of its own project');
select throws_ok(format($$update app.budget_lines set line_type = 'Cost' where id = '%s'$$, pg_temp.id('labor')), 'XR001',
  'budget_line_labor_linked: Shifts post their time to this Labor line; move them to another line first.', 'a linked line keeps its type');
select throws_ok(format($$update app.budget_lines set deleted_at = now() where id = '%s'$$, pg_temp.id('labor')), 'XR001',
  'budget_line_labor_linked: Shifts post their time to this Labor line; move them to another line first.', 'and is not deleted');
select ok(exists (select 1 from app.labor_budget_lines where id = pg_temp.id('labor')), 'the planner lists Labor lines');
select ok(not exists (select 1 from app.labor_budget_lines where id = pg_temp.id('cost')), 'and only those');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
           where table_schema = 'app' and table_name = 'labor_budget_lines'),
  array['id', 'budget_id', 'project_id', 'budget_name', 'line_number', 'description'], 'with no amounts');

-- Member postings ---------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from) values
  (pg_temp.id('frank@org_a'), '5000.51.02', 2000, 'USD', '2027-01-01'),
  (pg_temp.id('frank@org_a'), '5000.51.02', 3000, 'USD', '2027-06-16');
-- Week of 2027-06-13 (Sunday): 10 hours a day Monday to Friday, 50 hours: 10 of overtime on the federal weekly rule.
-- 2027-06-14 and 15 at 20.00, then 30.00 from 2027-06-16.
insert into app.time_entries (project_id, membership_id, shift_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('sh1'), d + time '12:00', d + time '22:00'
from generate_series(date '2027-06-14', date '2027-06-18', interval '1 day') g(d);
-- West of UTC: a clock-in late on the period's last local day is on that day (prj_a is New York: 23:30 local is 03:30 UTC next day).
update app.projects set time_zone = 'America/New_York' where id = pg_temp.id('prj_a');
insert into app.time_entries (project_id, membership_id, shift_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('sh1'), '2027-06-20 03:30+00', '2027-06-20 03:45+00');
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-13', '2027-06-19') returning id) insert into world select 'ts_f', id from x;
select app.submit_timesheet(pg_temp.id('ts_f'));
select pg_temp.as_user('carol');
select lives_ok($$select app.decide_timesheet(pg_temp.id('ts_f'), 'Approved', 'Checked.')$$, 'approval goes through');
select pg_temp.as_platform();
select ok((select count(*) > 0 from app.labor_cost_postings l join app.timesheet_approvals a on a.id = l.timesheet_approval_id
           where a.timesheet_id = pg_temp.id('ts_f')), 'approving a member''s timesheet posts');
select is((select rate_minor from app.labor_cost_postings where work_date = '2027-06-15' and segment = 'Regular' and shift_id = pg_temp.id('sh1')),
  2000::bigint, 'at the pay rate in force the day before a raise');
select is((select rate_minor from app.labor_cost_postings where work_date = '2027-06-16' and segment = 'Regular' and shift_id = pg_temp.id('sh1')),
  3000::bigint, 'and at the raise from its effective date');
select is((select sum(minutes)::int from app.labor_cost_postings where segment = 'Overtime' and shift_id = pg_temp.id('sh1')), 615,
  'hours over 40 in the week split to Overtime within the timesheet');
select ok((select bool_and(multiplier >= 1.5) from app.labor_cost_postings where segment = 'Overtime' and shift_id = pg_temp.id('sh1')),
  'at the overtime multiplier');
select ok(exists (select 1 from app.labor_cost_postings where work_date = '2027-06-19' and shift_id = pg_temp.id('sh1')),
  'a clock-in at 23:30 local on the period''s last day posts on that local date');
create temporary table expected_labor as
  select sum(round(minutes / 60.0 * multiplier * rate_minor))::bigint as amount from app.labor_cost_postings where shift_id = pg_temp.id('sh1');
grant select on expected_labor to public;
select pg_temp.as_user('carol');
select is((select labor_actual_minor::bigint from app.budget_line_labor_totals where budget_line_id = pg_temp.id('labor')),
  (select amount from expected_labor), 'the line''s labor actual is the derived amount');
select pg_temp.as_platform();

-- Void and re-approval -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.labor_cost_posting_details where shift_id = pg_temp.id('sh1') and is_unpriced), 0, 'priced rows are not unpriced');
select pg_temp.as_platform();
update app.time_entries set clock_out = clock_out + interval '1 minute'
where shift_id = pg_temp.id('sh1') and clock_in = '2027-06-14 12:00+00';
select is((select count(*)::int from private.labor_postings_standing where shift_id = pg_temp.id('sh1')), 0,
  'a voided approval drops its postings from every view at once');
select ok((select count(*) > 0 from app.labor_cost_postings where shift_id = pg_temp.id('sh1')), 'and the ledger keeps them');
select pg_temp.as_user('frank');
select app.submit_timesheet(pg_temp.id('ts_f'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts_f'), 'Approved', 'Rechecked.');
select pg_temp.as_platform();
select ok((select count(*) > 0 from private.labor_postings_standing where shift_id = pg_temp.id('sh1')), 'a re-approval posts new rows');

-- Masking ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok('select rate_minor from app.labor_cost_postings', '42501', null, 'rate_minor is not selectable by signed-in callers');
select pg_temp.as_user('dave');
select ok((select bool_and(is_masked and rate_minor is null and amount_minor is null) from app.labor_cost_posting_details), 'a timesheet reader without the payroll capability sees amounts masked');
select ok((select bool_and(is_masked and amount_minor is null) from app.labor_posting_team_totals), 'and team cost masked');
select pg_temp.as_user('alice');
insert into app.roles (org_id, code, name, band, description) values (pg_temp.id('org_a'), 'budget_reader_b13', 'Budget Reader', 4, 'Reads budgets only.');
insert into app.role_capabilities (role_id, capability_code, reach)
  select id, 'finance.budget.read', 'organization' from app.roles where code = 'budget_reader_b13' and org_id = pg_temp.id('org_a');
select pg_temp.as_user_stepped_up('alice');
insert into app.membership_roles (membership_id, role_id)
  select pg_temp.id('erin@org_a'), id from app.roles where code = 'budget_reader_b13' and org_id = pg_temp.id('org_a');
select pg_temp.as_user('erin');
select ok((select labor_actual_minor > 0 from app.budget_line_labor_totals where budget_line_id = pg_temp.id('labor')),
  'the per-line aggregate shows to a budget reader');
select is_empty('select 1 from app.labor_cost_postings', 'a budget reader alone gets no row from the ledger')
  where not exists (select 1 from app.timesheets);
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
           where table_schema = 'app' and table_name = 'budget_line_labor_totals'),
  array['budget_line_id', 'budget_id', 'labor_actual_minor', 'labor_unpriced_minutes', 'labor_other_currency_count'], 'with no minutes beside cost but the unpriced count');

-- A crew planner cannot move posted Actuals (C6) ------------------------------------------------------------------------------
select pg_temp.as_platform();
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 3, 'Riggers.', '5000.51.02', 'Labor', 10, 2000, 'X', 'Declared') returning id) insert into world select 'labor2', id from x;
select pg_temp.as_user('carol');
select lives_ok(format($$update app.shifts set budget_line_id = '%s' where id = '%s'$$, pg_temp.id('labor2'), pg_temp.id('sh1')),
  'a person with finance.budget.write moves the line, and past Actual moves with it');
select is((select labor_actual_minor > 0 from app.budget_line_labor_totals where budget_line_id = pg_temp.id('labor2')), true, 'Actual follows the line');
update app.shifts set budget_line_id = pg_temp.id('labor') where id = pg_temp.id('sh1');
select pg_temp.as_user('alice');
insert into app.roles (org_id, code, name, band, description) values (pg_temp.id('org_a'), 'crew_planner_b13', 'Crew Planner', 4, 'Plans crew only.');
insert into app.role_capabilities (role_id, capability_code, reach)
  select id, c, 'organization' from app.roles, unnest(array['crew.shift.read', 'crew.shift.write']) c where code = 'crew_planner_b13' and org_id = pg_temp.id('org_a');
select pg_temp.as_user_stepped_up('alice');
insert into app.membership_roles (membership_id, role_id)
  select pg_temp.id('erin@org_a'), id from app.roles where code = 'crew_planner_b13' and org_id = pg_temp.id('org_a');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.shifts where id = pg_temp.id('sh1')), 1, 'the planner reads the shift');
select throws_ok(format($$update app.shifts set budget_line_id = null where id = '%s'$$, pg_temp.id('sh1')), 'XR001',
  'shift_budget_line_posted: Approved time on this shift is already on the budget, so moving it needs finance.budget.write.',
  'a crew planner cannot move posted time');

-- Deleting a shift moves its posted time to Hours not on a budget line (ADR 0152), and restoring it brings the time back.
select pg_temp.as_user('carol');
update app.shifts set deleted_at = now() where id = pg_temp.id('sh1');
select pg_temp.as_platform();
select ok(exists (select 1 from private.labor_postings_standing where shift_id = pg_temp.id('sh1'))
          and not exists (select 1 from private.labor_postings_standing where shift_id = pg_temp.id('sh1') and budget_line_id is not null),
  'a deleted shift''s posted time stands on no budget line');
select pg_temp.as_user('carol');
update app.shifts set deleted_at = null where id = pg_temp.id('sh1');
select pg_temp.as_platform();
select ok(exists (select 1 from private.labor_postings_standing where shift_id = pg_temp.id('sh1') and budget_line_id = pg_temp.id('labor')),
  'a restored shift brings it back to the line');

-- No rate never blocks an approval -----------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '2027-06-22 12:00+00', '2027-06-22 14:00+00');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '2027-06-20', '2027-06-26') returning id) insert into world select 'ts_d', id from x;
select lives_ok(format($$insert into app.timesheet_approvals (org_id, timesheet_id, approved_by, approved_minutes)
    values ('%s', '%s', '%s', 120)$$, pg_temp.id('org_a'), pg_temp.id('ts_d'), pg_temp.id('alice')),
  'a missing rate never refuses an approval');
select pg_temp.as_platform();
select ok((select bool_and(rate_minor is null and rate_source is null and currency_code is null and shift_id is null) from app.labor_cost_postings l
           join app.timesheet_approvals a on a.id = l.timesheet_approval_id where a.timesheet_id = pg_temp.id('ts_d')),
  'it posts unpriced, with no shift, never at zero');
select is((select coalesce(sum(minutes), 0)::int from private.labor_postings_standing where timesheet_id = pg_temp.id('ts_d')), 120, 'its minutes are counted');

-- External postings -------------------------------------------------------------------------------------------------------------
-- The canon rate card holds Day Rate rows only, and an engagement's terms must name a row of it (engagements_rate_card_fkey),
-- so an Hourly engagement needs an Hourly row: added here for this transaction.
select pg_temp.as_platform();
insert into xpms.rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, standard_rate_minor, currency_code, overtime_rule_id)
  select 'LRC-999', role_code, worker_classification, 'Hourly', arrangement, 5000, 'USD', overtime_rule_id
  from xpms.rate_card where role_code = '5000.51.02' and worker_classification = 'INDEPENDENT_CONTRACTOR' and pay_basis = 'Day Rate' limit 1;
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_platform();
update app.engagements set agreed_rate_minor = 4500, currency_code = 'USD', pay_basis = 'Hourly' where id = pg_temp.id('eng_ivy_a');
insert into app.time_entries (project_id, engagement_id, clock_in, clock_out, break_minutes)
values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-07-05 12:00+00', '2027-07-05 22:00+00', 30);
with x as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-07-04', '2027-07-10') returning id) insert into world select 'ts_i', id from x;
select pg_temp.as_user('ivy');
select app.submit_timesheet(pg_temp.id('ts_i'));
select pg_temp.as_user('alice');
select app.decide_timesheet(pg_temp.id('ts_i'), 'Approved', 'Checked.');
select pg_temp.as_platform();
select results_eq(format($$select minutes, segment::text, multiplier, rate_minor, rate_source::text from app.labor_cost_postings l
    join app.timesheet_approvals a on a.id = l.timesheet_approval_id where a.timesheet_id = '%s'$$, pg_temp.id('ts_i')),
  $$values (570, 'Regular', 1::numeric, 4500::bigint, 'Engagement Rate')$$, 'an engaged hourly worker posts Regular at the agreed rate, less breaks');
select is((select team_kind::text from private.labor_postings_standing where timesheet_id = pg_temp.id('ts_i') limit 1), 'Engaged', 'as Engaged');

-- Day Rate posts unpriced; another currency is counted, never summed.
update app.engagements set agreed_rate_minor = 200000, pay_basis = 'Day Rate' where id = pg_temp.id('eng_ivy_a');
insert into app.time_entries (project_id, engagement_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-07-12 12:00+00', '2027-07-12 14:00+00');
with x as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-07-11', '2027-07-17') returning id) insert into world select 'ts_i2', id from x;
select pg_temp.as_user('ivy');
select app.submit_timesheet(pg_temp.id('ts_i2'));
select pg_temp.as_user('alice');
select app.decide_timesheet(pg_temp.id('ts_i2'), 'Approved', 'Checked.');
select pg_temp.as_platform();
select is((select rate_minor from app.labor_cost_postings l join app.timesheet_approvals a on a.id = l.timesheet_approval_id
           where a.timesheet_id = pg_temp.id('ts_i2')), null::bigint, 'Day Rate posts unpriced minutes, never zero');

select pg_temp.as_platform();
update app.engagements set agreed_rate_minor = 4000, pay_basis = 'Hourly', currency_code = 'EUR' where id = pg_temp.id('eng_ivy_a');
with x as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone, budget_line_id)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', '2027-07-19 12:00+00', '2027-07-19 14:00+00', 'America/New_York', pg_temp.id('labor2')) returning id)
  insert into world select 'sh_eur', id from x;
insert into app.time_entries (project_id, engagement_id, shift_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), pg_temp.id('sh_eur'), '2027-07-19 12:00+00', '2027-07-19 14:00+00');
with x as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-07-18', '2027-07-24') returning id) insert into world select 'ts_i3', id from x;
select pg_temp.as_user('ivy');
select app.submit_timesheet(pg_temp.id('ts_i3'));
select pg_temp.as_user('alice');
select app.decide_timesheet(pg_temp.id('ts_i3'), 'Approved', 'Checked.');
select is((select labor_other_currency_count from app.budget_line_labor_totals where budget_line_id = pg_temp.id('labor2')), 1,
  'a rate in another currency is counted');
select is((select labor_actual_minor::bigint from app.budget_line_labor_totals where budget_line_id = pg_temp.id('labor2')), 0::bigint,
  'and not summed');

-- A roster self entry has no counterparty, so it is not an agency (C15).
select pg_temp.as_platform();
insert into world select 'self_ivy', r.id from app.engagement_roster_entries r
  where r.engagement_id = pg_temp.id('eng_ivy_a') and r.is_self and r.deleted_at is null;
insert into app.time_entries (project_id, roster_entry_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('self_ivy'), '2027-07-27 12:00+00', '2027-07-27 14:00+00');
with x as (insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('self_ivy'), '2027-07-25', '2027-07-31') returning id) insert into world select 'ts_self', id from x;
select pg_temp.as_user('ivy');
select app.submit_timesheet(pg_temp.id('ts_self'));
select pg_temp.as_user('alice');
select app.decide_timesheet(pg_temp.id('ts_self'), 'Approved', 'Checked.');
select pg_temp.as_platform();
select is((select team_kind::text || '/' || coalesce(team_counterparty_id::text, 'none') from private.labor_postings_standing where timesheet_id = pg_temp.id('ts_self') limit 1),
  'Engaged/none', 'a roster self entry of an engagement with no counterparty posts as Engaged');

-- Agency staff ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.engagements set agreed_rate_minor = 3500, currency_code = 'USD', pay_basis = 'Hourly' where id = pg_temp.id('eng_agency');
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella'));
select pg_temp.as_platform();
insert into app.time_entries (project_id, roster_entry_id, shift_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), pg_temp.id('slot_1'), '2027-08-02 12:00+00', '2027-08-02 14:00+00');
with x as (insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), '2027-08-01', '2027-08-07') returning id) insert into world select 'ts_s', id from x;
select pg_temp.as_user('stella');
select app.submit_timesheet(pg_temp.id('ts_s'));
select pg_temp.as_user('alice');
select app.decide_timesheet(pg_temp.id('ts_s'), 'Approved', 'Checked.');
select pg_temp.as_platform();
select is((select rate_minor from private.labor_postings_standing where timesheet_id = pg_temp.id('ts_s')), 3500::bigint, 'agency staff post at the agency''s rate');
select is((select team_kind::text || '/' || (team_counterparty_id = pg_temp.id('cp_s_a'))::text from private.labor_postings_standing where timesheet_id = pg_temp.id('ts_s')),
  'Agency/true', 'under the agency''s counterparty');
select pg_temp.as_user('dave');
select ok(exists (select 1 from app.labor_posting_team_totals where team_kind = 'Agency' and team_name = 'Crestline Staffing'), 'the agency sits beside the own team');
select ok(exists (select 1 from app.labor_posting_team_totals where team_kind = 'Own Team'), 'and the own team');

-- A budget reader alone reads neither the ledger nor the team totals (C7).
select pg_temp.as_user('xavier');
select is_empty('select 1 from app.labor_cost_posting_details', 'cross tenant: no postings');
select is_empty('select 1 from app.labor_posting_team_totals', 'nor team totals');

-- Bulk Set budget line and the shift editor -------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.member_shift('sh2', '2027-09-06', 'labor');
select lives_ok(format($$select app.bulk_update_shifts(jsonb_build_array(jsonb_build_object('id', '%s', 'set', jsonb_build_object('budget_line_id', '%s'),
    'expect', jsonb_build_object('budget_line_id', '%s'))), false)$$, pg_temp.id('sh2'), pg_temp.id('labor2'), pg_temp.id('labor')), 'bulk Set budget line runs');
select is((select budget_line_id from app.shifts where id = pg_temp.id('sh2')), pg_temp.id('labor2'), 'and sets the line');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'save_roster_shift'), 1,
  'no old signature of save_roster_shift remains');
select lives_ok(format($$select app.save_roster_shift('%s', '%s', '%s', '5000.51.02', '2027-09-07 12:00+00', '2027-09-07 13:00+00', 'America/New_York', '%s', null, null, null, '%s')$$,
  pg_temp.id('sh2'), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('labor')), 'the shift editor saves the line');
select is((select budget_line_id from app.shifts where id = pg_temp.id('sh2')), pg_temp.id('labor'), 'in its one transaction');

-- Backup login ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(not exists (select 1 from pg_roles where rolname = 'xos_backup') or not has_table_privilege('xos_backup', 'app.labor_posting_team_totals', 'select'),
  'the backup login has no SELECT on the labor views');

select * from finish();
rollback;
