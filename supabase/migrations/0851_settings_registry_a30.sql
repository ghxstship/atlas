-- 0851_settings_registry_a30.sql
-- A30 Identity, Profiles and Settings. The settings A30 contributes to the registry (Section 4.5.6),
-- generated from packages/schemas/settings/a30.yaml by `pnpm --filter @xos/schemas settings:sql a30`.
-- The settings test in packages/schemas compares these statements with the registry file as text,
-- so they are pasted verbatim. A later change to a30.yaml goes in a new migration with the
-- regenerated statements; the latest statement for a key wins.

select private.define_setting('org.legal_name', 'Text', 'org.general.write', array['organization'], false, p_max_length => 200);
select private.define_setting('org.default_workspace', 'Text', 'org.general.write', array['organization'], false, p_max_length => 36);
select private.define_setting('shell.start_page', 'Choice', 'org.general.write', array['organization', 'workspace', 'personal'], true, p_default_text => 'home', p_choices => array['home', 'my-work', 'inbox', 'projects']);
select private.define_setting('org.fiscal_year_start_month', 'Integer', 'org.legal_entities.write', array['organization'], false, p_default_integer => 1, p_min_integer => 1, p_max_integer => 12);
select private.define_setting('org.base_currency', 'Text', 'org.legal_entities.write', array['organization'], false, p_default_text => 'USD', p_max_length => 3);
select private.define_setting('org.invoice_number_prefix', 'Text', 'org.legal_entities.write', array['organization'], false, p_default_text => 'INV-', p_max_length => 12);
select private.define_setting('security.mfa_policy', 'Choice', 'org.security.write', array['organization'], false, p_default_text => 'optional', p_choices => array['optional', 'admins', 'everyone']);
select private.define_setting('security.session_hours', 'Integer', 'org.security.write', array['organization'], false, p_default_integer => 336, p_min_integer => 1, p_max_integer => 720);
select private.define_setting('security.idle_timeout_minutes', 'Integer', 'org.security.write', array['organization'], false, p_default_integer => 60, p_min_integer => 5, p_max_integer => 1440);
select private.define_setting('security.ip_allowlist', 'Text', 'org.security.write', array['organization'], false, p_max_length => 2000);
select private.define_setting('security.auto_join_enabled', 'Boolean', 'org.security.write', array['organization'], false, p_default_boolean => false);
select private.define_setting('access_reviews.remove_unreviewed', 'Boolean', 'org.access_reviews.manage', array['organization'], false, p_default_boolean => false);
select private.define_setting('access_reviews.grace_days', 'Integer', 'org.access_reviews.manage', array['organization'], false, p_default_integer => 14, p_min_integer => 1, p_max_integer => 60);
select private.define_setting('shell.density', 'Choice', 'org.views.write', array['organization', 'personal'], false, p_default_text => 'comfortable', p_choices => array['comfortable', 'compact']);
select private.define_setting('numbering.record_key_format', 'Text', 'org.numbering.write', array['organization'], false, p_default_text => '{PROJECT}-{SEQ}', p_max_length => 40);
select private.define_setting('numbering.document_number_padding', 'Integer', 'org.numbering.write', array['organization'], false, p_default_integer => 4, p_min_integer => 1, p_max_integer => 10);
select private.define_setting('time.rounding_minutes', 'Choice', 'org.time_attendance.write', array['organization', 'workspace', 'project'], true, p_default_text => '0', p_choices => array['0', '5', '6', '15']);
select private.define_setting('time.photo_on_punch', 'Boolean', 'org.time_attendance.write', array['organization', 'workspace', 'project'], true, p_default_boolean => false);
select private.define_setting('time.geofence_required', 'Boolean', 'org.time_attendance.write', array['organization', 'workspace', 'project'], true, p_default_boolean => true);
select private.define_setting('time.kiosk_enabled', 'Boolean', 'org.time_attendance.write', array['organization', 'workspace'], false, p_default_boolean => false);
select private.define_setting('scheduling.open_shift_claiming', 'Choice', 'org.scheduling.write', array['organization', 'workspace', 'project'], true, p_default_text => 'approval', p_choices => array['first-come', 'approval', 'seniority']);
select private.define_setting('scheduling.allow_swaps', 'Boolean', 'org.scheduling.write', array['organization', 'workspace', 'project'], false, p_default_boolean => true);
select private.define_setting('scheduling.swap_requires_approval', 'Boolean', 'org.scheduling.write', array['organization', 'workspace', 'project'], true, p_default_boolean => true);
select private.define_setting('payroll.pay_period', 'Choice', 'org.payroll.write', array['organization'], false, p_default_text => 'biweekly', p_choices => array['weekly', 'biweekly', 'semimonthly', 'monthly']);
select private.define_setting('payroll.week_start', 'Choice', 'org.payroll.write', array['organization', 'personal'], true, p_default_text => 'sunday', p_choices => array['sunday', 'monday']);
select private.define_setting('gateway.marketplace_visibility', 'Choice', 'org.gateway.write', array['organization'], false, p_default_text => 'network', p_choices => array['public', 'network', 'private']);
select private.define_setting('gateway.ratings_enabled', 'Boolean', 'org.gateway.write', array['organization'], false, p_default_boolean => true);
select private.define_setting('communication.message_retention_days', 'Integer', 'org.communication.write', array['organization'], false, p_default_integer => 730, p_min_integer => 30, p_max_integer => 3650);
select private.define_setting('communication.auto_translate', 'Boolean', 'org.communication.write', array['organization', 'personal'], false, p_default_boolean => false);
select private.define_setting('help.support_email', 'Text', 'org.help.write', array['organization'], false, p_max_length => 320);
select private.define_setting('help.support_hours', 'Text', 'org.help.write', array['organization'], false, p_max_length => 200);
select private.define_setting('help.custom_link', 'Text', 'org.help.write', array['organization'], false, p_max_length => 500);
select private.define_setting('locale.language', 'Choice', 'org.localization.write', array['organization', 'personal'], true, p_default_text => 'en-US', p_choices => array['en-US', 'es-US']);
select private.define_setting('locale.time_zone', 'Text', 'org.localization.write', array['organization', 'workspace', 'project', 'personal'], true, p_default_text => 'UTC', p_max_length => 64);
select private.define_setting('locale.date_format', 'Choice', 'org.localization.write', array['organization', 'personal'], false, p_default_text => 'locale', p_choices => array['locale', 'iso']);
select private.define_setting('locale.units', 'Choice', 'org.localization.write', array['organization', 'personal'], false, p_default_text => 'imperial', p_choices => array['imperial', 'metric']);
select private.define_setting('me.theme', 'Choice', 'me.preferences.write', array['personal'], false, p_default_text => 'system', p_choices => array['system', 'light', 'dark']);
select private.define_setting('me.persona', 'Choice', 'me.preferences.write', array['personal'], false, p_choices => array['org-owner', 'org-admin', 'producer', 'department-head', 'finance-lead', 'production-coordinator', 'field-supervisor', 'field-employee']);
select private.define_setting('me.text_size', 'Choice', 'me.preferences.write', array['personal'], false, p_default_text => 'default', p_choices => array['default', 'large', 'larger']);
select private.define_setting('me.high_contrast', 'Boolean', 'me.preferences.write', array['personal'], false, p_default_boolean => false);
select private.define_setting('me.reduced_motion', 'Choice', 'me.preferences.write', array['personal'], false, p_default_text => 'system', p_choices => array['system', 'reduce', 'full']);
select private.define_setting('me.haptics', 'Boolean', 'me.preferences.write', array['personal'], false, p_default_boolean => true);
select private.define_setting('me.sounds', 'Boolean', 'me.preferences.write', array['personal'], false, p_default_boolean => true);
select private.define_setting('me.captions', 'Boolean', 'me.preferences.write', array['personal'], false, p_default_boolean => false);
select private.define_setting('me.out_of_office.enabled', 'Boolean', 'me.out_of_office.write', array['personal'], false, p_default_boolean => false);
select private.define_setting('me.out_of_office.starts_on', 'Text', 'me.out_of_office.write', array['personal'], false, p_max_length => 10);
select private.define_setting('me.out_of_office.ends_on', 'Text', 'me.out_of_office.write', array['personal'], false, p_max_length => 10);
select private.define_setting('me.out_of_office.auto_reply', 'Text', 'me.out_of_office.write', array['personal'], false, p_max_length => 1000);
select private.define_setting('me.shortcuts_enabled', 'Boolean', 'me.preferences.write', array['personal'], false, p_default_boolean => true);
