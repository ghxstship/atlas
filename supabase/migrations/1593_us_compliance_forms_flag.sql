-- 1593_us_compliance_forms_flag.sql
--
-- Orchestrator block (ADR 0022, 1590-1599), RRR-125. ADR 0033 decision 54 defers A82's WH-347 and OSHA Forms 300, 300A
-- and 301 past launch: they stay in the code, and offering them waits on counsel's answers to ADR 0041's open questions.
-- Atlas offered them anyway: Settings, Payroll and Time Off; Settings, Locations and Venues; and an incident's record each
-- checked a capability and nothing else. This adds them to A18's flag system (0540) as compliance.us_forms, off by
-- default, the way infra/runbooks/progressive-delivery.md ships a risky feature. Atlas reads app.org_feature_flags and,
-- while the flag is off, hides the three panels, refuses their actions and answers 404 at /{org}/forms/{form}/{id}. The
-- database refuses the forms' writes on its own, so the flag is never enforced only in the UI:
--   * a new OSHA establishment, case or annual summary (1385), and a new WH-347 project header or registered apprentice
--     (1386), refuse us_compliance_forms_off;
--   * so does every issue of a certified payroll: app.certified_payroll writes the week's row in
--     app.certified_payroll_submissions before it returns any, a new row for a new week and issued_at for a week issued
--     again, so the guard sits on that insert and on updates of issued_at. Soft deletes and the tenant purge pass.
-- Rows already held stay readable, and API v1 serves none of these tables or forms. Once counsel answers, platform staff
-- turn the flag on for an org with an override (operator console, the tenant's Feature flags) or for every org with
-- flag-complete; the kill switch works as for any flag.

insert into private.feature_flags (flag_key, description, default_enabled, required_plan_feature) values
  ('compliance.us_forms', 'OSHA Forms 300, 300A and 301 and the WH-347 certified payroll (ADR 0041). Off until counsel answers ADR 0041''s open questions (ADR 0033 decision 54).', false, null);

create or replace function private.guard_us_compliance_forms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.flag_enabled(new.org_id, 'compliance.us_forms') then
    perform private.refuse('us_compliance_forms_off', 'The OSHA forms and the WH-347 certified payroll are turned off for this organization.');
  end if;
  return new;
end;
$$;

comment on function private.guard_us_compliance_forms() is 'The OSHA forms and the WH-347 (ADR 0041) need the compliance.us_forms flag (ADR 0033 decision 54): a new establishment, case, annual summary, WH-347 project header or registered apprentice, and every issue of a certified payroll, refuse us_compliance_forms_off while the flag is off for the org.';
revoke all on function private.guard_us_compliance_forms() from public, anon, authenticated;

create trigger t39_guard_us_compliance_forms before insert on app.osha_establishments
  for each row execute function private.guard_us_compliance_forms();
create trigger t39_guard_us_compliance_forms before insert on app.osha_cases
  for each row execute function private.guard_us_compliance_forms();
create trigger t39_guard_us_compliance_forms before insert on app.osha_annual_summaries
  for each row execute function private.guard_us_compliance_forms();
create trigger t39_guard_us_compliance_forms before insert on app.certified_payroll_projects
  for each row execute function private.guard_us_compliance_forms();
create trigger t39_guard_us_compliance_forms before insert on app.registered_apprentices
  for each row execute function private.guard_us_compliance_forms();
create trigger t39_guard_us_compliance_forms before insert or update of issued_at on app.certified_payroll_submissions
  for each row execute function private.guard_us_compliance_forms();
