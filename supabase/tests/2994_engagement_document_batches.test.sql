-- pgTAP: migration 2994 (B10, G-130). Batches with per-entry refusals, sending and the frozen body, signing with the hash of
-- the text on the one path that may, every other signing path refused, declining, countersigning with its separation of
-- duties and the Automatic verification, and masking of a body that holds a rate in every read and the audit trail.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.refusal(p_sql text) returns text
language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when sqlstate 'XR001' then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end $$;
grant execute on function pg_temp.refusal(text) to public;

create function pg_temp.entry(p_engagement text, p_title text default 'Crew Agreement', p_body text default 'You work the show.') returns jsonb
language sql stable as $$ select jsonb_build_object('engagement_id', pg_temp.id(p_engagement), 'title', p_title, 'body', p_body) $$;
grant execute on function pg_temp.entry(text, text, text) to public;

create function pg_temp.doc(p_batch jsonb, p_engagement text) returns uuid
language sql stable as $$
  select (r ->> 'engagement_document_id')::uuid from jsonb_array_elements(p_batch -> 'results') r where r ->> 'engagement_id' = pg_temp.id(p_engagement)::text
$$;
grant execute on function pg_temp.doc(jsonb, text) to public;

create function pg_temp.code(p_batch jsonb, p_engagement text) returns text
language sql stable as $$
  select r ->> 'code' from jsonb_array_elements(p_batch -> 'results') r where r ->> 'engagement_id' = pg_temp.id(p_engagement)::text
$$;
grant execute on function pg_temp.code(jsonb, text) to public;

create temporary table b (key text primary key, value jsonb);
grant select, insert on b to public;
create function pg_temp.bv(p_key text) returns jsonb language sql stable as $$ select value from b where key = p_key $$;
grant execute on function pg_temp.bv(text) to public;

select pg_temp.new_user('liam', 'liam@freelance.test', 'Liam Porter');
select pg_temp.new_user('rae', 'rae@freelance.test', 'Rae Sandoval');
select pg_temp.new_user('ned', 'ned@freelance.test', 'Ned Vargas');

-- Requirements first, so the new engagements get their items.
select pg_temp.as_user('alice');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method, role_type) values (pg_temp.id('org_a'), 'Crew Agreement Signed', 'Electronic Signature', 'Automatic', 'Crew') returning id) insert into world select 'req_auto', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method, is_blocking) values (pg_temp.id('org_a'), 'NDA Signed', 'Electronic Signature', 'Reviewer', false) returning id) insert into world select 'req_rev', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method) values (pg_temp.id('org_a'), 'Uniform Form', 'Form', 'Reviewer') returning id) insert into world select 'req_form', id from r;
update app.onboarding_requirements set is_blocking = false where id = pg_temp.id('req_form');

create function pg_temp.engage(p_key text, p_person text) returns void
language plpgsql as $$
declare
  v uuid;
begin
  insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, agreed_rate_minor, currency_code, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id(p_person), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 99000, 'USD', '2027-06-01') returning id into v;
  insert into world values (p_key, v);
end $$;
grant execute on function pg_temp.engage(text, text) to public;
select pg_temp.engage('eng_liam', 'liam');
select pg_temp.engage('eng_rae', 'rae');
select pg_temp.engage('eng_quinn', 'quinn');

select pg_temp.engage('eng_carol', 'carol');
select pg_temp.engage('eng_ned', 'ned');

with t as (insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template)
  values (pg_temp.id('org_a'), 'Crew Agreement', 'Agreement', 'Agreement for {{party.name}}', 'You earn {{engagement.rate}}.') returning id) insert into world select 'tmpl_rate', id from t;
with t as (insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template)
  values (pg_temp.id('org_a'), 'Plain NDA', 'Non-Disclosure Agreement', 'NDA for {{party.name}}', 'Keep it quiet.') returning id) insert into world select 'tmpl_plain', id from t;

