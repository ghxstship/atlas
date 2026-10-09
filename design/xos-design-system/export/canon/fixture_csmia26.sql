-- CSMIA26 demo fixture for the engagement contract: one organization, venue and project. Load after contract_engagement.sql.
SET search_path = public, xpms;

INSERT INTO employment_status (label) VALUES ('Full-Time'), ('Part-Time'), ('Temporary');
INSERT INTO flsa_status (label) VALUES ('Exempt'), ('Nonexempt');
INSERT INTO venue (venue_id, name, jurisdiction_id) VALUES
  ('mana-wynwood', 'Mana Wynwood Convention Center & Grounds', 'US-FL-MIAMI-DADE');

INSERT INTO organization (organization_id, name, organization_type) VALUES
  ('GHXSTSHIP', 'GHXSTSHIP Industries LLC', 'For-Profit');

INSERT INTO project (project_id, name, organization_id, venue_id) VALUES
  ('CSMIA26', 'Casa Spotify Miami', 'GHXSTSHIP', 'mana-wynwood');
