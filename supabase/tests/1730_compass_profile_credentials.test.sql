-- pgTAP: migration 1730, the Compass Profile's certifications and documents (A109, RRR-154, Section 4.3 item 13). Each
-- view returns only the caller's own rows: the certifications the expiry job reminds them of (1463), with a carried
-- profile entry shown as its org record and a renewed record hiding the old one; their signed engagement documents,
-- the certificates of insurance of an account they answer for, and their passport's expiry without its number. Another
-- person, the org that recorded the rows, and an unrelated org read nothing. A document's clean Public or Internal file
-- opens through the attachments storage policy for the caller alone, and members keep the access they had.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(36);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- A clean file attached to a subject by an org member; kept in k as <key> (version id, object name).
create function pg_temp.clean_file(p_user text, p_key text, p_subject_table text, p_subject_id uuid, p_attachment uuid default null)
returns uuid
language plpgsql as $$
declare
  v_attachment uuid;
  v_version uuid;
  v_object text;
begin
  perform pg_temp.as_user(p_user);
  select u.attachment_id, u.attachment_version_id, u.object_name into v_attachment, v_version, v_object
  from app.begin_attachment_upload(p_subject_table, p_subject_id, p_key || '.pdf', 'application/pdf', 1200, p_attachment) u;
  insert into storage.objects (bucket_id, name, metadata) values ('attachments', v_object, '{"size": 1200}');
  perform app.complete_attachment_upload(v_version, repeat('ab', 32));
  perform pg_temp.as_platform();
  perform app.record_attachment_scan(v_version, true);
  insert into k values (p_key, v_version, v_object);
  insert into k values (p_key || ':attachment', v_attachment, null);
  return v_version;
end $$;

-- Rows the caller can read in storage for a kept file.
create function pg_temp.can_open(p_who text, p_key text) returns integer
language sql as $$
  select pg_temp.n(p_who, format($q$select 1 from storage.objects where bucket_id = 'attachments' and name = %L$q$,
    (select val from k where key = p_key)));
$$;

create function pg_temp.sign(p_document uuid, p_to text) returns void
language plpgsql as $$
begin
  perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', p_document, 'Proposed', 'Sent', 'Sent.');
  if p_to = 'Signed' then
    perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
      'app.engagement_document_state_transitions', 'engagement_document_id', p_document, 'Sent', 'Signed', 'Signed.');
  end if;
end $$;

select pg_temp.as_user('ivy');
select app.set_personal_setting('locale.time_zone', null, 'Pacific/Pago_Pago');
select pg_temp.as_platform();
-- Signed-in callers have no USAGE on private, so each calendar is read once here.
select private.org_today(pg_temp.id('org_a')) as a_today, private.org_today(pg_temp.id('org_b')) as b_today,
  private.org_time_zone(pg_temp.id('org_a')) as a_zone, private.person_today(pg_temp.id('ivy')) as ivy_today \gset

-- Certifications ------------------------------------------------------------------------------------------------------------

insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Forklift Operator', 'OSHA') returning id as v_fork \gset
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Aerial Lift', 'IPAF') returning id as v_lift \gset
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_b'), 'Pier Safety', 'Harbor Board') returning id as v_pier \gset
insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
values (:'v_fork', pg_temp.id('ivy'), pg_temp.id('carol'), '2025-01-01', (:'a_today'::date) + 7)
returning id as v_fork_holder \gset
insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
values (:'v_lift', pg_temp.id('ivy'), pg_temp.id('carol'), '2025-01-01', (:'a_today'::date) + 2)
returning id as v_lift_old \gset
insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
values (:'v_lift', pg_temp.id('ivy'), pg_temp.id('carol'), '2026-01-01', (:'a_today'::date) + 400)
returning id as v_lift_new \gset
insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
values (:'v_pier', pg_temp.id('quinn'), pg_temp.id('xavier'), '2025-01-01', (:'b_today'::date) + 10);

