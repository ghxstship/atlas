-- pgTAP: the owner's canon reference model (decisions D11 to D17, D19), ported from
-- design/xos-design-system/export/canon/checks.sql. The engagement checks (XOS-ENG-1 to
-- XOS-ENG-6 on app tables) belong to A02, A03 and A28 and run once their tables land.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(34);

-- Rulings as data --------------------------------------------------------------------------
select is((select array_agg(label::text order by sort_order) from xpms.grade), array['Base','Elevated','Premium'], 'D11: grades are Base, Elevated and Premium');
select is((select count(*)::int from xpms.role), 35, 'D12: the Roles Library holds 35 roles');
select is((select count(*)::int from xpms.rate_card), 35, 'Labor Rate Cards hold 35 cards');
select is((select row(ot_multiplier, dt_multiplier)::text from xpms.overtime_rule where rule_id = 'OTR-001'), '(1.5,2)', 'D14: OTR-001 is 1.5 and 2');
select is((select row(ot_multiplier, dt_multiplier)::text from xpms.overtime_rule where rule_id = 'OTR-002'), '(1,1)', 'D14: OTR-002 is 1 and 1');
select is((select count(*)::int from xpms.emergency_code), 14, 'D15: 14 global emergency codes');
select is((select count(*)::int from xpms.emergency_protocol), 84, 'D15: 84 protocols, 14 codes by 6 domains');
select is((select count(*)::int from xpms.emergency_protocol_step), 183, 'D15: 183 protocol steps');
select is(
  (select count(*)::int from xpms.emergency_protocol_step where body ~ '(LAPD|LAFD|MDFR)'),
  0, 'D15: protocol steps name services, never agencies'
);
select is(
  (select array_agg(code::text order by sort_order) from xpms.worker_classification),
  array['EMPLOYEE','INDEPENDENT_CONTRACTOR','VENDOR_SUPPLIED','UNPAID_INTERN','VOLUNTEER'],
  'D16: worker classifications'
);
select ok(
  not exists (select 1 from xpms.classification_organization_type where worker_classification = 'VOLUNTEER' and organization_type = 'For-Profit'),
  'D17: volunteers are not permitted at a for-profit organization'
);

-- 1 to 3. Rate cards must match the permitted combinations ------------------------------------
select throws_ok(
  $$insert into xpms.rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, currency_code, overtime_rule_id)
    values ('LRC-901', '5000.50.01', 'EMPLOYEE', 'Day Rate', 'Retainer', 'USD', 'OTR-001')$$,
  '23503', null, 'Retainer is always Independent Contractor'
);
select throws_ok(
  $$insert into xpms.rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, currency_code, overtime_rule_id)
    values ('LRC-902', '5000.50.01', 'INDEPENDENT_CONTRACTOR', 'Salary', 'Per Engagement', 'USD', 'OTR-001')$$,
  '23503', null, 'Salary is employees only'
);
select throws_ok(
  $$insert into xpms.rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, currency_code, overtime_rule_id)
    values ('LRC-903', '5000.50.01', 'VOLUNTEER', 'Day Rate', 'Per Engagement', 'USD', 'OTR-001')$$,
  '23503', null, 'Unpaid classifications cannot hold a rate card'
);
select lives_ok(
  $$insert into xpms.rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, standard_rate_minor, currency_code, overtime_rule_id)
    values ('LRC-909', '6000.51.01', 'EMPLOYEE', 'Hourly', 'Per Engagement', 3000, 'USD', 'OTR-002')$$,
  'a permitted combination is accepted'
);
select throws_ok(
  $$insert into xpms.overtime_rule values ('OTR-009', 'Below Law', 0.5, 1)$$,
  '23514', null, 'an overtime multiplier below 1 is refused'
);

-- 11. Jurisdiction shape -------------------------------------------------------------------------
select throws_ok(
  $$insert into xpms.jurisdiction (jurisdiction_id, ordinal, level, parent, status) values ('GB-LDN', 99, 'region', 'US', 'declared-unpopulated')$$,
  '23514', null, 'a child jurisdiction cannot belong to another country'
);
select throws_ok(
  $$insert into xpms.jurisdiction (jurisdiction_id, ordinal, level, status) values ('CA', 98, 'country', 'declared-unpopulated')$$,
  '23514', null, 'a country must state its unit system and currency'
);

-- 12. Role lists ---------------------------------------------------------------------------------
select throws_ok(
  $$insert into xpms.role (role_code, job_title, discipline, rank) values ('5000.59.01', 'Check Role', 'Unlisted Discipline', 'Lead')$$,
  '23503', null, 'a role cannot use a discipline outside the canon list'
);
select ok(
  not exists (select 1 from xpms.role_discipline d where not exists (select 1 from xpms.role r where r.discipline = d.name)),
  'every discipline is used'
);
select ok(
  not exists (select 1 from xpms.role_rank k where not exists (select 1 from xpms.role r where r.rank = k.label)),
  'every rank is used'
);
select is((select class_code::text from xpms.role where role_code = '9000.50.02'), '9000', 'department derives from the role code');

-- Derived GL and resolved views ------------------------------------------------------------------
select ok(not exists (select 1 from xpms.rate_card_resolved where gl_account is null), 'every rate card resolves a GL account by class');
select is((select gl_account::text from xpms.rate_card_resolved where rate_card_id = 'LRC-008'), '5900', 'D13: 9000 roles post to 5900');
select ok(
  not exists (select 1 from xpms.rate_card where arrangement = 'Retainer' and worker_classification <> 'INDEPENDENT_CONTRACTOR'),
  'no retainer card names another classification'
);
select is((select count(*)::int from xpms.rate_card_resolved), 36, 'rate_card_resolved returns every card');
select is(
  (select row(unit_system, currency, primary_code_sets)::text from xpms.jurisdiction_resolved where jurisdiction_id = 'US-FL-MIAMI-DADE'),
  '(imperial,USD,"FBC, Miami-Dade County")',
  'jurisdiction inheritance resolves Bible tab 11'
);
select ok(
  not exists (select 1 from xpms.jurisdiction_resolved where unit_system is null or currency is null or primary_code_sets is null),
  'every jurisdiction resolves'
);
select ok(
  not exists (select 1 from xpms.jurisdiction j join xpms.jurisdiction p on p.jurisdiction_id = j.parent
               where j.currency = p.currency or j.unit_system = p.unit_system),
  'no inherited value is stored twice'
);
select is((select count(*)::int from xpms.jurisdiction_resolved where status = 'declared-unpopulated'), 4, 'GB, MX, AE and SA are declared and unpopulated');
select is(xpms.min_ot_multiplier('US-FL-MIAMI-DADE'), 1.5, 'the federal overtime minimum reaches Miami-Dade');
select is(xpms.min_ot_multiplier('GB'), null, 'an unpopulated jurisdiction states no minimum');
select is((select agency::text from xpms.jurisdiction_agency where jurisdiction_id = 'US-FL-MIAMI-DADE' and function = 'fire'), 'Miami Fire-Rescue', 'D19: agency names follow canon');
select is(
  (select array_agg(class_code::text order by code) from xpms.gl_account where type = 'Expense'),
  array['0000','1000','2000','3000','4000','5000','6000','7000','8000','9000'],
  'each class owns one expense account'
);

select * from finish();
rollback;