-- Creating ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.create_engagement_document_batch('%s', '%s', '[{}]')$$, pg_temp.id('prj_a'), pg_temp.id('tmpl_plain')), '42501', null, 'creating needs opportunities.engagement.write on the project');
select pg_temp.as_user('alice');
select is(pg_temp.refusal(format($$select app.create_engagement_document_batch('%s', '%s', '[]')$$, pg_temp.id('prj_a'), pg_temp.id('tmpl_plain'))), 'document_batch_size', 'an empty batch is refused');
select is(pg_temp.refusal(format($$select app.create_engagement_document_batch('%s', '%s', '[{}]', '%s')$$, pg_temp.id('prj_a'), pg_temp.id('tmpl_plain'), pg_temp.id('req_form'))), 'document_batch_requirement', 'the requirement must be an Electronic Signature');

insert into b values ('main', app.create_engagement_document_batch(pg_temp.id('prj_a'), pg_temp.id('tmpl_plain'), jsonb_build_array(
  pg_temp.entry('eng_liam'), pg_temp.entry('eng_rae'), pg_temp.entry('eng_vendor_a'), pg_temp.entry('eng_ivy_a', 'Left {{party.name}}'), pg_temp.entry('eng_art_a')),
  pg_temp.id('req_auto')));
insert into world select 'batch', (pg_temp.bv('main') ->> 'batch_id')::uuid;
insert into world select 'doc_liam', pg_temp.doc(pg_temp.bv('main'), 'eng_liam');
insert into world select 'doc_rae', pg_temp.doc(pg_temp.bv('main'), 'eng_rae');
select ok(pg_temp.id('doc_liam') is not null and pg_temp.id('doc_rae') is not null, 'valid entries create documents');
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc_liam')), 'Proposed', 'Proposed');
select is(pg_temp.code(pg_temp.bv('main'), 'eng_vendor_a'), 'document_batch_person', 'a company engagement is refused without failing the batch');
select is(pg_temp.code(pg_temp.bv('main'), 'eng_ivy_a'), 'document_merge_unresolved', 'text still holding a merge field is refused');
select is(pg_temp.code(pg_temp.bv('main'), 'eng_art_a'), 'document_batch_no_item', 'an engagement with no item for the requirement is refused');
insert into b values ('dup', app.create_engagement_document_batch(pg_temp.id('prj_a'), pg_temp.id('tmpl_plain'), jsonb_build_array(pg_temp.entry('eng_liam'))));
select is(pg_temp.code(pg_temp.bv('dup'), 'eng_liam'), 'document_batch_duplicate', 'a second live document from the template is refused');
select is(pg_temp.bv('dup') ->> 'batch_id', null, 'a call whose every entry is refused has no batch');

-- A call that creates nothing does not fix a template's wording.
with t as (insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template)
  values (pg_temp.id('org_a'), 'Unused', 'Agreement', 'T', 'B') returning id) insert into world select 'tmpl_unused', id from t;
insert into b values ('none', app.create_engagement_document_batch(pg_temp.id('prj_a'), pg_temp.id('tmpl_unused'), jsonb_build_array(pg_temp.entry('eng_vendor_a'))));
select is(pg_temp.code(pg_temp.bv('none'), 'eng_vendor_a'), 'document_batch_person', 'the refused entry says why');
select is((select count(*)::int from app.engagement_document_batches x where x.engagement_document_template_id = pg_temp.id('tmpl_unused')), 0, 'and no batch row stays');
select lives_ok(format($$update app.engagement_document_templates set body_template = 'Changed.' where id = '%s'$$, pg_temp.id('tmpl_unused')), 'so the template stays editable');

-- The merge asks whether the caller reads the project's shifts: a reader is answered, and someone else is not.
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['crew.shift.read']), array['crew.shift.read'], 'crew.shift.read is answered on the project');
select pg_temp.as_user('xavier');
select is(app.my_capabilities_on_project(pg_temp.id('prj_a'), array['crew.shift.read']), '{}'::text[], 'and not for someone without it there');
select pg_temp.as_user('alice');
select pg_temp.as_platform();
select pg_temp.as_user('carol');

-- A finished engagement takes no new document.
select pg_temp.move_engagement('eng_ivy_b', 'Onboarding', 'Canceled');
select pg_temp.as_user('xavier');
with t as (insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template)
  values (pg_temp.id('org_b'), 'B', 'Agreement', 'T', 'B') returning id) insert into world select 'tmpl_b', id from t;