select pg_temp.as_user('ivy');
insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on)
values (pg_temp.id('ivy'), 'CPR', 'Red Cross', '2026-01-01', (:'ivy_today'::date) + 20) returning id as v_cpr \gset
insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on)
values (pg_temp.id('ivy'), 'cpr ', 'Red Cross', '2025-01-01', (:'ivy_today'::date) + 5);
select app.carry_certification_to_profile(:'v_fork_holder') as v_carried \gset
select pg_temp.as_user('quinn');
insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on)
values (pg_temp.id('quinn'), 'Scaffold Inspector', 'CISRS', '2026-01-01', null);
select pg_temp.as_platform();

select pg_temp.as_user('ivy');
select results_eq($$select name, source, is_verified, verified_by_org_name, expires_on from api_external.my_profile_certifications order by name$$,
  format($$values ('Aerial Lift'::text, 'Org Record'::text, true, 'Northwind Live'::text, %L::date),
    ('CPR', 'Profile', false, null, %L::date), ('Forklift Operator', 'Org Record', true, 'Northwind Live', %L::date)$$,
    (:'a_today'::date) + 400, (:'ivy_today'::date) + 20, (:'a_today'::date) + 7),
  'ivy reads her org records and her own entry: the renewed Aerial Lift, the newer CPR, Forklift once as its record');
select is((select time_zone from api_external.my_profile_certifications where id = :'v_fork_holder'),
  (:'a_zone'), 'an org record counts its days on the org''s calendar');
select is((select time_zone from api_external.my_profile_certifications where id = :'v_cpr'), 'Pacific/Pago_Pago',
  'a profile entry counts them on the person''s own calendar');
select is((select count(*)::int from api_external.my_profile_certifications where person_id <> pg_temp.id('ivy')), 0,
  'every row is hers');
select pg_temp.as_platform();

select is(pg_temp.n('quinn', 'select 1 from api_external.my_profile_certifications'), 2, 'quinn reads his own two');
select is(pg_temp.n('quinn', format($$select 1 from api_external.my_profile_certifications where person_id = %L$$, pg_temp.id('ivy'))), 0,
  'another person reads none of ivy''s');
select is(pg_temp.n('alice', 'select 1 from api_external.my_profile_certifications'), 0,
  'the org that recorded her certifications reads none of them here');
select is(pg_temp.n('cora', 'select 1 from api_external.my_profile_certifications'), 0, 'an unrelated org reads nothing');
select is(pg_temp.n('nina', 'select 1 from api_external.my_profile_certifications'), 0, 'a person with no certifications reads nothing');

update app.certification_holders set deleted_at = now() where id = :'v_fork_holder';
select pg_temp.as_user('ivy');
select results_eq($$select source, is_verified, verified_by_org_name from api_external.my_profile_certifications where name = 'Forklift Operator'$$,
  $$values ('Profile'::text, true, 'Northwind Live'::text)$$,
  'once the org record is gone, the carried entry shows with the org''s verification');
select is((select count(*)::int from api_external.my_profile_certifications where id = :'v_carried'), 1, 'as the profile entry itself');
select pg_temp.as_platform();

-- Documents -------------------------------------------------------------------------------------------------------------------

-- ivy: a signed agreement with org_a, with a file; a document still out for signature; a signed one with org_b whose file
-- is Confidential. quinn: a signed agreement with org_b.
select pg_temp.as_user('alice');
insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Crew Agreement') returning id as v_doc_a \gset
select pg_temp.as_user('xavier');
insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_b'), pg_temp.id('prj_b'), 'Pier Agreement') returning id as v_doc_b \gset
select pg_temp.as_platform();
select pg_temp.clean_file('alice', 'crew_agreement', 'app.documents', :'v_doc_a');
select pg_temp.clean_file('xavier', 'pier_agreement', 'app.documents', :'v_doc_b');
update app.attachments set classification = 'Confidential' where id = (select id from k where key = 'pier_agreement:attachment');

