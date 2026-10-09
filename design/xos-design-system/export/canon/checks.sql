-- XOS canon and engagement contract checks. Run after 0100_xpms_canon.sql, 0101_xpms_canon_seed.sql, contract_engagement.sql and
-- fixture_csmia26.sql. Everything runs in one transaction and rolls back.
-- Each block must either succeed or fail with the named rule. Any other outcome stops the run.
BEGIN;
SET LOCAL search_path = public, xpms;

INSERT INTO person (person_id, full_name) VALUES ('PER-T01', 'Check Person');
INSERT INTO counterparty (counterparty_id, name) VALUES ('CPY-T01', 'Check Vendor');
INSERT INTO labor_agreement (agreement_id, name, union_local, effective_from) VALUES ('LAG-T01', 'Check Agreement', 'Check Local', '2026-01-01');

CREATE FUNCTION pg_temp.expect_fail(stmt text, rule text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE EXCEPTION 'CHECK FAILED: expected % but the statement succeeded', rule;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'CHECK FAILED%' THEN RAISE; END IF;
  IF rule <> 'any' AND SQLSTATE <> rule AND position(rule IN SQLERRM) = 0 THEN
    RAISE EXCEPTION 'CHECK FAILED: expected %, got % (%)', rule, SQLERRM, SQLSTATE;
  END IF;
END $$;

-- 1. Retainer is always Independent Contractor (owner ruling).
SELECT pg_temp.expect_fail($$INSERT INTO rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id)
  VALUES ('LRC-901', '5000.50.01', 'EMPLOYEE', 'Day Rate', 'Retainer', 'OTR-001')$$, '23503');
-- 2. Salary is employees only.
SELECT pg_temp.expect_fail($$INSERT INTO rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id)
  VALUES ('LRC-902', '5000.50.01', 'INDEPENDENT_CONTRACTOR', 'Salary', 'Per Engagement', 'OTR-001')$$, '23503');
-- 3. Unpaid classifications cannot hold a rate card.
SELECT pg_temp.expect_fail($$INSERT INTO rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id)
  VALUES ('LRC-903', '5000.50.01', 'VOLUNTEER', 'Day Rate', 'Per Engagement', 'OTR-001')$$, '23503');
-- 4. An engagement must match an existing rate card.
SELECT pg_temp.expect_fail($$INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, start_date)
  VALUES ('ENG-T04', 'CSMIA26', 'PER-T01', '5000.51.01', 'INDEPENDENT_CONTRACTOR', 'Hourly', 'Per Engagement', '2026-10-16')$$, '23503');
-- 5. Employees need employment status and FLSA status (XOS-ENG-2).
SELECT pg_temp.expect_fail($$INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, start_date)
  VALUES ('ENG-T05', 'CSMIA26', 'PER-T01', '5000.51.01', 'EMPLOYEE', 'Day Rate', 'Per Engagement', '2026-10-16')$$, 'XOS-ENG-2');
-- 6. FLSA status and labor agreements apply only to employees (XOS-ENG-3).
SELECT pg_temp.expect_fail($$INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, flsa_status, start_date)
  VALUES ('ENG-T06', 'CSMIA26', 'PER-T01', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 'Exempt', '2026-10-16')$$, 'XOS-ENG-3');
-- 7. Vendor-supplied labor names the vendor (XOS-ENG-4).
SELECT pg_temp.expect_fail($$INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, start_date)
  VALUES ('ENG-T07', 'CSMIA26', 'PER-T01', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2026-10-16')$$, 'XOS-ENG-4');
-- 8. Unpaid engagements carry no pay basis (XOS-ENG-1).
SELECT pg_temp.expect_fail($$INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, start_date)
  VALUES ('ENG-T08', 'CSMIA26', 'PER-T01', '5000.51.01', 'VOLUNTEER', 'Day Rate', 'Per Engagement', '2026-10-16')$$, 'any');
-- 9. A nonexempt employee cannot sit on an overtime rule below the legal minimum (XOS-ENG-5).
INSERT INTO rate_card (rate_card_id, role_code, worker_classification, pay_basis, arrangement, standard_rate, overtime_rule_id)
  VALUES ('LRC-909', '6000.51.01', 'EMPLOYEE', 'Hourly', 'Per Engagement', 30, 'OTR-002');
SELECT pg_temp.expect_fail($$INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, employment_status, flsa_status, start_date)
  VALUES ('ENG-T09', 'CSMIA26', 'PER-T01', '6000.51.01', 'EMPLOYEE', 'Hourly', 'Per Engagement', 'Temporary', 'Nonexempt', '2026-10-16')$$, 'XOS-ENG-5');

-- Valid engagements, one per classification.
INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, employment_status, flsa_status, labor_agreement_id, start_date)
  VALUES ('ENG-T10', 'CSMIA26', 'PER-T01', '5000.51.01', 'EMPLOYEE', 'Day Rate', 'Per Engagement', 'Temporary', 'Nonexempt', 'LAG-T01', '2026-10-16');
INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, pay_basis, arrangement, start_date)
  VALUES ('ENG-T11', 'CSMIA26', 'PER-T01', '0000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', '2026-10-16');
INSERT INTO engagement (engagement_id, project_id, person_id, counterparty_id, role_code, worker_classification, pay_basis, arrangement, start_date)
  VALUES ('ENG-T12', 'CSMIA26', 'PER-T01', 'CPY-T01', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2026-10-16');
-- 11. A child jurisdiction cannot belong to another country, and a country must state its unit system and currency.
SELECT pg_temp.expect_fail($$INSERT INTO jurisdiction (jurisdiction_id, level, parent, status) VALUES ('GB-LDN', 'region', 'US', 'declared-unpopulated')$$, '23514');
SELECT pg_temp.expect_fail($$INSERT INTO jurisdiction (jurisdiction_id, level, status) VALUES ('CA', 'country', 'declared-unpopulated')$$, '23514');
-- 12. A role cannot use a discipline or rank outside the canon lists.
SELECT pg_temp.expect_fail($$INSERT INTO role (role_code, job_title, discipline, rank) VALUES ('5000.59.01', 'Check Role', 'Unlisted Discipline', 'Lead')$$, '23503');
-- 10. Volunteers are not permitted at a for-profit organization (XOS-ENG-6).
SELECT pg_temp.expect_fail($$INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, start_date)
  VALUES ('ENG-T14', 'CSMIA26', 'PER-T01', '6000.51.01', 'VOLUNTEER', '2026-10-16')$$, 'XOS-ENG-6');
INSERT INTO organization (organization_id, name, organization_type) VALUES ('ORG-T01', 'Check Nonprofit', 'Nonprofit');
INSERT INTO project (project_id, name, organization_id, venue_id) VALUES ('PRJ-T01', 'Check Benefit Night', 'ORG-T01', 'mana-wynwood');
INSERT INTO engagement (engagement_id, project_id, person_id, role_code, worker_classification, start_date)
  VALUES ('ENG-T13', 'PRJ-T01', 'PER-T01', '6000.51.01', 'VOLUNTEER', '2026-10-16');

DO $$ BEGIN
  IF (SELECT count(*) FROM engagement_resolved WHERE engagement_id LIKE 'ENG-T1%') <> 4 THEN RAISE EXCEPTION 'CHECK FAILED: engagement_resolved'; END IF;
  IF (SELECT rate FROM engagement_resolved WHERE engagement_id = 'ENG-T11') <> 1800 THEN RAISE EXCEPTION 'CHECK FAILED: retainer rate'; END IF;
  IF EXISTS (SELECT 1 FROM rate_card_resolved WHERE gl_account IS NULL) THEN RAISE EXCEPTION 'CHECK FAILED: unmapped GL'; END IF;
  IF EXISTS (SELECT 1 FROM rate_card WHERE arrangement = 'Retainer' AND worker_classification <> 'INDEPENDENT_CONTRACTOR') THEN RAISE EXCEPTION 'CHECK FAILED: retainer'; END IF;
  -- Jurisdictions: stored once, resolved to Bible tab 11 exactly.
  IF (SELECT row(unit_system, currency, primary_code_sets) FROM jurisdiction_resolved WHERE jurisdiction_id = 'US-FL-MIAMI-DADE')
     IS DISTINCT FROM row('imperial'::text, 'USD'::bpchar, 'FBC, Miami-Dade County'::text) THEN RAISE EXCEPTION 'CHECK FAILED: jurisdiction inheritance'; END IF;
  IF EXISTS (SELECT 1 FROM jurisdiction_resolved WHERE unit_system IS NULL OR currency IS NULL OR primary_code_sets IS NULL) THEN RAISE EXCEPTION 'CHECK FAILED: unresolved jurisdiction'; END IF;
  IF EXISTS (SELECT 1 FROM jurisdiction j JOIN jurisdiction p ON p.jurisdiction_id = j.parent
              WHERE j.currency = p.currency OR j.unit_system = p.unit_system) THEN RAISE EXCEPTION 'CHECK FAILED: inherited value stored twice'; END IF;
  -- Role lists: every discipline and rank is used, and each is stored once.
  IF EXISTS (SELECT 1 FROM role_discipline d WHERE NOT EXISTS (SELECT 1 FROM role r WHERE r.discipline = d.name)) THEN RAISE EXCEPTION 'CHECK FAILED: unused discipline'; END IF;
  IF EXISTS (SELECT 1 FROM role_rank k WHERE NOT EXISTS (SELECT 1 FROM role r WHERE r.rank = k.label)) THEN RAISE EXCEPTION 'CHECK FAILED: unused rank'; END IF;
  RAISE NOTICE 'XOS canon checks passed';
END $$;

ROLLBACK;