insert into b values ('finished', app.create_engagement_document_batch(pg_temp.id('prj_b'), pg_temp.id('tmpl_b'), jsonb_build_array(pg_temp.entry('eng_ivy_b'))));
select is(pg_temp.code(pg_temp.bv('finished'), 'eng_ivy_b'), 'document_batch_person', 'a finished engagement is refused');

-- Rates need payroll: a Manager holds engagement write but not payroll.
select pg_temp.as_user('carol');
insert into b values ('restricted', app.create_engagement_document_batch(pg_temp.id('prj_a'), pg_temp.id('tmpl_rate'), jsonb_build_array(pg_temp.entry('eng_rae', 'T', 'B'))));
select is(pg_temp.code(pg_temp.bv('restricted'), 'eng_rae'), 'document_merge_rate_restricted', 'a rate template is refused without org-wide payroll');

-- Sending and freezing -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.send_engagement_document_batch('%s')$$, pg_temp.id('batch')), '42501', null, 'sending needs engagement write');
select pg_temp.as_platform();
update app.engagement_document_texts set body = 'Edited before sending.' where engagement_document_id = pg_temp.id('doc_rae');
select pg_temp.as_user('alice');
select is(app.send_engagement_document_batch(pg_temp.id('batch')), 2, 'sending moves Proposed to Sent');
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc_liam')), 'Sent', 'Sent');
select pg_temp.as_platform();
select ok(exists (select 1 from app.notifications n where n.recipient_person_id = pg_temp.id('liam') and n.kind = 'engagement_document.sent'), 'the engaged person is told');
select is(pg_temp.refusal(format($$update app.engagement_document_texts set body = 'Changed.' where engagement_document_id = '%s'$$, pg_temp.id('doc_rae'))), 'document_text_signed', 'the body cannot change from the first send');
select private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state', 'app.engagement_document_state_transitions', 'engagement_document_id', pg_temp.id('doc_rae'), 'Sent', 'Proposed', 'Fixture.');
select is(pg_temp.refusal(format($$update app.engagement_document_texts set body = 'Changed.' where engagement_document_id = '%s'$$, pg_temp.id('doc_rae'))), 'document_text_signed', 'even after Sent goes back to Proposed');
select pg_temp.as_user('alice');
select is(app.send_engagement_document_batch(pg_temp.id('batch')), 1, 'sending again sends what went back');

-- Other signing paths are refused --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('rae');
select is(pg_temp.refusal(format($$select app.sign_engagement_document('%s')$$, pg_temp.id('doc_rae'))), 'document_text_sign_with_hash', 'app.sign_engagement_document refuses a text document');
select is(app.bulk_update_my_engagement_documents(jsonb_build_array(jsonb_build_object('id', pg_temp.id('doc_rae'), 'set', jsonb_build_object('engagement_document_state', 'Signed')))) -> 'refused' -> 0 ->> 'rule',
  'document_text_sign_with_hash', 'Gateway bulk signing reports it');
select pg_temp.as_user('alice');
select is(pg_temp.refusal(format($$select * from app.issue_engagement_document_token('%s', 'rae@freelance.test')$$, pg_temp.id('doc_rae'))), 'document_text_sign_with_hash', 'a signing link for a text document is refused when issued');
-- A token issued before the document had a text still cannot sign.
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_quinn'), 'Agreement', 'Token doc') returning id) insert into world select 'doc_tok', id from d;
select app.transition_engagement_document(pg_temp.id('doc_tok'), 'Proposed', 'Sent', 'Sent for signature.');
create temporary table tok (token text, code text);
grant select, insert on tok to public;
insert into tok select t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc_tok'), 'quinn@freelance.test') t;
select pg_temp.as_platform();
insert into app.engagement_document_texts (engagement_document_id, engagement_document_batch_id, body) values (pg_temp.id('doc_tok'), pg_temp.id('batch'), 'Added later.');
select pg_temp.as_anon();
select is(pg_temp.refusal($$select * from api_public.token_sign_document((select token from tok), (select code from tok), 'Quinn Ashby')$$), 'document_text_sign_with_hash', 'the signing link refuses a text document');