insert into app.engagement_documents (engagement_id, document_kind, title, document_id, expires_on)
values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Crew Agreement', :'v_doc_a', (:'a_today'::date) + 30) returning id as v_ed_a \gset
insert into app.engagement_documents (engagement_id, document_kind, title)
values (pg_temp.id('eng_ivy_a'), 'Rider', 'Crew Rider') returning id as v_ed_sent \gset
insert into app.engagement_documents (engagement_id, document_kind, title, document_id)
values (pg_temp.id('eng_ivy_b'), 'Agreement', 'Pier Agreement', :'v_doc_b') returning id as v_ed_b \gset
insert into app.engagement_documents (engagement_id, document_kind, title)
values (pg_temp.id('eng_quinn_b'), 'Agreement', 'Quinn Agreement') returning id as v_ed_q \gset
select pg_temp.sign(:'v_ed_a', 'Signed');
select pg_temp.sign(:'v_ed_sent', 'Sent');
select pg_temp.sign(:'v_ed_b', 'Signed');
select pg_temp.sign(:'v_ed_q', 'Signed');

-- ivy's passport.
select pg_temp.as_user('ivy');
select app.ensure_my_work_details() as v_wd \gset
select app.set_my_passport_number('X1234567');
update app.person_work_details set passport_issuing_country = 'US', passport_expires_on = (:'ivy_today'::date) + 60
where id = :'v_wd';
select pg_temp.as_platform();

-- Bayside Audio's compliance on file with org_a: a General Liability certificate replaced by a later one, and a Workers
-- Compensation certificate with a file.
select pg_temp.as_user('alice');
with v as (insert into app.vendors (counterparty_id, payment_terms_days) values (pg_temp.id('cp_v_a'), 30) returning id) insert into k select 'ven', id, null from v;
insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, valid_from, valid_to)
values ((select id from k where key = 'ven'), 'Fictional Mutual', 'GL-1001', 'General Liability', current_date - 300, (:'a_today'::date) + 10);
insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, valid_from, valid_to)
values ((select id from k where key = 'ven'), 'Fictional Mutual', 'GL-1002', 'General Liability', current_date, (:'a_today'::date) + 375);
insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, valid_from, valid_to)
values ((select id from k where key = 'ven'), 'Example Casualty', 'WC-2001', 'Workers Compensation', current_date - 30, (:'a_today'::date) + 20)
returning id as v_coi_wc \gset
select pg_temp.as_platform();
select pg_temp.clean_file('alice', 'coi_wc', 'app.insurance_certificates', :'v_coi_wc');

select pg_temp.as_user('ivy');
select results_eq($$select document_type, coalesce(title, ''), coalesce(org_name, ''), coalesce(document_state, ''), coalesce(issuer, '')
  from api_external.my_profile_documents order by document_type, title$$,
  $$values ('Engagement Document'::text, 'Crew Agreement'::text, 'Northwind Live'::text, 'Signed'::text, ''::text),
    ('Engagement Document', 'Pier Agreement', 'Harbor Lights Productions', 'Signed', ''),
    ('Passport', '', '', '', 'US')$$,
  'ivy reads her signed documents with both orgs and her passport; not the one still out for signature, not quinn''s');
select results_eq($$select file_version_id, file_classification, file_name from api_external.my_profile_documents where id = $$ || quote_literal(:'v_ed_a'),
  format($$values (%L::uuid, 'Internal'::text, 'crew_agreement.pdf'::text)$$, (select id from k where key = 'crew_agreement')),
  'the signed agreement names its clean Internal file');
select is((select file_version_id from api_external.my_profile_documents where id = :'v_ed_b'), null,
  'a Confidential file is not named: no external party may download it');
select is((select expires_on from api_external.my_profile_documents where document_type = 'Passport'),
  (:'ivy_today'::date) + 60, 'the passport shows its expiry');
select is((select time_zone from api_external.my_profile_documents where document_type = 'Passport'), 'Pacific/Pago_Pago',
  'on her own calendar');
select is((select time_zone from api_external.my_profile_documents where id = :'v_ed_a'), (:'a_zone'),
  'and an engagement document on the org''s');
