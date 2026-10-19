-- pgTAP: the form builder, versioned publishing, conditional fields, photos, GPS, signatures, scoring, records
-- and approval routing (A29, Section 4.9 Forms).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(36);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Templates -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$insert into app.form_templates (org_id, name, record_kind, record_subtype, fields)
  values (pg_temp.id('org_a'), 'Field form', 'Inspection', 'Safety', '[{"key": "ok", "label": "OK?", "kind": "yes_no"}]')$$,
  '42501', null, 'a field member cannot build forms');

select pg_temp.as_user('carol');
select lives_ok($$with t as (insert into app.form_templates (org_id, name, description, record_kind, record_subtype, fields,
  requires_signature, requires_location, pass_score, approver_role_id)
  values (pg_temp.id('org_a'), 'Rigging pre-use check', 'Before every lift.', 'Inspection', 'Safety', '[
    {"key": "hoist_ok", "label": "Hoist inspected", "kind": "yes_no", "required": true, "points": {"true": 2}},
    {"key": "defect", "label": "Defect found", "kind": "long_text", "required": true, "show_if": {"key": "hoist_ok", "equals": false}},
    {"key": "load", "label": "Load class", "kind": "choice", "choices": ["Light", "Medium", "Heavy"], "points": {"Light": 1, "Medium": 1, "Heavy": 0}},
    {"key": "photos", "label": "Photos of the hoist", "kind": "photo", "required": true}
  ]', true, true, 2, pg_temp.system_role('manager')) returning id) insert into k select 'tpl', id from t$$,
  'a manager drafts a form with a condition, scoring, photos, GPS, signature and an approver role');
select throws_ok($$insert into app.form_templates (org_id, name, record_kind, fields)
  values (pg_temp.id('org_a'), 'Bad form', 'Task', '[{"key": "b", "label": "B", "kind": "text", "show_if": {"key": "a", "equals": "x"}}]')$$,
  'XR001', null, 'a condition may only depend on an earlier field');
select throws_ok($$insert into app.form_templates (org_id, name, record_kind, fields)
  values (pg_temp.id('org_a'), 'Bad kind', 'Task', '[{"key": "a", "label": "A", "kind": "slider"}]')$$, 'XR001', null, 'field kinds are a closed list');
select throws_ok($$insert into app.form_templates (org_id, name, record_kind, record_subtype, fields)
  values (pg_temp.id('org_a'), 'Bad subtype', 'Inspection', 'Catering', '[{"key": "a", "label": "A", "kind": "text"}]')$$,
  '23503', null, 'the record kind and subtype come from canon');
select lives_ok($$with t as (insert into app.form_templates (org_id, name, record_kind, fields)
  values (pg_temp.id('org_a'), 'Shift handover', 'Document', '[{"key": "notes", "label": "Notes", "kind": "text", "required": true}]') returning id)
  insert into k select 'handover', id from t$$, 'a form with no approver role');

select pg_temp.as_user('frank');
select is((select count(*)::integer from app.form_templates where org_id = pg_temp.id('org_a')), 0, 'drafts are hidden from members');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{}'::jsonb)$$, '42501', null, 'nobody submits a draft they cannot see');

select pg_temp.as_user('dave');
select is(app.publish_form_template((select id from k where key = 'tpl')), 1, 'publishing numbers version 1');
select app.publish_form_template((select id from k where key = 'handover'));
select throws_ok($$update app.form_templates set fields = '[{"key": "x", "label": "X", "kind": "text"}]' where id = (select id from k where key = 'tpl')$$,
  'XR001', null, 'a published form keeps its fields');
select throws_ok($$update app.form_templates set current_version = 5 where id = (select id from k where key = 'tpl')$$, 'XR001', null,
  'versions come only from publishing');

-- Submitting ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::integer from app.form_templates where org_id = pg_temp.id('org_a')), 2, 'members read published forms');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": true, "photos": ["org/forms/a.jpg"]}'::jsonb, pg_temp.id('prj_a'))$$,
  'XR001', null, 'a GPS stamp is required');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": true}'::jsonb, pg_temp.id('prj_a'),
  '{"latitude": 25.77, "longitude": -80.19}', '{"signer_name": "Frank Adeyemi", "signature_path": "org/sig/f.png"}')$$,
  'XR001', null, 'a required photo field needs a photo');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": false, "photos": ["org/forms/a.jpg"]}'::jsonb, pg_temp.id('prj_a'),
  '{"latitude": 25.77, "longitude": -80.19}', '{"signer_name": "Frank Adeyemi", "signature_path": "org/sig/f.png"}')$$,
  'XR001', null, 'a field shown by its condition becomes required');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": true, "defect": "None", "photos": ["org/forms/a.jpg"]}'::jsonb, pg_temp.id('prj_a'),
  '{"latitude": 25.77, "longitude": -80.19}', '{"signer_name": "Frank Adeyemi", "signature_path": "org/sig/f.png"}')$$,
  'XR001', null, 'a hidden field must stay empty');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": true, "load": "Huge", "photos": ["org/forms/a.jpg"]}'::jsonb, pg_temp.id('prj_a'),
  '{"latitude": 25.77, "longitude": -80.19}', '{"signer_name": "Frank Adeyemi", "signature_path": "org/sig/f.png"}')$$,
  'XR001', null, 'a choice must be listed');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": true, "photos": ["org/forms/a.jpg"]}'::jsonb, pg_temp.id('prj_a'),
  '{"latitude": 25.77, "longitude": -80.19}')$$, 'XR001', null, 'a signature is required');