-- Signing ------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('liam');
select is((select x.body_sha256 from api_external.engagement_document_texts x where x.id = pg_temp.id('doc_liam')), encode(extensions.digest('You work the show.', 'sha256'), 'hex'), 'the party reads the hash of the text');
select is(pg_temp.refusal(format($$select app.sign_engagement_document_text('%s', 'Liam Porter', 'deadbeef')$$, pg_temp.id('doc_liam'))), 'document_text_hash', 'a wrong hash is refused');
select is(pg_temp.refusal(format($$select app.sign_engagement_document_text('%s', '  ', '%s')$$, pg_temp.id('doc_liam'), encode(extensions.digest('You work the show.', 'sha256'), 'hex'))), 'document_signer_name', 'a signature needs a name');
select lives_ok(format($$select app.sign_engagement_document_text('%s', 'Liam Porter', '%s')$$, pg_temp.id('doc_liam'), encode(extensions.digest('You work the show.', 'sha256'), 'hex')), 'the right hash signs');
select pg_temp.as_platform();
select results_eq(format($$select signed_name, signed_body_sha256 from app.engagement_document_texts where engagement_document_id = '%s'$$, pg_temp.id('doc_liam')),
  $$values ('Liam Porter'::text, encode(extensions.digest('You work the show.', 'sha256'), 'hex'))$$, 'the name and hash are recorded');
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc_liam')), 'Signed', 'and the document is Signed');
select ok((select i.submitted_at is not null from app.onboarding_items i where i.engagement_id = pg_temp.id('eng_liam') and i.onboarding_requirement_id = pg_temp.id('req_auto')), 'the linked onboarding item is submitted');
select is(pg_temp.refusal(format($$update app.engagement_document_texts set body = 'Changed.' where engagement_document_id = '%s'$$, pg_temp.id('doc_liam'))), 'document_text_signed', 'a signed text never changes');
select is((select count(*)::int from app.audit_events a where a.subject_table = 'app.engagement_document_texts' and (a.diff::text like '%You work the show%' or a.diff ? 'body' or a.diff ? 'signed_body_sha256'
    or a.diff::text like '%signed_body_sha256%')), 0, 'the audit diff holds neither the body nor the hash');

-- Declining ------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.decline_engagement_document('%s', 'No.')$$, pg_temp.id('doc_rae')), '42501', null, 'someone outside the documents area gets 42501');
select pg_temp.as_user('rae');
select is(pg_temp.refusal(format($$select app.decline_engagement_document('%s', '  ')$$, pg_temp.id('doc_rae'))), 'document_decline_reason', 'an empty reason is refused');
select is(pg_temp.refusal(format($$select app.decline_engagement_document('%s', repeat('x', 451))$$, pg_temp.id('doc_rae'))), 'document_decline_reason', 'a reason over 450 characters is refused');
select app.decline_engagement_document(pg_temp.id('doc_rae'), 'The dates do not work.');
select pg_temp.as_platform();
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc_rae')), 'Canceled', 'declining moves Sent to Canceled');
select is((select t.reason from app.engagement_document_state_transitions t where t.engagement_document_id = pg_temp.id('doc_rae') and t.to_state = 'Canceled'), 'Declined by the party: The dates do not work.', 'with the reason in the ledger');
select is((select count(*)::int from app.domain_events e where e.event_type = 'engagement_document.declined' and e.data ? 'reason'), 0, 'and not in the event');

-- Countersigning ---------------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.onboarding_verifications v join app.onboarding_items i on i.id = v.onboarding_item_id where i.engagement_id = pg_temp.id('eng_liam')), 0, 'no verification before the countersignature');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.countersign_engagement_document_batch('%s')$$, pg_temp.id('batch')), '42501', null, 'countersigning needs engagement write');
select pg_temp.as_user('alice');
select is(app.countersign_engagement_document_batch(pg_temp.id('batch')), '{"executed": 1, "refused": []}'::jsonb, 'countersigning moves Signed to Executed');
select pg_temp.as_platform();
select results_eq(format($$select v.outcome::text, v.verified_by from app.onboarding_verifications v join app.onboarding_items i on i.id = v.onboarding_item_id where i.engagement_id = '%s' and i.onboarding_requirement_id = '%s'$$, pg_temp.id('eng_liam'), pg_temp.id('req_auto')),
  $$values ('Passed'::text, null::uuid)$$, 'an Automatic requirement gets a Passed verification with no reviewer');
