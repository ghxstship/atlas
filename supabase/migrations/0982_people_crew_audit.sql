-- 0982_people_crew_audit.sql
-- A13 People and Crew, late slot (ADR 0022 section 2). Every People and Crew table gets A18's audit
-- trail (0501), so each insert, edit and soft delete lands in app.audit_events with a diff that leaves
-- out audit columns, hashes and Restricted columns (pay rates stay masked in the ledger). The
-- procedure is created in 0501, after the module ranges, so the calls live here.

call private.install_audit_trail('app.shifts');
call private.install_audit_trail('app.shift_swaps');
call private.install_audit_trail('app.time_entries');
call private.install_audit_trail('app.time_entry_corrections');
call private.install_audit_trail('app.timesheets');
call private.install_audit_trail('app.kiosk_devices');
call private.install_audit_trail('app.rate_cards');
call private.install_audit_trail('app.rate_card_lines');
call private.install_audit_trail('app.pay_rates');
call private.install_audit_trail('app.union_local_rates');
call private.install_audit_trail('app.wage_determinations');
call private.install_audit_trail('app.earning_codes');
call private.install_audit_trail('app.pay_periods');
call private.install_audit_trail('app.payroll_runs');
call private.install_audit_trail('app.payroll_lines');
call private.install_audit_trail('app.payroll_exports');
call private.install_audit_trail('app.per_diems');
call private.install_audit_trail('app.time_off_policies');
call private.install_audit_trail('app.time_off_requests');
call private.install_audit_trail('app.requisitions');
call private.install_audit_trail('app.role_assignments');
call private.install_audit_trail('app.agreements');
call private.install_audit_trail('app.certifications');
call private.install_audit_trail('app.certification_holders');