select lives_ok($$insert into k select 'sub', app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": true, "load": "Medium", "photos": ["org/forms/a.jpg"]}'::jsonb,
  pg_temp.id('prj_a'), '{"latitude": 25.77, "longitude": -80.19, "accuracy_m": 8}', '{"signer_name": "Frank Adeyemi", "signature_path": "org/sig/f.png"}')$$,
  'a complete submission is accepted');
select is((select score::text || '/' || max_score::text || ' ' || passed::text || ' ' || submission_state::text from app.form_submissions where id = (select id from k where key = 'sub')),
  '3/3 true Submitted', 'it is scored against the pass score and waits for approval');
select pg_temp.as_platform();
select is((select r.record_kind || ' ' || r.record_subtype from app.records r join app.form_submissions s on s.record_id = r.id where s.id = (select id from k where key = 'sub')),
  'Inspection Safety', 'the project submission became a record of the form''s kind and subtype');
select pg_temp.as_user('frank');
select throws_ok($$insert into app.form_submissions (form_template_id, form_template_version_id, submitted_by_membership_id, answers)
  values ((select id from k where key = 'tpl'), (select id from app.form_template_versions limit 1), pg_temp.id('frank@org_a'), '{}')$$,
  '42501', null, 'submissions are written only through the RPC');
select lives_ok($$insert into k select 'hand', app.submit_form((select id from k where key = 'handover'), '{"notes": "Stage left clear."}'::jsonb)$$,
  'an org submission with no project');
select is((select submission_state::text || ' ' || (record_id is null)::text from app.form_submissions where id = (select id from k where key = 'hand')),
  'Recorded true', 'a form with no approver is recorded at once and makes no record without a project');

-- Reading and approval -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.form_submissions), 0, 'others read no submissions');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.form_submissions where org_id = pg_temp.id('org_a')), 0, 'no cross-tenant submission reads');
select pg_temp.as_anon();
select throws_ok($$select count(*) from app.form_submissions$$, '42501', null, 'anon reads no submissions');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.form_submissions where form_template_id = (select id from k where key = 'tpl')), 1,
  'a holder of the approver role reads the submissions it approves');
select throws_ok($$select app.decide_form_submission((select id from k where key = 'sub'), false)$$, 'XR001', null, 'a rejection needs a note');
select lives_ok($$select app.decide_form_submission((select id from k where key = 'sub'), true, 'Good to lift.')$$, 'the approver approves');
select throws_ok($$select app.decide_form_submission((select id from k where key = 'sub'), true)$$, 'XR001', 'form_submission_state_conflict: The form submission is not in the expected state Submitted.', 'a decision is final');
select is((select count(*)::integer from app.form_submission_state_transitions where form_submission_id = (select id from k where key = 'sub')), 2,
  'the ledger records submission and approval');

-- The submitter never approves their own submission.
select pg_temp.as_user('carol');
insert into k select 'own', app.submit_form((select id from k where key = 'tpl'), '{"hoist_ok": true, "photos": ["org/forms/b.jpg"]}'::jsonb, null,
  '{"latitude": 25.77, "longitude": -80.19}', '{"signer_name": "Carol Nguyen", "signature_path": "org/sig/c.png"}');
select throws_ok($$select app.decide_form_submission((select id from k where key = 'own'), true)$$, 'XR001',
  'sod_form_submitter: The person who submitted a form cannot approve or reject it.', 'nobody approves their own submission');
select pg_temp.as_user('dave');
select app.retire_form_template((select id from k where key = 'tpl'), 'Replaced by the 2027 check.');
select throws_ok($$select app.retire_form_template((select id from k where key = 'tpl'), 'Again.')$$,
  'XR001', 'form_template_state_conflict: The form template is not in the expected state Published.', 'a retired form is not retired again');
select pg_temp.as_user('frank');
select throws_ok($$select app.submit_form((select id from k where key = 'tpl'), '{}'::jsonb)$$, 'XR001', null, 'a retired form takes no submissions');

select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where org_id = pg_temp.id('org_a')
  and event_type in ('form_template.published', 'form_submission.submitted', 'form_submission.decided')), 6,
  'forms emit their domain events: 2 published, 3 submitted and 1 decided');

select * from finish();
rollback;
