-- 2653_project_fact_settings.sql
-- R5 Project facts (RRR-184, ADR 0102). The two settings of packages/schemas/settings/r5.yaml, pasted from
-- `pnpm --filter @xos/schemas settings:sql r5`: advancing.project_facts.keep_days, the days a roster entry's project
-- facts stay after the engagement is Complete or Canceled (default 90, 30 to 365, edited with data.retention.write;
-- private.expire_roster_project_facts reads it), and advancing.company_may_submit_project_facts, whether the company
-- that rosters a person may enter their project facts for them (off by default, org lockable and per project, edited
-- with org.gateway.write; private.assert_project_fact_writer reads it).

select private.define_setting('advancing.project_facts.keep_days', 'Integer', 'data.retention.write', array['organization'], false, p_default_integer => 90, p_min_integer => 30, p_max_integer => 365);
select private.define_setting('advancing.company_may_submit_project_facts', 'Boolean', 'org.gateway.write', array['organization', 'project'], true, p_default_boolean => false);
