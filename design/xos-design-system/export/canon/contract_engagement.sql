-- XOS engagement contract (decisions D16 and D17). Not canon: these tables belong to other agents, who build them in their own
-- migration ranges with full columns, RLS and audit. They must keep every column, key and rule below, and pass checks.sql.
--   organization: A02 Platform Data (0200-0299)    venue, project: A03 Domain Data (0300-0499)
--   person, counterparty, labor agreement, engagement and its rules: A28 Engagements and Marketplace (0700-0799)
-- Load after 0100_xpms_canon.sql. Canon tables are read from the xpms schema.
SET search_path = public, xpms;

CREATE TABLE venue (
  venue_id         text PRIMARY KEY,
  name             text NOT NULL,
  jurisdiction_id  text NOT NULL REFERENCES jurisdiction (jurisdiction_id)
);
-- Organizations and their legal form. Some worker classifications are lawful only for certain forms.
CREATE TABLE organization (
  organization_id    text PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  organization_type  text NOT NULL REFERENCES organization_type (label)
);
CREATE TABLE project (
  project_id       text PRIMARY KEY,
  name             text NOT NULL,
  organization_id  text NOT NULL REFERENCES organization (organization_id),
  venue_id         text NOT NULL REFERENCES venue (venue_id)
);

-- Responding authorities for a project, as EmergencyCodeCard receives them (service, agency, contact).
CREATE VIEW project_authority AS
SELECT p.project_id, ja.function AS service, ja.agency, ja.contact
FROM project p
JOIN venue v ON v.venue_id = p.venue_id
JOIN jurisdiction_agency ja ON ja.jurisdiction_id = v.jurisdiction_id
JOIN agency_function f ON f.function = ja.function AND f.responder;

-- 9. Engagements (decision D16): one person or vendor working one project in one role.
-- Role, classification, pay basis and arrangement identify the rate card, so the rate card is never repeated.
-- Unpaid engagements (no pay basis) have no rate card.
CREATE TABLE employment_status (label text PRIMARY KEY);
CREATE TABLE flsa_status (label text PRIMARY KEY);
CREATE TABLE labor_agreement (
  agreement_id    text PRIMARY KEY,
  name            text NOT NULL,
  union_local     text NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date CHECK (effective_to >= effective_from)
);
CREATE TABLE person (
  person_id  text PRIMARY KEY,
  full_name  text NOT NULL
);
CREATE TABLE counterparty (
  counterparty_id  text PRIMARY KEY,
  name             text NOT NULL
);
CREATE TABLE engagement (
  engagement_id          text PRIMARY KEY,
  project_id             text NOT NULL REFERENCES project (project_id),
  person_id              text REFERENCES person (person_id),
  counterparty_id        text REFERENCES counterparty (counterparty_id),
  role_code              char(10) NOT NULL REFERENCES role (role_code),
  worker_classification  text NOT NULL REFERENCES worker_classification (code),
  pay_basis              text REFERENCES pay_basis (label),
  arrangement            text REFERENCES arrangement (label),
  agreed_rate            numeric(12,2) CHECK (agreed_rate >= 0),
  employment_status      text REFERENCES employment_status (label),
  flsa_status            text REFERENCES flsa_status (label),
  labor_agreement_id     text REFERENCES labor_agreement (agreement_id),
  start_date             date NOT NULL,
  end_date               date CHECK (end_date >= start_date),
  CHECK (person_id IS NOT NULL OR counterparty_id IS NOT NULL),
  CHECK ((pay_basis IS NULL) = (arrangement IS NULL)),
  CHECK (pay_basis IS NOT NULL OR agreed_rate IS NULL),
  FOREIGN KEY (role_code, worker_classification, pay_basis, arrangement)
    REFERENCES rate_card (role_code, worker_classification, pay_basis, arrangement)
);

-- Compliance rules that span tables. Each failure names the rule.
CREATE FUNCTION engagement_compliance() RETURNS trigger LANGUAGE plpgsql SET search_path = public, xpms AS $$
DECLARE
  wc       worker_classification%ROWTYPE;
  rule_ot  numeric;
  law_ot   numeric;
BEGIN
  SELECT * INTO wc FROM worker_classification WHERE code = NEW.worker_classification;
  IF (NEW.pay_basis IS NULL) <> (wc.payment_channel = 'None') THEN
    RAISE EXCEPTION 'XOS-ENG-1: % engagements % a pay basis', wc.label, CASE WHEN wc.payment_channel = 'None' THEN 'cannot have' ELSE 'require' END;
  END IF;
  IF wc.is_employee AND (NEW.employment_status IS NULL OR NEW.flsa_status IS NULL) THEN
    RAISE EXCEPTION 'XOS-ENG-2: employee engagements require employment status and FLSA status';
  END IF;
  IF NOT wc.is_employee AND (NEW.employment_status IS NOT NULL OR NEW.flsa_status IS NOT NULL OR NEW.labor_agreement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'XOS-ENG-3: employment status, FLSA status and labor agreements apply only to employees';
  END IF;
  IF NEW.worker_classification = 'VENDOR_SUPPLIED' AND NEW.counterparty_id IS NULL THEN
    RAISE EXCEPTION 'XOS-ENG-4: vendor-supplied engagements must name the vendor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM project p JOIN organization o ON o.organization_id = p.organization_id
      JOIN classification_organization_type c ON c.organization_type = o.organization_type AND c.worker_classification = NEW.worker_classification
     WHERE p.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'XOS-ENG-6: % engagements are not permitted for this organization type', wc.label;
  END IF;
  IF NEW.flsa_status = 'Nonexempt' THEN
    SELECT o.ot_multiplier INTO rule_ot
      FROM rate_card rc JOIN overtime_rule o ON o.rule_id = rc.overtime_rule_id
     WHERE rc.role_code = NEW.role_code AND rc.worker_classification = NEW.worker_classification
       AND rc.pay_basis = NEW.pay_basis AND rc.arrangement = NEW.arrangement;
    SELECT xpms.min_ot_multiplier(v.jurisdiction_id) INTO law_ot
      FROM project p JOIN venue v ON v.venue_id = p.venue_id WHERE p.project_id = NEW.project_id;
    IF law_ot IS NOT NULL AND rule_ot < law_ot THEN
      RAISE EXCEPTION 'XOS-ENG-5: nonexempt employees need an overtime multiplier of at least % here; the rate card rule gives %', law_ot, rule_ot;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER engagement_compliance BEFORE INSERT OR UPDATE ON engagement
  FOR EACH ROW EXECUTE FUNCTION engagement_compliance();

-- Engagements as every surface reads them.
CREATE VIEW engagement_resolved AS
SELECT e.engagement_id, e.project_id, e.person_id, e.counterparty_id, e.role_code, r.job_title,
       wc.label AS worker_classification, wc.payment_channel, e.pay_basis, e.arrangement,
       rc.rate_card_id, coalesce(e.agreed_rate, rc.standard_rate) AS rate,
       o.ot_multiplier, o.dt_multiplier, e.employment_status, e.flsa_status, e.labor_agreement_id,
       e.start_date, e.end_date
FROM engagement e
JOIN role r ON r.role_code = e.role_code
JOIN worker_classification wc ON wc.code = e.worker_classification
LEFT JOIN rate_card rc ON rc.role_code = e.role_code AND rc.worker_classification = e.worker_classification
  AND rc.pay_basis = e.pay_basis AND rc.arrangement = e.arrangement
LEFT JOIN overtime_rule o ON o.rule_id = rc.overtime_rule_id;