select pg_temp.as_platform();
select is_empty($$
  select c.table_name || '.' || c.column_name from information_schema.columns c
  where c.table_schema = 'api_external' and c.table_name in ('my_profile_documents', 'my_profile_certifications')
    and (c.column_name like '%passport%' or c.column_name like '%last4%' or c.column_name like 'credential_number%'
      or c.column_name like 'policy%')
$$, 'neither view carries the passport number, its last four, a certificate number or a policy number');

select is(pg_temp.n('quinn', 'select 1 from api_external.my_profile_documents'), 1, 'quinn reads only his own agreement');
select is(pg_temp.n('quinn', format($$select 1 from api_external.my_profile_documents where id in (%L, %L, %L)$$, :'v_ed_a', :'v_ed_b', :'v_wd')), 0,
  'another person reads none of ivy''s documents or her passport');
select is(pg_temp.n('xavier', format($$select 1 from api_external.my_profile_documents where id = %L$$, :'v_ed_b')), 0,
  'the org that engaged her reads none of them here');
select is(pg_temp.n('cora', 'select 1 from api_external.my_profile_documents'), 0, 'an unrelated org reads nothing');

select pg_temp.as_user('victor');
select results_eq($$select title, issuer, expires_on from api_external.my_profile_documents
  where document_type = 'Insurance Certificate' order by title$$,
  format($$values ('General Liability'::text, 'Fictional Mutual'::text, %L::date), ('Workers Compensation', 'Example Casualty', %L::date)$$,
    (:'a_today'::date) + 375, (:'a_today'::date) + 20),
  'the account''s Owner reads its certificates of insurance with insurer and last day, the replaced General Liability one hidden');
select pg_temp.as_platform();
select is(pg_temp.n('fiona', $$select 1 from api_external.my_profile_documents where document_type = 'Insurance Certificate'$$), 2,
  'so does Account Finance');
select is(pg_temp.n('sam', $$select 1 from api_external.my_profile_documents where document_type = 'Insurance Certificate'$$), 0,
  'the supplied technician does not');
select is(pg_temp.n('ivy', $$select 1 from api_external.my_profile_documents where document_type = 'Insurance Certificate'$$), 0,
  'nor another party');

-- Opening a file -----------------------------------------------------------------------------------------------------------------

select is(pg_temp.can_open('ivy', 'crew_agreement'), 1, 'ivy can read her signed agreement''s file, so a signed URL opens it');
select is(pg_temp.can_open('quinn', 'crew_agreement'), 0, 'another person cannot');
select is(pg_temp.can_open('ivy', 'pier_agreement'), 0, 'nor can she read the Confidential file');
select is(pg_temp.can_open('victor', 'coi_wc'), 1, 'the account''s Owner can read the certificate''s file');
select is(pg_temp.can_open('sam', 'coi_wc'), 0, 'the supplied technician cannot');
select is(pg_temp.can_open('alice', 'crew_agreement'), 1, 'a member keeps reading the org''s own file');

-- A newer file replaces the older one: only the newest opens.
select pg_temp.clean_file('alice', 'crew_agreement_v2', 'app.documents', :'v_doc_a', (select id from k where key = 'crew_agreement:attachment'));
select pg_temp.as_user('ivy');
select is((select file_version_id from api_external.my_profile_documents where id = :'v_ed_a'), (select id from k where key = 'crew_agreement_v2'),
  'the agreement names its newest file');
select pg_temp.as_platform();
select is(pg_temp.can_open('ivy', 'crew_agreement'), 0, 'and the older file no longer opens for her');

-- A canceled engagement's documents leave the profile, as they leave the reminders.
select pg_temp.move_engagement('eng_ivy_b', 'Onboarding', 'Canceled');
select is(pg_temp.n('ivy', format($$select 1 from api_external.my_profile_documents where id = %L$$, :'v_ed_b')), 0,
  'a canceled engagement''s agreement is not listed');

select pg_temp.as_anon();
select throws_ok('select 1 from api_external.my_profile_documents', '42501', null, 'anon cannot read the documents');
select pg_temp.as_platform();

select * from finish();
rollback;
