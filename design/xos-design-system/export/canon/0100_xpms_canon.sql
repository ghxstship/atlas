-- XOS canon reference tables in third normal form (decisions D11 to D17).
-- Every fact has one home. Values another table already owns are joined or derived, never copied.
-- Target: PostgreSQL 16 (loaded and verified). Owner: agent A01 Canon, migration 0100, schema xpms. Organization scoping, RLS and audit columns are added by the platform layer.

CREATE SCHEMA IF NOT EXISTS xpms;
SET search_path = xpms;

-- 1. Departments: the ten classes. The class code is the first segment of every role code and URID.
CREATE TABLE department (
  class_code  char(4) PRIMARY KEY CHECK (class_code ~ '^[0-9]000$'),
  name        text NOT NULL UNIQUE
);

-- 2. GL Accounts. Each class owns at most one account per account type (decision D13).
CREATE TYPE gl_account_type AS ENUM ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense');
CREATE TABLE gl_account (
  code        char(4) PRIMARY KEY,
  name        text NOT NULL,
  type        gl_account_type NOT NULL,
  class_code  char(4) REFERENCES department (class_code),
  UNIQUE (class_code, type)
);

-- 3. Grades (decision D11). Labels are data; amounts per grade live on the priced row.
CREATE TABLE grade (
  code        text PRIMARY KEY CHECK (code IN ('base', 'elevated', 'premium')),
  label       text NOT NULL UNIQUE,
  sort_order  smallint NOT NULL UNIQUE
);

-- 4. Roles Library (decision D12). Department is derived from the role code, so it is not stored.
-- Discipline and rank are canon lists, so each value lives once in its own table and roles reference it.
CREATE TABLE role_discipline (name text PRIMARY KEY);
CREATE TABLE role_rank (label text PRIMARY KEY);
CREATE TABLE role (
  role_code   char(10) PRIMARY KEY CHECK (role_code ~ '^[0-9]000\.[0-9]{2}\.[0-9]{2}$'),
  class_code  char(4) GENERATED ALWAYS AS (left(role_code, 4)) STORED REFERENCES department (class_code),
  job_title   text NOT NULL,
  discipline  text NOT NULL REFERENCES role_discipline (name),
  rank        text NOT NULL REFERENCES role_rank (label)
);

-- 5. Overtime rules (decision D14). Multipliers are numbers; "1.5x" is display formatting only.
CREATE TABLE overtime_rule (
  rule_id        text PRIMARY KEY CHECK (rule_id ~ '^OTR-[0-9]{3}$'),
  name           text NOT NULL UNIQUE,
  ot_multiplier  numeric(4,2) NOT NULL CHECK (ot_multiplier >= 1),
  dt_multiplier  numeric(4,2) NOT NULL CHECK (dt_multiplier >= ot_multiplier),
  UNIQUE (ot_multiplier, dt_multiplier)
);

-- 6. Worker classification and Labor Rate Cards (decision D16).
-- Canon lists that grow are lookup tables, not enums, so a new value is a row, not a migration.
-- Classification is the legal relationship, independent of how pay is computed or how long the work runs.
-- Codes are jurisdiction-neutral; country-specific documents (W-4, W-9, W-2, 1099-NEC) live in classification_document.
CREATE TABLE worker_classification (
  code             text PRIMARY KEY CHECK (code ~ '^[A-Z_]+$'),
  label            text NOT NULL UNIQUE,
  is_employee      boolean NOT NULL,
  payment_channel  text NOT NULL CHECK (payment_channel IN ('Payroll', 'Accounts Payable', 'None')),
  sort_order       smallint NOT NULL UNIQUE,
  CHECK (NOT is_employee OR payment_channel = 'Payroll')
);
CREATE TABLE classification_document (
  worker_classification  text NOT NULL REFERENCES worker_classification (code),
  country                char(2) NOT NULL,
  document               text NOT NULL,
  purpose                text NOT NULL CHECK (purpose IN ('Onboarding', 'Year-End')),
  PRIMARY KEY (worker_classification, country, document)
);
-- How pay is computed.
CREATE TABLE pay_basis (label text PRIMARY KEY);
-- The commercial arrangement: a standing retainer or per-engagement work.
CREATE TABLE arrangement (label text PRIMARY KEY);
-- Which combinations are lawful or permitted. A rate card must match a row in each.
CREATE TABLE pay_basis_classification (
  pay_basis              text NOT NULL REFERENCES pay_basis (label),
  worker_classification  text NOT NULL REFERENCES worker_classification (code),
  PRIMARY KEY (pay_basis, worker_classification)
);
CREATE TABLE arrangement_classification (
  arrangement            text NOT NULL REFERENCES arrangement (label),
  worker_classification  text NOT NULL REFERENCES worker_classification (code),
  PRIMARY KEY (arrangement, worker_classification)
);
-- No job title, department, GL account or multipliers: each is joined or derived.
CREATE TABLE rate_card (
  rate_card_id           text PRIMARY KEY CHECK (rate_card_id ~ '^LRC-[0-9]{3}$'),
  role_code              char(10) NOT NULL REFERENCES role (role_code),
  worker_classification  text NOT NULL,
  pay_basis              text NOT NULL,
  arrangement            text NOT NULL,
  standard_rate          numeric(12,2) CHECK (standard_rate >= 0),
  min_grade_rate         numeric(12,2) CHECK (min_grade_rate >= 0),
  max_grade_rate         numeric(12,2) CHECK (max_grade_rate >= min_grade_rate),
  per_diem_rate          numeric(12,2) CHECK (per_diem_rate >= 0),
  overtime_rule_id       text NOT NULL REFERENCES overtime_rule (rule_id),
  UNIQUE (role_code, worker_classification, pay_basis, arrangement),
  FOREIGN KEY (pay_basis, worker_classification) REFERENCES pay_basis_classification (pay_basis, worker_classification),
  FOREIGN KEY (arrangement, worker_classification) REFERENCES arrangement_classification (arrangement, worker_classification)
);