select ok(private.requirement_satisfied(pg_temp.id('eng_liam'), pg_temp.id('req_auto')), 'the requirement is satisfied');
select lives_ok($$select pg_temp.move_engagement('eng_liam', 'Onboarding', 'Active')$$, 'so a blocking requirement satisfied this way lets the engagement become Active');
select private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state', 'app.engagement_document_state_transitions', 'engagement_document_id', pg_temp.id('doc_liam'), 'Executed', 'Superseded', 'Fixture.');
select is((select count(*)::int from app.onboarding_verifications v join app.onboarding_items i on i.id = v.onboarding_item_id where i.engagement_id = pg_temp.id('eng_liam')), 1, 'Superseded after Executed writes nothing');

-- The engaged person with engagement write cannot countersign their own Automatic item.
select pg_temp.as_user('alice');
insert into b values ('self', app.create_engagement_document_batch(pg_temp.id('prj_a'), pg_temp.id('tmpl_plain'), jsonb_build_array(pg_temp.entry('eng_carol'), pg_temp.entry('eng_ned')), pg_temp.id('req_auto')));
insert into world select 'batch_self', (pg_temp.bv('self') ->> 'batch_id')::uuid;
insert into world select 'doc_carol', pg_temp.doc(pg_temp.bv('self'), 'eng_carol');
insert into world select 'doc_ned', pg_temp.doc(pg_temp.bv('self'), 'eng_ned');
select app.send_engagement_document_batch(pg_temp.id('batch_self'));
select pg_temp.as_user('carol');
select app.sign_engagement_document_text(pg_temp.id('doc_carol'), 'Carol Nguyen', encode(extensions.digest('You work the show.', 'sha256'), 'hex'));
select pg_temp.as_user('ned');
select app.sign_engagement_document_text(pg_temp.id('doc_ned'), 'Ned Vargas', encode(extensions.digest('You work the show.', 'sha256'), 'hex'));
select pg_temp.as_user('carol');
select is(app.countersign_engagement_document_batch(pg_temp.id('batch_self')),
  jsonb_build_object('executed', 1, 'refused', jsonb_build_array(jsonb_build_object('id', pg_temp.id('doc_carol'), 'code', 'sod_onboarding_self_verify'))),
  'countersigning one''s own Automatic item is refused and the rest of the batch runs');
select is(pg_temp.refusal(format($$select app.transition_engagement_document('%s', 'Signed', 'Executed', 'Mine.')$$, pg_temp.id('doc_carol'))), 'sod_onboarding_self_verify', 'and app.transition_engagement_document too');

-- A Reviewer requirement stays unverified.
select pg_temp.as_user('alice');
with t as (insert into app.engagement_document_templates (org_id, name, document_kind, title_template, body_template) values (pg_temp.id('org_a'), 'Plain SOW', 'Statement of Work', 'SOW', 'Scope.') returning id) insert into world select 'tmpl_sow', id from t;
insert into b values ('rev', app.create_engagement_document_batch(pg_temp.id('prj_a'), pg_temp.id('tmpl_sow'), jsonb_build_array(pg_temp.entry('eng_rae')), pg_temp.id('req_rev')));
insert into world select 'batch_rev', (pg_temp.bv('rev') ->> 'batch_id')::uuid;
insert into world select 'doc_rev', pg_temp.doc(pg_temp.bv('rev'), 'eng_rae');
select app.send_engagement_document_batch(pg_temp.id('batch_rev'));
select pg_temp.as_user('rae');
select app.sign_engagement_document_text(pg_temp.id('doc_rev'), 'Rae Sandoval', encode(extensions.digest('You work the show.', 'sha256'), 'hex'));
select pg_temp.as_user('alice');
select app.countersign_engagement_document_batch(pg_temp.id('batch_rev'));
select pg_temp.as_platform();
select is((select count(*)::int from app.onboarding_verifications v join app.onboarding_items i on i.id = v.onboarding_item_id where i.engagement_id = pg_temp.id('eng_rae') and i.onboarding_requirement_id = pg_temp.id('req_rev')), 0, 'a Reviewer requirement stays unverified');

