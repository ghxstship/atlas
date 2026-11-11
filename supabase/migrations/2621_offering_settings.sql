-- 2621_offering_settings.sql
-- R3 Org and project offerings (RRR-181, owner decision 7). The nine offerings.* settings of
-- packages/schemas/settings/r3.yaml, pasted from `pnpm --filter @xos/schemas settings:sql r3`: a choice of not-offered,
-- provided, reimbursed or buyout, Not Offered by default, set for the org (lockable) or a project, edited with
-- projects.settings.write. private.effective_offerings (2622) reads them.

select private.define_setting('offerings.travel', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.lodging', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.catering', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.parking', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.uniforms', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.per_diem', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.radios', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.carts', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
select private.define_setting('offerings.guest_list', 'Choice', 'projects.settings.write', array['organization', 'project'], true, p_default_text => 'not-offered', p_choices => array['not-offered', 'provided', 'reimbursed', 'buyout']);