-- Rate cards as every surface reads them. GL posting follows the role's class.
CREATE VIEW rate_card_resolved AS
SELECT rc.rate_card_id, rc.role_code, r.job_title, d.class_code, d.name AS department,
       wc.label AS worker_classification, rc.pay_basis, rc.arrangement,
       rc.standard_rate, rc.min_grade_rate, rc.max_grade_rate, rc.per_diem_rate,
       o.rule_id AS overtime_rule_id, o.ot_multiplier, o.dt_multiplier,
       g.code AS gl_account, g.name AS gl_account_name
FROM rate_card rc
JOIN role r ON r.role_code = rc.role_code
JOIN department d ON d.class_code = r.class_code
JOIN worker_classification wc ON wc.code = rc.worker_classification
JOIN overtime_rule o ON o.rule_id = rc.overtime_rule_id
LEFT JOIN gl_account g ON g.class_code = r.class_code AND g.type = 'Expense';

-- 7. Emergency codes (decision D15). Global: no organization, project or jurisdiction columns.
CREATE TABLE emergency_code (
  code        text PRIMARY KEY CHECK (code ~ '^CODE_[A-Z]+$'),
  label       text NOT NULL UNIQUE,
  emergency   text NOT NULL,
  swatch      text NOT NULL UNIQUE CHECK (swatch ~ '^ecode-[a-z]+$'),
  sort_order  smallint NOT NULL UNIQUE
);
CREATE TABLE operational_domain (
  domain      text PRIMARY KEY,
  sort_order  smallint NOT NULL UNIQUE
);
CREATE TABLE emergency_protocol (
  record_key  text PRIMARY KEY CHECK (record_key ~ '^EMG-[0-9]{3}$'),
  code        text NOT NULL REFERENCES emergency_code (code),
  domain      text NOT NULL REFERENCES operational_domain (domain),
  UNIQUE (code, domain)
);
-- Steps name services as {fire}, {ems}, {lawEnforcement}, {bombSquad} or {federal}, never an agency.
CREATE TABLE emergency_protocol_step (
  record_key  text NOT NULL REFERENCES emergency_protocol (record_key) ON DELETE CASCADE,
  step_no     smallint NOT NULL CHECK (step_no >= 1),
  body        text NOT NULL,
  PRIMARY KEY (record_key, step_no)
);

-- 8. Jurisdictions, from Bible tab 11. An unmatched or unpopulated jurisdiction returns no answer.
-- Every fact has one home: the country is the first segment of the ID (derived); unit system and currency are stored on
-- the country and inherited down the chain unless a lower level states its own; code sets are one row each.
-- jurisdiction_resolved reproduces tab 11 exactly. One table holds every jurisdiction-specific agency: emergency
-- responders and regulators alike, replacing the agencies written into protocol text and the Playbook "Regulatory Agency" enumeration.
CREATE TABLE jurisdiction (
  jurisdiction_id    text PRIMARY KEY CHECK (jurisdiction_id ~ '^[A-Z]{2}(-[A-Z0-9]+)*$'),
  level              text NOT NULL CHECK (level IN ('country', 'region', 'ahj')),
  country            char(2) GENERATED ALWAYS AS (left(jurisdiction_id, 2)) STORED,
  parent             text REFERENCES jurisdiction (jurisdiction_id),
  unit_system        text CHECK (unit_system IN ('imperial', 'metric')),
  currency           char(3),
  status             text NOT NULL CHECK (status IN ('populated', 'declared-unpopulated')),
  note               text,
  CHECK ((level = 'country') = (parent IS NULL)),
  CHECK (level <> 'country' OR (unit_system IS NOT NULL AND currency IS NOT NULL)),
  CHECK (parent IS NULL OR left(parent, 2) = left(jurisdiction_id, 2))
);
CREATE TABLE jurisdiction_code_set (
  jurisdiction_id  text NOT NULL REFERENCES jurisdiction (jurisdiction_id) ON DELETE CASCADE,
  code_set         text NOT NULL,
  sort_order       smallint NOT NULL,
  PRIMARY KEY (jurisdiction_id, code_set),
  UNIQUE (jurisdiction_id, sort_order)
);
-- Jurisdictions as every surface reads them: inherited values resolved, code sets listed in order.
CREATE VIEW jurisdiction_resolved AS
WITH RECURSIVE chain AS (
  SELECT j.jurisdiction_id AS id, j.jurisdiction_id AS ancestor, 0 AS depth FROM jurisdiction j
  UNION ALL
  SELECT c.id, p.parent, c.depth + 1 FROM chain c JOIN jurisdiction p ON p.jurisdiction_id = c.ancestor WHERE p.parent IS NOT NULL)