-- Masking ----------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into b values ('rate', app.create_engagement_document_batch(pg_temp.id('prj_a'), pg_temp.id('tmpl_rate'), jsonb_build_array(pg_temp.entry('eng_rae', 'Agreement', 'You earn $990.00.'), pg_temp.entry('eng_art_a', 'Artist agreement', 'You earn $5,000.00.'))));
insert into world select 'batch_rate', (pg_temp.bv('rate') ->> 'batch_id')::uuid;
insert into world select 'doc_rate', pg_temp.doc(pg_temp.bv('rate'), 'eng_rae');
insert into world select 'doc_art', pg_temp.doc(pg_temp.bv('rate'), 'eng_art_a');
select app.send_engagement_document_batch(pg_temp.id('batch_rate'));
select pg_temp.as_user('rae');
select app.sign_engagement_document_text(pg_temp.id('doc_rate'), 'Rae Sandoval', encode(extensions.digest('You earn $990.00.', 'sha256'), 'hex'));

select pg_temp.as_user('alice');
select results_eq(format($$select body, body_masked, body_sha256 is not null, signed_body_sha256 is not null from app.engagement_document_text_list where engagement_document_id = '%s'$$, pg_temp.id('doc_rate')),
  $$values ('You earn $990.00.'::text, false, true, true)$$, 'a payroll reader gets the body and both hashes');
select pg_temp.as_user('dave');
select results_eq(format($$select body, body_masked, body_sha256, signed_body_sha256 from app.engagement_document_text_list where engagement_document_id = '%s'$$, pg_temp.id('doc_rate')),
  $$values (null::text, true, null::text, null::text)$$, 'a reader without payroll gets neither the body nor a hash');
select throws_ok($$select body from app.engagement_document_texts$$, '42501', null, 'and cannot select the body');
select throws_ok($$select signed_body_sha256 from app.engagement_document_texts$$, '42501', null, 'or the signed hash');
select results_eq(format($$select body, body_masked from app.engagement_document_text_list where engagement_document_id = '%s'$$, pg_temp.id('doc_liam')),
  $$values ('You work the show.'::text, false)$$, 'a body that uses no rate field reads for any engagement reader');
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', 'app.engagement_document_text_list', 'select'), 'xos_backup cannot select the view');

-- A Documents-only representative reads a mask and cannot answer; Settlement scope opens it.
select pg_temp.as_user('art');
select is((select x.body from api_external.engagement_document_texts x where x.id = pg_temp.id('doc_art')), 'You earn $5,000.00.', 'the engaged person reads their own text');
select pg_temp.as_user('rita');
select results_eq(format($$select body, body_sha256, body_masked from api_external.engagement_document_texts where id = '%s'$$, pg_temp.id('doc_art')),
  $$values (null::text, null::text, true)$$, 'a Documents-only representative reads it masked');
select is(pg_temp.refusal(format($$select app.sign_engagement_document_text('%s', 'Rita Alvarez', 'x')$$, pg_temp.id('doc_art'))), 'document_text_masked', 'and cannot sign');
select is(pg_temp.refusal(format($$select app.decline_engagement_document('%s', 'No.')$$, pg_temp.id('doc_art'))), 'document_text_masked', 'or decline');
select pg_temp.as_platform();
insert into app.representation_scopes (representation_id, scope) values (pg_temp.id('rep_art'), 'Settlement');
select pg_temp.as_user('rita');
select is((select x.body from api_external.engagement_document_texts x where x.id = pg_temp.id('doc_art')), 'You earn $5,000.00.', 'Settlement scope reads the text');

-- The party reads while the documents area is open only.
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.engagement_document_texts x where x.id = pg_temp.id('doc_art')), 0, 'someone else reads nothing');

select pg_temp.as_user('ned');
select is((select count(*)::int from api_external.engagement_document_texts x where x.id = pg_temp.id('doc_ned')), 1, 'the party reads their own text while the documents area is open');
select pg_temp.move_engagement('eng_ned', 'Onboarding', 'Canceled');
select pg_temp.backdate_close('eng_ned', interval '19 months');
select pg_temp.as_user('ned');
select is((select count(*)::int from api_external.engagement_document_texts x where x.id = pg_temp.id('doc_ned')), 0, 'and not after it closes');

select * from finish();
rollback;