SELECT j.jurisdiction_id, j.level, j.country, j.parent,
       (SELECT a.unit_system FROM chain c JOIN jurisdiction a ON a.jurisdiction_id = c.ancestor WHERE c.id = j.jurisdiction_id AND a.unit_system IS NOT NULL ORDER BY c.depth LIMIT 1) AS unit_system,
       (SELECT a.currency FROM chain c JOIN jurisdiction a ON a.jurisdiction_id = c.ancestor WHERE c.id = j.jurisdiction_id AND a.currency IS NOT NULL ORDER BY c.depth LIMIT 1) AS currency,
       (SELECT string_agg(cs.code_set, ', ' ORDER BY cs.sort_order) FROM jurisdiction_code_set cs WHERE cs.jurisdiction_id = j.jurisdiction_id) AS primary_code_sets,
       j.status, j.note
FROM jurisdiction j;
-- Country-specific documents name a declared country.
ALTER TABLE classification_document ADD FOREIGN KEY (country) REFERENCES jurisdiction (jurisdiction_id);
-- Wage-and-hour minimums. A jurisdiction holds only what it adds to its parent; the strictest value up the chain governs.
CREATE TABLE wage_hour_rule (
  jurisdiction_id        text PRIMARY KEY REFERENCES jurisdiction (jurisdiction_id),
  source                 text NOT NULL,
  weekly_ot_after_hours  numeric(5,2) CHECK (weekly_ot_after_hours > 0),
  daily_ot_after_hours   numeric(5,2) CHECK (daily_ot_after_hours > 0),
  daily_dt_after_hours   numeric(5,2) CHECK (daily_dt_after_hours > daily_ot_after_hours),
  min_ot_multiplier      numeric(4,2) CHECK (min_ot_multiplier >= 1),
  min_dt_multiplier      numeric(4,2) CHECK (min_dt_multiplier >= min_ot_multiplier)
);
CREATE TABLE agency_function (
  function    text PRIMARY KEY,
  label       text NOT NULL UNIQUE,
  responder   boolean NOT NULL,
  sort_order  smallint NOT NULL UNIQUE
);
CREATE TABLE jurisdiction_agency (
  jurisdiction_id  text NOT NULL REFERENCES jurisdiction (jurisdiction_id),
  function         text NOT NULL REFERENCES agency_function (function),
  agency           text NOT NULL,
  contact          text,
  PRIMARY KEY (jurisdiction_id, function)
);
-- Legal form of an organization, and which forms may use each worker classification (decision D17).
-- Volunteer is permitted only for Nonprofit and Public Agency organizations.
CREATE TABLE organization_type (label text PRIMARY KEY);
CREATE TABLE classification_organization_type (
  worker_classification  text NOT NULL REFERENCES worker_classification (code),
  organization_type      text NOT NULL REFERENCES organization_type (label),
  PRIMARY KEY (worker_classification, organization_type)
);
-- Wage-and-hour chain for a jurisdiction, strictest value first. Used by the engagement compliance rules.
CREATE FUNCTION min_ot_multiplier(j text) RETURNS numeric LANGUAGE sql STABLE SET search_path = xpms AS $$
  WITH RECURSIVE chain AS (
    SELECT jurisdiction_id, parent FROM jurisdiction WHERE jurisdiction_id = j
    UNION ALL
    SELECT p.jurisdiction_id, p.parent FROM jurisdiction p JOIN chain c ON p.jurisdiction_id = c.parent)
  SELECT max(w.min_ot_multiplier) FROM chain c JOIN wage_hour_rule w USING (jurisdiction_id)
$$;
